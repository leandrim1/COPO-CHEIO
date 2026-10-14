// API do COPO CHEIO: um único handler (Request → Response) para todas as rotas /api/*.
// Roda como função da Vercel (api/index.ts) e também no servidor de desenvolvimento do Vite.
import { randomUUID } from 'node:crypto';
import { adminFromRequest } from './auth.js';
import { clientIp } from './clientIp.js';
import { blobConfigured, databaseUrl, MissingConfig } from './env.js';
import { kickQueue, rememberRequest } from './email/service.js';
import { mailConfigured, mailMissing } from './mail.js';
import { siteUrl } from './mailBrand.js';
import { onlineReadiness } from './payments/service.js';
import { HttpError, Router, json } from './http.js';
import type { Access, Admin, Ctx } from './http.js';
import { registerAccount } from './routes/account.js';
import { registerAudit } from './routes/audit.js';
import { registerCatalog } from './routes/catalog.js';
import { registerContent } from './routes/content.js';
import { registerOrders } from './routes/orders.js';
import { registerPayments } from './routes/payments.js';
import { registerPrivacy } from './routes/privacy.js';
import { registerPublic } from './routes/public.js';
import { registerSeo } from './routes/seo.js';
import { registerSession } from './routes/session.js';
import { registerCustomers } from './routes/customers.js';
import { registerEmailAdmin } from './routes/emailadmin.js';
import { registerEmailPublic } from './routes/emailpublic.js';
import { registerMailAdmin } from './routes/mailadmin.js';
import { registerTeam } from './routes/team.js';
import { registerTracking } from './routes/tracking.js';
import { registerTwoFactor } from './routes/twofactor.js';
import { registerUpload } from './routes/upload.js';
import { one } from './db.js';

const router = new Router();

// Estado do sistema. Mostra o que falta (sem valores) só para quem precisa saber: o painel (administrador logado) e quem roda o
// site no próprio computador. O endereço público na internet só diz se está de pé.
async function systemStatus(req: Request) {
  let database: 'ok' | 'missing' | 'error' = 'missing';
  if (databaseUrl()) {
    try {
      await one('select 1');
      database = 'ok';
    } catch {
      database = 'error';
    }
  }
  let site: 'ok' | 'missing' = 'ok';
  try {
    siteUrl(req);
  } catch {
    site = 'missing';
  }
  const missing = [
    ...(databaseUrl() ? [] : ['DATABASE_URL']),
    ...(blobConfigured() ? [] : ['BLOB_READ_WRITE_TOKEN (ou BLOB_STORE_ID)']),
    ...mailMissing(),
    ...(site === 'ok' ? [] : ['SITE_URL']),
  ];
  return { database, blob: blobConfigured() ? 'ok' : 'missing', mail: mailConfigured() ? 'ok' : 'missing', site_url: site, missing };
}

router.get('/api/health', 'public', async (ctx) => {
  const status = await systemStatus(ctx.req);
  // Na Vercel o endereço é público: só "está de pé ou não" (503 se o banco não responde, para monitores de disponibilidade).
  if (process.env.VERCEL) return json({ ok: status.database === 'ok' }, status.database === 'ok' ? 200 : 503);
  return json({ ok: status.database === 'ok', database: status.database, blob: status.blob, mail: status.mail, site_url: status.site_url });
});

// Mesmo resultado detalhado, mas só para administradores logados (inclui o nome das variáveis que faltam).
// `payments`: o pagamento online é opcional (não entra em `missing`); mostra só se há operadora e conta aprovada, sem valores.
router.get('/api/admin/health', 'admin', async (ctx) => {
  const status = await systemStatus(ctx.req);
  const payments = status.database === 'ok' ? await onlineReadiness().catch(() => null) : null;
  return json({ ...status, payments });
});

registerPublic(router);
registerSession(router);
registerTwoFactor(router);
registerTracking(router);
registerAccount(router);
registerOrders(router);
registerPayments(router);
registerCatalog(router);
registerContent(router);
registerTeam(router);
registerCustomers(router);
registerMailAdmin(router);
registerEmailAdmin(router);
registerEmailPublic(router);
registerAudit(router);
registerPrivacy(router);
registerSeo(router);
registerUpload(router);

// Constraints do banco que merecem uma mensagem própria.
const CONSTRAINT_MESSAGES: Record<string, string> = {
  store_settings_some_delivery: 'Mantenha pelo menos entrega ou retirada ativa.',
  admins_email_key: 'Já existe um administrador com esse e-mail.',
  customers_email_key: 'Já existe uma conta com esse e-mail. Entre na sua conta ou recupere a senha.',
  categories_name_key: 'Já existe uma categoria com esse nome.',
  delivery_zones_name_key: 'Esse bairro já está cadastrado.',
  products_sku_key: 'Já existe um produto com esse SKU.',
  banners_has_content: 'O banner precisa de pelo menos uma imagem ou um título.',
  banners_cover_needs_image: 'O banner da capa precisa de uma imagem.',
};

function failure(error: unknown, admin: Admin | null, requestId: string): Response {
  if (error instanceof HttpError) return json({ error: error.message, ...error.extra }, error.status, error.headers);
  if (error instanceof MissingConfig) {
    // O servidor sempre registra o que falta. Quem está na internet só vê "indisponível"; o nome das variáveis vai para
    // quem está logado no painel e para quem roda o site no próprio computador.
    console.error(JSON.stringify({ level: 'error', msg: 'configuração ausente', missing: error.missing, request_id: requestId }));
    if (process.env.VERCEL && !admin) return json({ error: 'O serviço está temporariamente indisponível. Tente novamente em instantes.', code: 'not_configured' }, 503);
    return json({ error: error.message, code: 'not_configured', missing: error.missing }, 503);
  }
  const e = error as { code?: string; message?: string; constraint?: string; detail?: string };
  switch (e?.code) {
    case 'P0001': // regras de negócio do banco, já em português
      return json({ error: e.message }, 400);
    case 'CC400': // pedido incompleto que o site resolve com a pessoa (ex.: falta escolher o gelo); detalhes em JSON
    case 'CC409': {
      // Conflito que o site resolve com a pessoa (ex.: o preço mudou antes de enviar o pedido). Os detalhes vêm em JSON.
      let detail: Record<string, unknown> = {};
      try {
        detail = JSON.parse(e.detail ?? '{}') as Record<string, unknown>;
      } catch {
        /* sem detalhes */
      }
      return json({ error: e.message, ...detail }, e.code === 'CC400' ? 400 : 409);
    }
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
      console.error(JSON.stringify({ level: 'error', msg: 'banco sem migrations', request_id: requestId }));
      return json(
        { error: process.env.VERCEL && !admin ? 'O serviço está temporariamente indisponível. Tente novamente em instantes.' : 'O banco ainda não foi preparado. Rode as migrations (npm run db:migrate).', code: 'not_migrated' },
        503,
      );
  }
  console.error(JSON.stringify({ level: 'error', msg: 'erro inesperado', request_id: requestId, code: e?.code, error: e?.message ?? String(error) }));
  console.error('[api] erro inesperado:', error);
  return json({ error: 'Erro interno. Tente novamente em instantes.', request_id: requestId }, 500);
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
  const requestId = randomUUID();
  let admin: Admin | null = null;
  try {
    // %00 (caractere nulo) no endereço nunca é legítimo e o Postgres o recusa: responde 400 em vez de estourar lá dentro.
    if (/%00/i.test(req.url)) throw new HttpError(400, 'Endereço inválido.');
    const found = router.match(req.method === 'HEAD' ? 'GET' : req.method, path);
    if (!found) throw new HttpError(404, 'Rota não encontrada.');
    if ('allowed' in found) {
      return json({ error: 'Método não permitido.' }, 405, { allow: found.allowed.join(', ') });
    }
    const { route, params } = found;
    const access: Access = route.access;
    if (!SAFE_METHODS.has(req.method) && foreignOrigin(req, url)) throw new HttpError(403, 'Origem não permitida.');

    rememberRequest(req);
    const ctx: Ctx = { req, url, params, ip: clientIp(req), admin: null };
    if (access !== 'public') {
      ctx.admin = await adminFromRequest(req);
      admin = ctx.admin;
      if (!ctx.admin) throw new HttpError(401, 'Faça login para continuar.');
      if (access === 'owner' && ctx.admin.role !== 'owner') throw new HttpError(403, 'Só o owner pode fazer isso.');
    }
    const response = await route.handler(ctx);
    // Qualquer mudança que deu certo (pedido, etapa, pagamento) pode ter enfileirado um e-mail: os gatilhos do banco enfileiram sozinhos,
    // então não é preciso que cada rota se lembre de avisar. Aqui só se manda enviar, sem esperar. (Painel de e-mails e cron cuidam da fila.)
    if (!SAFE_METHODS.has(req.method) && response.status < 400 && !/^\/api\/(admin\/emails|cron)(\/|$)/.test(path)) kickQueue(req);
    response.headers.set('x-request-id', requestId);
    return response;
  } catch (error) {
    const response = failure(error, admin, requestId);
    response.headers.set('x-request-id', requestId);
    return response;
  }
}
