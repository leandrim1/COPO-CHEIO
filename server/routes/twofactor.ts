// Verificação em duas etapas (TOTP) do painel: cada administrador liga e desliga a sua. Tudo exige a senha da conta e/ou um código
// válido, para que quem só roubou uma sessão aberta não consiga desligar nem trocar a proteção.
import { audit } from '../audit.js';
import { refund, reserve, verifyPassword } from '../auth.js';
import { batch, one, query } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Ctx, Router } from '../http.js';
import { cleanRecoveryCode, cleanTotp, matchTotpStep, newRecoveryCodes, newTotpSecret, otpauthUri, recoveryHash } from '../totp.js';
import { loadStoreName } from '../storeName.js';

const WINDOW = 15 * 60;

type Row = { password_hash: string; totp_secret: string | null; totp_enabled_at: string | null };

async function myRow(ctx: Ctx): Promise<Row> {
  const row = await one<Row>('select password_hash, totp_secret, totp_enabled_at from admins where id = $1', [ctx.admin!.id]);
  if (!row) throw new HttpError(401, 'Faça login para continuar.');
  return row;
}

async function confirmPassword(ctx: Ctx, row: Row, password: unknown): Promise<void> {
  await reserve('admin-2fa', ctx.admin!.id, WINDOW, 10, 'Muitas tentativas. Aguarde alguns minutos.');
  if (typeof password !== 'string' || !password || !(await verifyPassword(password, row.password_hash))) throw new HttpError(400, 'A senha está incorreta.');
  await refund('admin-2fa', ctx.admin!.id);
}

// Aceita o código do aplicativo ou um código de recuperação (que é gasto). O mesmo código do aplicativo não vale duas vezes.
async function confirmCode(ctx: Ctx, row: Row, code: unknown, { allowRecovery }: { allowRecovery: boolean }): Promise<'totp' | 'recovery'> {
  await reserve('admin-2fa', ctx.admin!.id, WINDOW, 10, 'Muitas tentativas. Aguarde alguns minutos.');
  const totp = cleanTotp(code);
  const recovery = allowRecovery ? cleanRecoveryCode(code) : null;
  if (totp && row.totp_secret) {
    const step = matchTotpStep(row.totp_secret, totp);
    if (step !== null && (await one('update admins set totp_last_step = $2 where id = $1 and (totp_last_step is null or totp_last_step < $2) returning id', [ctx.admin!.id, step]))) {
      await refund('admin-2fa', ctx.admin!.id);
      return 'totp';
    }
  } else if (recovery) {
    if (await one('update admin_recovery_codes set used_at = now() where admin_id = $1 and code_hash = $2 and used_at is null returning id', [ctx.admin!.id, recoveryHash(recovery)])) {
      await refund('admin-2fa', ctx.admin!.id);
      return 'recovery';
    }
  }
  throw new HttpError(400, 'Código incorreto. Confira o aplicativo e tente de novo.', { code: 'invalid_code' });
}

async function replaceRecoveryCodes(adminId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await batch([
    ['delete from admin_recovery_codes where admin_id = $1', [adminId]],
    ...codes.map((code): [string, unknown[]] => ['insert into admin_recovery_codes (admin_id, code_hash) values ($1, $2)', [adminId, recoveryHash(cleanRecoveryCode(code)!)]]),
  ]);
  return codes;
}

export function registerTwoFactor(r: Router) {
  r.get('/api/auth/2fa', 'admin', async (ctx) => {
    const row = await myRow(ctx);
    const left = (await one<{ n: number }>('select count(*) as n from admin_recovery_codes where admin_id = $1 and used_at is null', [ctx.admin!.id]))?.n ?? 0;
    return json({ enabled: Boolean(row.totp_enabled_at), pending: Boolean(row.totp_secret && !row.totp_enabled_at), recovery_codes_left: row.totp_enabled_at ? left : 0 });
  });

  // 1) Gera a chave (ainda desligada). Mostra a chave e o endereço otpauth, que o painel transforma em QR code.
  r.post('/api/auth/2fa/setup', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const row = await myRow(ctx);
    if (row.totp_enabled_at) throw new HttpError(409, 'A verificação em duas etapas já está ativa. Desative antes de configurar de novo.');
    await confirmPassword(ctx, row, body.password);
    const secret = newTotpSecret();
    await query('update admins set totp_secret = $2, totp_enabled_at = null, totp_last_step = null where id = $1', [ctx.admin!.id, secret]);
    const issuer = await loadStoreName();
    return json({ secret, otpauth: otpauthUri(secret, ctx.admin!.email, issuer) });
  });

  // 2) Confirma com o primeiro código do aplicativo, liga e entrega os códigos de recuperação (só aparecem agora).
  r.post('/api/auth/2fa/enable', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const row = await myRow(ctx);
    if (row.totp_enabled_at) throw new HttpError(409, 'A verificação em duas etapas já está ativa.');
    if (!row.totp_secret) throw new HttpError(400, 'Comece pela configuração: gere a chave primeiro.', { code: 'not_started' });
    await confirmCode(ctx, row, body.code, { allowRecovery: false });
    await query('update admins set totp_enabled_at = now() where id = $1 and totp_secret is not null', [ctx.admin!.id]);
    const codes = await replaceRecoveryCodes(ctx.admin!.id);
    await audit(ctx, { action: 'auth.2fa_enable', summary: 'Ativou a verificação em duas etapas', entity: 'admin', entityId: ctx.admin!.id });
    return json({ enabled: true, recovery_codes: codes });
  });

  r.post('/api/auth/2fa/disable', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const row = await myRow(ctx);
    if (!row.totp_enabled_at) throw new HttpError(409, 'A verificação em duas etapas não está ativa.');
    await confirmPassword(ctx, row, body.password);
    await confirmCode(ctx, row, body.code, { allowRecovery: true });
    await batch([
      ['update admins set totp_secret = null, totp_enabled_at = null, totp_last_step = null where id = $1', [ctx.admin!.id]],
      ['delete from admin_recovery_codes where admin_id = $1', [ctx.admin!.id]],
    ]);
    await audit(ctx, { action: 'auth.2fa_disable', summary: 'Desativou a verificação em duas etapas', entity: 'admin', entityId: ctx.admin!.id });
    return json({ enabled: false });
  });

  // Gera códigos de recuperação novos (os antigos deixam de valer). Exige a senha e um código do aplicativo.
  r.post('/api/auth/2fa/recovery-codes', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const row = await myRow(ctx);
    if (!row.totp_enabled_at) throw new HttpError(409, 'A verificação em duas etapas não está ativa.');
    await confirmPassword(ctx, row, body.password);
    await confirmCode(ctx, row, body.code, { allowRecovery: false });
    const codes = await replaceRecoveryCodes(ctx.admin!.id);
    await audit(ctx, { action: 'auth.2fa_recovery_codes', summary: 'Gerou novos códigos de recuperação', entity: 'admin', entityId: ctx.admin!.id });
    return json({ recovery_codes: codes });
  });
}
