// Login, logout e "quem sou eu" do painel.
import {
  adminFromRequest,
  attempts,
  checkNewPassword,
  clearAttempts,
  createSession,
  decoyHash,
  destroySession,
  hashPassword,
  readCookie,
  recordAttempt,
  sessionCookie,
  sha256,
  verifyPassword,
  COOKIE,
} from '../auth.js';
import { one, query } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Admin, Router } from '../http.js';

const WINDOW = 15 * 60;

export function registerSession(r: Router) {
  r.post('/api/auth/login', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 4 * 1024);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password || email.length > 254 || password.length > 200) throw new HttpError(400, 'Informe o e-mail e a senha.');

    if ((await attempts('login-email', email, WINDOW)) >= 8 || (await attempts('login-ip', ctx.ip, WINDOW)) >= 30) {
      throw new HttpError(429, 'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.');
    }

    const row = await one<Admin & { password_hash: string; active: boolean }>(
      'select id, name, email, role, active, password_hash from admins where lower(email) = $1',
      [email],
    );
    const valid = await verifyPassword(password, row?.password_hash ?? (await decoyHash()));
    if (!row || !valid || !row.active) {
      await Promise.all([recordAttempt('login-email', email), recordAttempt('login-ip', ctx.ip)]);
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }

    await clearAttempts('login-email', email);
    await query('update admins set last_login_at = now() where id = $1', [row.id]);
    const { token, maxAge } = await createSession(row.id);
    const admin: Admin = { id: row.id, name: row.name, email: row.email, role: row.role };
    return json({ admin }, 200, { 'set-cookie': sessionCookie(ctx.req, token, maxAge) });
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
    const next = checkNewPassword(body.next);
    const row = await one<{ password_hash: string }>('select password_hash from admins where id = $1', [ctx.admin!.id]);
    if (!row || !(await verifyPassword(current, row.password_hash))) throw new HttpError(400, 'A senha atual está incorreta.');
    await query('update admins set password_hash = $1 where id = $2', [await hashPassword(next), ctx.admin!.id]);
    // Encerra as outras sessões desta conta (outros aparelhos); a atual continua.
    const token = readCookie(ctx.req, COOKIE);
    if (token) await query('delete from admin_sessions where admin_id = $1 and token_hash <> $2', [ctx.admin!.id, sha256(token)]);
    return json({ ok: true });
  });
}
