// API do COPO CHEIO: um único handler (Request → Response) para todas as rotas /api/*.
// Roda como função da Vercel (api/index.ts) e também no servidor de desenvolvimento do Vite.
import { adminFromRequest } from './auth.js';
import { blobConfigured, databaseUrl, MissingConfig } from './env.js';
import { HttpError, Router, json } from './http.js';
import type { Access, Ctx } from './http.js';
import { registerAccount } from './routes/account.js';
import { registerCatalog } from './routes/catalog.js';
import { registerContent } from './routes/content.js';
import { registerOrders } from './routes/orders.js';
import { registerPublic } from './routes/public.js';
import { registerSession } from './routes/session.js';
import { registerCustomers } from './routes/customers.js';
import { registerTeam } from './routes/team.js';
import { registerTracking } from './routes/tracking.js';
import { registerUpload } from './routes/upload.js';
import { one } from './db.js';

const router = new Router();

// Sem banco ou sem Blob configurados, diz exatamente qual variável falta (sem mostrar valores).
router.get('/api/health', 'public', async () => {
  let database: 'ok' | 'missing' | 'error' = 'missing';
  if (databaseUrl()) {
    try {
      await one('select 1');
      database = 'ok';
    } catch {
      database = 'error';
    }
  }
  return json({ database, blob: blobConfigured() ? 'ok' : 'missing' });
});

registerPublic(router);
registerSession(router);
registerTracking(router);
registerAccount(router);
registerOrders(router);
registerCatalog(router);
registerContent(router);
registerTeam(router);
registerCustomers(router);
registerUpload(router);

const clientIp = (req: Request) => req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

// Constraints do banco que merecem uma mensagem própria.
const CONSTRAINT_MESSAGES: Record<string, string> = {
  store_settings_some_delivery: 'Mantenha pelo menos entrega ou retirada ativa.',
  admins_email_key: 'Já existe um administrador com esse e-mail.',
  customers_email_key: 'Já existe uma conta com esse e-mail. Entre na sua conta ou recupere a senha.',
  categories_name_key: 'Já existe uma categoria com esse nome.',
  delivery_zones_name_key: 'Esse bairro já está cadastrado.',
  products_sku_key: 'Já existe um produto com esse SKU.',
};

function failure(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message, ...error.extra }, error.status);
  if (error instanceof MissingConfig) {
    return json({ error: error.message, code: 'not_configured', missing: error.missing }, 503);
  }
  const e = error as { code?: string; message?: string; constraint?: string };
  switch (e?.code) {
    case 'P0001': // regras de negócio do banco, já em português
      return json({ error: e.message }, 400);
    case '23505':
      return json({ error: (e.constraint && CONSTRAINT_MESSAGES[e.constraint]) || 'Já existe um item com esse nome ou código.' }, 409);
    case '23514':
      return json({ error: (e.constraint && CONSTRAINT_MESSAGES[e.constraint]) || 'Algum valor está fora do permitido. Confira os campos e tente de novo.' }, 400);
    case '23503':
      return json({ error: 'Este item está ligado a outros dados e não pode ser removido.' }, 409);
    case '22P02':
    case '22003':
    case '22007':
      return json({ error: 'Algum valor enviado é inválido.' }, 400);
    case '42P01':
      return json({ error: 'O banco ainda não foi preparado. Rode as migrations (npm run db:migrate).', code: 'not_migrated' }, 503);
  }
  console.error('[api] erro inesperado:', error);
  return json({ error: 'Erro interno. Tente novamente em instantes.' }, 500);
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

// Defesa extra contra CSRF (além do cookie SameSite=Lax): escritas só da própria origem.
function foreignOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true;
  }
}

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    const found = router.match(req.method === 'HEAD' ? 'GET' : req.method, path);
    if (!found) throw new HttpError(404, 'Rota não encontrada.');
    if ('allowed' in found) {
      return json({ error: 'Método não permitido.' }, 405, { allow: found.allowed.join(', ') });
    }
    const { route, params } = found;
    const access: Access = route.access;
    if (!SAFE_METHODS.has(req.method) && foreignOrigin(req, url)) throw new HttpError(403, 'Origem não permitida.');

    const ctx: Ctx = { req, url, params, ip: clientIp(req), admin: null };
    if (access !== 'public') {
      ctx.admin = await adminFromRequest(req);
      if (!ctx.admin) throw new HttpError(401, 'Faça login para continuar.');
      if (access === 'owner' && ctx.admin.role !== 'owner') throw new HttpError(403, 'Só o owner pode fazer isso.');
    }
    return await route.handler(ctx);
  } catch (error) {
    return failure(error);
  }
}
