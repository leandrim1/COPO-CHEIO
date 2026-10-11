// Login, logout e "quem sou eu" do painel.
//
// Fluxo do login:
//  1. e-mail + senha. Cada tentativa é RESERVADA no banco antes de conferir a senha (contador atômico), então tentativas simultâneas
//     não furam o limite. Se a conta tem verificação em duas etapas, a resposta é { two_factor: true, challenge } e ainda não há sessão;
//  2. código de 6 dígitos do aplicativo (ou um código de recuperação) em /api/auth/login/2fa, que só aceita o desafio recém-criado.
import { randomBytes } from 'node:crypto';
import { audit } from '../audit.js';
import { finishAdminLogin, knownDevice } from '../adminAccess.js';
import {
  adminFromRequest,
  checkNewPassword,
  DEVICE_COOKIE,
  decoyHash,
  destroySession,
  hashPassword,
  readCookie,
  refund,
  reserve,
  sessionCookie,
  sha256,
  verifyPassword,
  COOKIE,
} from '../auth.js';
import { one, query } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Admin, Router } from '../http.js';
import { cleanRecoveryCode, cleanTotp, matchTotpStep, recoveryHash } from '../totp.js';

const WINDOW = 15 * 60;
const CHALLENGE_MINUTES = 5;
const MAX_CODE_TRIES = 5;
const TOO_MANY = 'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.';

type LoginRow = Admin & { password_hash: string; active: boolean; totp_enabled_at: string | null; device_known: boolean };

export function registerSession(r: Router) {
  r.post('/api/auth/login', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 4 * 1024);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password || email.length > 254 || password.length > 200) throw new HttpError(400, 'Informe o e-mail e a senha.');

    // Limites reservados ANTES de conferir a senha:
    //  • por e-mail + rede (8 em 15 min): quem erra a senha de longe só trava a si mesmo, nunca o dono da conta;
    //  • por rede (30 em 15 min): uma rede testando muitas contas;
    //  • por e-mail, para aparelhos que a conta não conhece (40 em 1 h): proteção contra um ataque vindo de muitas redes ao mesmo tempo.
    await reserve('login-pair', `${email}|${ctx.ip}`, WINDOW, 8, TOO_MANY);
    await reserve('login-ip', ctx.ip, WINDOW, 30, TOO_MANY);

    const deviceToken = readCookie(ctx.req, DEVICE_COOKIE);
    const row = await one<LoginRow>(
      `select a.id, a.name, a.email, a.role, a.active, a.password_hash, a.totp_enabled_at,
              exists (select 1 from admin_devices d where d.admin_id = a.id and d.token_hash = $2) as device_known
         from admins a where lower(a.email) = $1`,
      [email, deviceToken && deviceToken.length <= 100 ? sha256(deviceToken) : ''],
    );
    const known = Boolean(row?.device_known);
    if (!known) await reserve('login-email', email, 3600, 40, TOO_MANY);

    const valid = await verifyPassword(password, row?.password_hash ?? (await decoyHash()));
    if (!row || !valid || !row.active) throw new HttpError(401, 'E-mail ou senha incorretos.');

    // Senha certa: a tentativa não conta como erro.
    await Promise.all([refund('login-pair', `${email}|${ctx.ip}`), refund('login-ip', ctx.ip), known ? undefined : refund('login-email', email)]);

    const admin: Admin = { id: row.id, name: row.name, email: row.email, role: row.role, two_factor: Boolean(row.totp_enabled_at) };
    if (row.totp_enabled_at) {
      const challenge = randomBytes(32).toString('base64url');
      await query(`delete from admin_login_challenges where admin_id = $1 and (expires_at < now() or attempts >= $2)`, [row.id, MAX_CODE_TRIES]);
      await query(`insert into admin_login_challenges (token_hash, admin_id, expires_at) values ($1, $2, now() + make_interval(mins => $3))`, [sha256(challenge), row.id, CHALLENGE_MINUTES]);
      return json({ two_factor: true, challenge, expires_in: CHALLENGE_MINUTES * 60 });
    }
    return finishAdminLogin(ctx, admin, { deviceKnown: known, method: 'password' });
  });

  // Segunda etapa: o desafio de /login + o código de 6 dígitos do aplicativo (ou um código de recuperação).
  r.post('/api/auth/login/2fa', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 4 * 1024);
    const challenge = typeof body.challenge === 'string' && body.challenge.length <= 100 ? body.challenge : '';
    const totp = cleanTotp(body.code);
    const recovery = cleanRecoveryCode(body.code);
    if (!challenge) throw new HttpError(400, 'Entre de novo com e-mail e senha.', { code: 'challenge_expired' });
    if (!totp && !recovery) throw new HttpError(400, 'Digite os 6 dígitos do aplicativo (ou um código de recuperação).', { code: 'invalid_code_format' });
    await reserve('login-2fa-ip', ctx.ip, WINDOW, 30, TOO_MANY);

    // Cada tentativa gasta uma das 5 do desafio, de forma atômica; passou disso, o desafio morre e é preciso digitar a senha de novo.
    const ch = await one<{ admin_id: string; attempts: number }>(
      `update admin_login_challenges set attempts = attempts + 1
        where token_hash = $1 and expires_at > now() and attempts < $2
        returning admin_id, attempts`,
      [sha256(challenge), MAX_CODE_TRIES],
    );
    if (!ch) throw new HttpError(401, 'A verificação expirou. Informe o e-mail e a senha de novo.', { code: 'challenge_expired' });

    const admin = await one<Admin & { active: boolean; totp_secret: string | null; totp_enabled_at: string | null }>(
      'select id, name, email, role, active, totp_secret, totp_enabled_at from admins where id = $1',
      [ch.admin_id],
    );
    if (!admin || !admin.active || !admin.totp_secret || !admin.totp_enabled_at) {
      throw new HttpError(401, 'A verificação expirou. Informe o e-mail e a senha de novo.', { code: 'challenge_expired' });
    }

    let method: 'totp' | 'recovery' | null = null;
    if (totp) {
      const step = matchTotpStep(admin.totp_secret, totp);
      // O mesmo código de 30 s só vale uma vez (a conferência e a marcação acontecem juntas, no banco).
      if (step !== null && (await one('update admins set totp_last_step = $2 where id = $1 and (totp_last_step is null or totp_last_step < $2) returning id', [admin.id, step]))) method = 'totp';
    } else if (recovery) {
      if (await one('update admin_recovery_codes set used_at = now() where admin_id = $1 and code_hash = $2 and used_at is null returning id', [admin.id, recoveryHash(recovery)])) method = 'recovery';
    }
    if (!method) {
      throw new HttpError(401, 'Código incorreto. Confira o aplicativo e tente de novo.', { code: 'invalid_code', attempts_left: Math.max(0, MAX_CODE_TRIES - ch.attempts) });
    }

    await query('delete from admin_login_challenges where admin_id = $1', [admin.id]);
    await refund('login-2fa-ip', ctx.ip);
    let recoveryLeft: number | undefined;
    if (method === 'recovery') {
      recoveryLeft = (await one<{ n: number }>('select count(*) as n from admin_recovery_codes where admin_id = $1 and used_at is null', [admin.id]))?.n ?? 0;
    }
    return finishAdminLogin(ctx, { ...admin, two_factor: true }, { deviceKnown: await knownDevice(ctx.req, admin.id), method, recoveryLeft });
  });

  r.post('/api/auth/logout', 'public', async (ctx) => {
    await destroySession(ctx.req);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(ctx.req, '', 0) });
  });

  // Sem login responde { admin: null } (não é erro): é como o painel descobre se precisa pedir a senha.
  r.get('/api/auth/me', 'public', async (ctx) => json({ admin: await adminFromRequest(ctx.req) }));

  r.patch('/api/auth/password', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 4 * 1024);
    const current = typeof body.current === 'string' ? body.current : '';
    const next = checkNewPassword(body.next, { kind: 'admin', email: ctx.admin!.email, name: ctx.admin!.name });
    // Quem roubou uma sessão aberta não pode ficar adivinhando a senha atual por aqui.
    await reserve('admin-password', ctx.admin!.id, WINDOW, 8, 'Muitas tentativas. Aguarde alguns minutos.');
    const row = await one<{ password_hash: string }>('select password_hash from admins where id = $1', [ctx.admin!.id]);
    if (!row || !(await verifyPassword(current, row.password_hash))) throw new HttpError(400, 'A senha atual está incorreta.');
    await refund('admin-password', ctx.admin!.id);
    await query('update admins set password_hash = $1 where id = $2', [await hashPassword(next), ctx.admin!.id]);
    // Encerra as outras sessões desta conta (outros aparelhos); a atual continua.
    const token = readCookie(ctx.req, COOKIE);
    if (token) await query('delete from admin_sessions where admin_id = $1 and token_hash <> $2', [ctx.admin!.id, sha256(token)]);
    await audit(ctx, { action: 'auth.password_change', summary: 'Trocou a própria senha', entity: 'admin', entityId: ctx.admin!.id });
    return json({ ok: true });
  });
}
