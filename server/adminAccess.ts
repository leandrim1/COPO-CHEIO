// Entrada no painel depois que a pessoa provou quem é (senha e, se a conta tiver, o código de 6 dígitos).
//
// • Abre a sessão (cookie HttpOnly) e reconhece o aparelho por um cookie próprio (só o hash fica no banco).
// • Aparelho que a conta ainda não conhecia: grava e manda um aviso para o e-mail da conta ("Novo acesso ao painel").
// • Registra a entrada no histórico de atividades.
import { randomBytes } from 'node:crypto';
import { audit } from './audit.js';
import { DEVICE_COOKIE, createSession, deviceCookie, readCookie, sessionCookie, sha256 } from './auth.js';
import { one, query } from './db.js';
import { json } from './http.js';
import type { Admin, Ctx } from './http.js';
import { deliver } from './email/service.js';
import { mailConfigured } from './mail.js';

const MAX_DEVICES = 20;
const NOTICE_TIMEOUT_MS = 4000;

// "Chrome no Windows": o suficiente para a pessoa reconhecer o aparelho no aviso (não é um fingerprint).
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg(?:e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /CrOS/.test(ua)
            ? 'Chrome OS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  if (browser && os) return `${browser} no ${os}`;
  return browser ?? os ?? 'Navegador não identificado';
}

// O aparelho que fez esta requisição já é conhecido por este administrador?
export async function knownDevice(req: Request, adminId: string): Promise<boolean> {
  const token = readCookie(req, DEVICE_COOKIE);
  if (!token || token.length > 100) return false;
  const row = await one('select 1 as ok from admin_devices where admin_id = $1 and token_hash = $2', [adminId, sha256(token)]);
  return Boolean(row);
}

async function notifyNewDevice(ctx: Pick<Ctx, 'req' | 'ip'>, admin: Admin, device: string): Promise<void> {
  if (!mailConfigured()) return;
  const send = async () => {
    try {
      await deliver({ kind: 'admin_new_login', to: admin.email, spec: { name: admin.name, at: new Date().toISOString(), device, ip: ctx.ip }, req: ctx.req });
    } catch {
      console.error('[painel] o aviso de novo acesso não foi enviado');
    }
  };
  // O aviso não pode travar a entrada de quem está logando: espera pouco e segue.
  await Promise.race([send(), new Promise<void>((resolve) => setTimeout(resolve, NOTICE_TIMEOUT_MS))]);
}

export async function finishAdminLogin(ctx: Pick<Ctx, 'req' | 'ip'>, admin: Admin, opts: { deviceKnown: boolean; method?: 'password' | 'totp' | 'recovery'; recoveryLeft?: number }): Promise<Response> {
  const { token, maxAge } = await createSession(admin.id);
  await query('update admins set last_login_at = now() where id = $1', [admin.id]);
  const cookies = [sessionCookie(ctx.req, token, maxAge)];
  const device = describeDevice(ctx.req.headers.get('user-agent'));

  let isNewDevice = false;
  if (opts.deviceKnown) {
    const current = readCookie(ctx.req, DEVICE_COOKIE);
    if (current) await query('update admin_devices set last_seen_at = now() where admin_id = $1 and token_hash = $2', [admin.id, sha256(current)]);
  } else {
    const fresh = randomBytes(32).toString('base64url');
    const before = await one<{ n: number }>('select count(*) as n from admin_devices where admin_id = $1', [admin.id]);
    await query('insert into admin_devices (admin_id, token_hash, label) values ($1, $2, $3)', [admin.id, sha256(fresh), device]);
    await query(
      `delete from admin_devices where admin_id = $1 and id not in (select id from admin_devices where admin_id = $1 order by last_seen_at desc limit ${MAX_DEVICES})`,
      [admin.id],
    );
    cookies.push(deviceCookie(ctx.req, fresh));
    // A primeira entrada de todas não é "aparelho novo": não há nada com que comparar.
    isNewDevice = (before?.n ?? 0) > 0;
  }

  const how = opts.method === 'recovery' ? ' com um código de recuperação' : opts.method === 'totp' ? ' com verificação em duas etapas' : '';
  await audit(
    { admin, ip: ctx.ip },
    {
      action: isNewDevice ? 'auth.login_new_device' : 'auth.login',
      summary: isNewDevice ? `Entrou no painel de um aparelho novo (${device})${how}` : `Entrou no painel (${device})${how}`,
      entity: 'admin',
      entityId: admin.id,
      details: { device },
    },
  );
  if (isNewDevice) await notifyNewDevice(ctx, admin, device);

  return json(
    { admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role, two_factor: Boolean(admin.two_factor) }, ...(opts.recoveryLeft !== undefined ? { recovery_codes_left: opts.recoveryLeft } : {}) },
    200,
    { 'set-cookie': cookies },
  );
}
