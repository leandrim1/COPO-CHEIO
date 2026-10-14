// Rotas de e-mail que NÃO são do painel:
//  • o cron diário da Vercel (processa a fila e faz a limpeza), protegido pelo segredo CRON_SECRET;
//  • preferências de e-mail de quem recebeu uma mensagem (link do próprio e-mail, com chave de 128 bits): cancelar promoções, "não quero
//    e-mails de pedidos neste endereço". O "cancelar com um clique" (RFC 8058) é o POST /api/email/unsubscribe/:token, sem cookie nem login;
//  • as mesmas preferências para quem está logado na conta (Minha conta → E-mails).
// Nada aqui revela se um endereço existe: link inventado ou adulterado recebe sempre a mesma resposta.
import { timingSafeEqual } from 'node:crypto';
import { reserve } from '../auth.js';
import { requireCustomer } from '../customer.js';
import { query } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Ctx, Router } from '../http.js';
import { maskEmail } from '../emailAddress.js';
import { processQueue } from '../email/service.js';
import { CONSENT_TEXT, getPreferences, isVerifiedCustomerEmail, preferencesByToken, setMarketing, setNotifyOrders } from '../email/preferences.js';
import type { Preferences } from '../email/preferences.js';

const NO_STORE = { 'x-robots-tag': 'noindex, nofollow' };
const INVALID = 'Este link de preferências não vale mais ou está incorreto.';

const view = (p: Pick<Preferences, 'email' | 'marketing' | 'notify_orders'>, eligible: boolean) => ({
  email_masked: maskEmail(p.email),
  marketing: p.marketing,
  // Só quem tem conta com e-mail confirmado pode ligar as promoções (é assim que o dono do e-mail prova que a caixa é dele).
  can_enable_marketing: eligible,
  notify_orders: p.notify_orders,
  consent_text: CONSENT_TEXT,
});

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Lê um booleano opcional do corpo; qualquer outra coisa é erro.
function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in body)) return undefined;
  if (typeof body[key] !== 'boolean') throw new HttpError(400, 'Os dados enviados são inválidos.');
  return body[key] as boolean;
}

export function registerEmailPublic(r: Router) {
  // O cron diário da Vercel chama isto com "Authorization: Bearer <CRON_SECRET>". Sem CRON_SECRET configurado a rota recusa tudo.
  r.get('/api/cron/email', 'public', async (ctx) => {
    const secret = (process.env.CRON_SECRET ?? '').trim();
    if (!secret || !sameSecret(ctx.req.headers.get('authorization') ?? '', `Bearer ${secret}`)) throw new HttpError(401, 'Não autorizado.');
    const queue = await processQueue({ req: ctx.req, limit: 25, budgetMs: 8000 });
    await query('select purge_expired_data()');
    return json({ ok: true, queue });
  });

  // ---- Pelo link do e-mail ----

  const byToken = async (ctx: Ctx): Promise<Preferences> => {
    await reserve('email-prefs-ip', ctx.ip, 600, 60, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    const prefs = await preferencesByToken(ctx.params.token);
    if (!prefs) throw new HttpError(404, INVALID);
    return prefs;
  };

  r.get('/api/email/preferences/:token', 'public', async (ctx) => {
    const prefs = await byToken(ctx);
    return json(view(prefs, await isVerifiedCustomerEmail(prefs.email)), 200, NO_STORE);
  });

  r.patch('/api/email/preferences/:token', 'public', async (ctx) => {
    const prefs = await byToken(ctx);
    const body = await readJson(ctx.req, 1024);
    const marketing = optionalBoolean(body, 'marketing');
    const orders = optionalBoolean(body, 'notify_orders');
    if (marketing === undefined && orders === undefined) throw new HttpError(400, 'Nada para atualizar.');
    const eligible = await isVerifiedCustomerEmail(prefs.email);
    let current = prefs;
    if (marketing === true && !eligible) {
      throw new HttpError(409, 'Para receber promoções, entre na sua conta da loja (com o e-mail confirmado) e ligue a opção em "Minha conta".', { code: 'needs_account' });
    }
    if (marketing !== undefined && marketing !== current.marketing) current = await setMarketing(current.email, marketing, marketing ? { consent: 'link' } : { unsubscribe: 'link' });
    if (orders !== undefined && orders !== current.notify_orders) current = await setNotifyOrders(current.email, orders);
    return json(view(current, eligible), 200, NO_STORE);
  });

  // Cancelar com um clique (RFC 8058): quem manda este POST é o provedor de caixa de entrada (Gmail, Yahoo...), sem cookies, sem login,
  // com o corpo "List-Unsubscribe=One-Click". Só cancela promoções; os e-mails de conta e de pedido continuam.
  r.post('/api/email/unsubscribe/:token', 'public', async (ctx) => {
    const prefs = await byToken(ctx);
    if (prefs.marketing) await setMarketing(prefs.email, false, { unsubscribe: 'one_click' });
    return json({ ok: true }, 200, NO_STORE);
  });

  // ---- Para quem está logado (Minha conta) ----

  r.get('/api/account/email-preferences', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const prefs = await getPreferences(customer.email.toLowerCase());
    return json({ marketing: prefs?.marketing ?? false, notify_orders: prefs?.notify_orders ?? true, consent_text: CONSENT_TEXT }, 200, NO_STORE);
  });

  r.patch('/api/account/email-preferences', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const body = await readJson(ctx.req, 1024);
    const marketing = optionalBoolean(body, 'marketing');
    const orders = optionalBoolean(body, 'notify_orders');
    if (marketing === undefined && orders === undefined) throw new HttpError(400, 'Nada para atualizar.');
    await reserve('email-prefs-account', customer.id, 3600, 30, 'Muitas mudanças seguidas. Aguarde um pouco.');
    const email = customer.email.toLowerCase();
    let prefs = await getPreferences(email);
    if (marketing !== undefined && marketing !== (prefs?.marketing ?? false)) prefs = await setMarketing(email, marketing, marketing ? { consent: 'conta' } : { unsubscribe: 'conta' });
    if (orders !== undefined && orders !== (prefs?.notify_orders ?? true)) prefs = await setNotifyOrders(email, orders);
    return json({ marketing: prefs?.marketing ?? false, notify_orders: prefs?.notify_orders ?? true, consent_text: CONSENT_TEXT }, 200, NO_STORE);
  });
}
