// Painel "E-mails e Entregabilidade": o que foi enviado, o que falhou, quem está na lista de supressão, a fila e as ações do dono.
//
// • Ver (estatísticas, histórico, supressões): qualquer administrador logado.
// • Agir (reenviar, cancelar, processar a fila, suprimir ou liberar um endereço): só o owner, e tudo fica no histórico de atividades.
// • Nada aqui mostra senha, código, link nem corpo de e-mail: o registro não os guarda.
import { audit } from '../audit.js';
import { reserve } from '../auth.js';
import { batch, one, query } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import { describeAlert } from '../email/alertText.js';
import { runAlerts } from '../email/alerts.js';
import { FREEMAIL_DOMAINS, fromAddress, promoDailyLimit, sendsFromFreemail } from '../email/config.js';
import { checkDomainDns } from '../email/dns.js';
import { BLOCK_LABEL, cancel, deliver, failureText, kickQueue, normalizeAddress, processQueue, requeue } from '../email/service.js';
import type { BlockReason } from '../email/service.js';
import { KINDS, isKind } from '../email/kinds.js';
import * as ledger from '../email/ledger.js';
import { renderMessage } from '../email/render.js';
import { overview } from '../email/stats.js';
import { parse, text } from '../validate.js';
import type { Spec } from '../validate.js';

const STATUSES = ['queued', 'sending', 'accepted', 'delivered', 'delayed', 'bounced', 'complained', 'failed', 'blocked', 'cancelled'];

// Linha da lista: o que o painel precisa para mostrar e filtrar (nunca o corpo nem a receita).
const LIST_COLUMNS = `m.id, m.created_at, m.kind, m.category, m.audience, m.recipient_email, m.recipient_domain, m.subject, m.status, m.transport,
  m.attempts, m.max_attempts, m.next_attempt_at, m.accepted_at, m.delivered_at, m.bounced_at, m.complained_at, m.opens, m.clicks, m.bounce_type,
  m.error_kind, m.error_code, m.error_detail, m.block_reason, m.campaign_id, o.order_number`;

// Nomes em português para o painel. `block_reason` é um código (suprimido, sem consentimento...) ou, para mensagens canceladas, uma frase.
const withLabel = (row: Row): Row => ({
  ...row,
  kind_label: isKind(String(row.kind)) ? KINDS[row.kind as keyof typeof KINDS].label : String(row.kind),
  block_label: row.block_reason ? (BLOCK_LABEL[String(row.block_reason) as BlockReason] ?? String(row.block_reason)) : null,
});

export function registerEmailAdmin(r: Router) {
  // Visão geral: totais, taxas (o que o provedor informa e o que não), fila, teto diário, supressões, avisos do provedor e alertas.
  // `refresh=1` (botão "Atualizar" do painel) reavalia os alertas na hora; sem isso eles são reavaliados no máximo a cada 10 minutos.
  r.get('/api/admin/emails/overview', 'admin', async (ctx) => {
    const days = Math.min(Math.max(Number(ctx.url.searchParams.get('days') ?? 7) || 7, 1), 90);
    const refresh = ctx.url.searchParams.get('refresh') === '1';
    if (refresh) await reserve('email-overview-refresh', ctx.admin!.id, 60, 20, 'Muitas atualizações seguidas. Aguarde um pouco.');
    await runAlerts(ctx.req, { force: refresh }).catch(() => []);
    const [data, alerts] = await Promise.all([
      overview(days),
      query<{ code: string; severity: 'info' | 'warning' | 'critical'; opened_at: string; last_seen_at: string; last_notified_at: string | null; detail: Record<string, unknown> | null }>(
        `select code, severity, opened_at, last_seen_at, last_notified_at, detail from email_alerts where resolved_at is null
          order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, opened_at`,
      ),
    ]);
    return json({
      ...data,
      // Os tipos de e-mail do sistema (para os filtros do painel), com o nome em português.
      kinds: (Object.keys(KINDS) as (keyof typeof KINDS)[]).map((kind) => ({ kind, label: KINDS[kind].label, category: KINDS[kind].category })),
      // Cada alerta com o texto pronto em português: título, o que aconteceu (`detail`) e o que fazer (`hint`). `data` são os números crus.
      alerts: alerts.map(({ detail: data, ...a }) => ({ ...a, ...describeAlert(a.code, data ?? {}), data })),
    });
  });

  // Confere SPF, DKIM e DMARC do domínio do remetente (só lê o DNS público). Para remetente de e-mail gratuito (Gmail, Outlook...) não há
  // domínio da loja para conferir.
  r.get('/api/admin/emails/dns', 'admin', async (ctx) => {
    const from = fromAddress();
    if (!from) throw new HttpError(409, 'O remetente ainda não está configurado (SMTP_USER / MAIL_FROM).', { code: 'no_sender' });
    if (FREEMAIL_DOMAINS.has(from.domain)) {
      return json({ applicable: false, domain: from.domain, reason: `O remetente usa ${from.domain}, um provedor de e-mail gratuito: o SPF, o DKIM e o DMARC desse domínio são do provedor, não da sua loja, e você não consegue alterá-los. Para autenticar o seu próprio domínio, é preciso um domínio da loja (veja "Como melhorar").` });
    }
    await reserve('email-dns', ctx.admin!.id, 600, 10, 'Muitas verificações seguidas. Aguarde alguns minutos.');
    const selector = (ctx.url.searchParams.get('selector') ?? '').trim().toLowerCase();
    if (selector && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(selector)) throw new HttpError(400, 'Nome da chave (seletor) inválido.');
    return json({ applicable: true, ...(await checkDomainDns(from.domain, { selectors: selector ? [selector] : undefined })) });
  });

  // Lista de mensagens com filtros (status, tipo, categoria, período, busca por e-mail ou número do pedido).
  r.get('/api/admin/emails/messages', 'admin', async (ctx) => {
    const q = ctx.url.searchParams;
    const where: string[] = [];
    const params: unknown[] = [];
    const status = q.get('status');
    if (status) {
      if (!STATUSES.includes(status)) throw new HttpError(400, 'Status inválido.');
      params.push(status);
      where.push(`m.status = $${params.length}`);
    }
    const kind = q.get('kind');
    if (kind) {
      if (!isKind(kind)) throw new HttpError(400, 'Tipo inválido.');
      params.push(kind);
      where.push(`m.kind = $${params.length}`);
    }
    const category = q.get('category');
    if (category) {
      if (category !== 'transactional' && category !== 'promotional') throw new HttpError(400, 'Categoria inválida.');
      params.push(category);
      where.push(`m.category = $${params.length}`);
    }
    for (const [key, op] of [['from', '>= ($N::date)::timestamp at time zone'], ['to', '< ($N::date + 1)::timestamp at time zone']] as const) {
      const value = q.get(key);
      if (!value) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'Data inválida.');
      params.push(value);
      where.push(`m.created_at ${op.replace('$N', `$${params.length}`)} (select timezone from store_settings where id = 1)`);
    }
    const term = (q.get('q') ?? '').trim().slice(0, 80);
    if (term) {
      if (/^#?\d{1,12}$/.test(term)) {
        params.push(term.replace('#', ''));
        where.push(`o.order_number = $${params.length}::bigint`);
      } else {
        params.push(`%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where.push(`m.recipient_email like $${params.length}`);
      }
    }
    const customer = q.get('customer');
    if (customer) {
      if (!/^[0-9a-f-]{36}$/i.test(customer)) throw new HttpError(400, 'Cliente inválido.');
      params.push(customer);
      where.push(`m.customer_id = $${params.length}::uuid`);
    }
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 30) || 30, 1), 100);
    const offset = Math.max(Number(q.get('offset') ?? 0) || 0, 0);
    params.push(limit + 1, offset);
    const rows = await query(
      `select ${LIST_COLUMNS} from email_messages m left join orders o on o.id = m.order_id
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by m.created_at desc limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return json({ messages: rows.slice(0, limit).map(withLabel), has_more: rows.length > limit });
  });

  // Uma mensagem com a linha do tempo (tentativas e eventos). Sem corpo, assunto de código, link nem receita.
  r.get('/api/admin/emails/messages/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const [messages, events] = await batch([
      [`select ${LIST_COLUMNS}, m.message_id, m.provider_id, (m.spec is not null) as can_retry from email_messages m left join orders o on o.id = m.order_id where m.id = $1`, [id]],
      ['select id, provider, type, occurred_at, received_at, detail from email_events where message_id = $1 order by occurred_at, received_at', [id]],
    ]);
    if (!messages[0]) throw new HttpError(404, 'Mensagem não encontrada.');
    return json({ message: withLabel(messages[0]), events });
  });

  // Reenviar uma mensagem que falhou (só quem ainda tem receita) e cancelar uma que está esperando ou falhou.
  r.post('/api/admin/emails/messages/:id/retry', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    if (!(await requeue(id))) throw new HttpError(409, 'Esta mensagem não pode ser reenviada (só as que falharam e ainda têm o que enviar).');
    await audit(ctx, { action: 'email.retry', summary: 'Mandou reenviar uma mensagem de e-mail que tinha falhado', entity: 'email', entityId: id });
    return json({ ok: true });
  });

  r.post('/api/admin/emails/messages/:id/cancel', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    if (!(await cancel(id))) throw new HttpError(409, 'Esta mensagem não está esperando nem falhou: não há o que cancelar.');
    await audit(ctx, { action: 'email.cancel', summary: 'Cancelou o envio de uma mensagem de e-mail', entity: 'email', entityId: id });
    return json({ ok: true });
  });

  // Processa a fila agora (o que já está na hora de tentar de novo).
  r.post('/api/admin/emails/process', 'owner', async (ctx) => {
    const result = await processQueue({ req: ctx.req, limit: 10, budgetMs: 7000 });
    await audit(ctx, { action: 'email.process', summary: `Processou a fila de e-mails: ${result.processed} mensagem(ns)`, entity: 'email', details: { ...result } });
    return json(result);
  });

  // ---- Lista de supressão ----

  r.get('/api/admin/emails/suppressions', 'admin', async (ctx) => {
    const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit') ?? 50) || 50, 1), 200);
    const rows = await query(
      `select email, reason, source, detail, created_at, expires_at from email_suppressions
        where expires_at is null or expires_at > now() order by created_at desc limit $1`,
      [limit + 1],
    );
    return json({ suppressions: rows.slice(0, limit), has_more: rows.length > limit });
  });

  // Colocar um endereço na lista (ex.: o cliente avisou que a caixa não existe mais) e tirar dela. Só o owner.
  r.post('/api/admin/emails/suppressions', 'owner', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const email = normalizeAddress(body.email);
    if (!email) throw new HttpError(400, 'Confira o e-mail.');
    await ledger.suppress(email, 'manual', 'admin', null, typeof body.note === 'string' ? body.note.trim().slice(0, 200) : null);
    await audit(ctx, { action: 'email.suppress', summary: 'Colocou um endereço na lista de supressão de e-mails', entity: 'email' });
    return json({ ok: true }, 201);
  });

  r.delete('/api/admin/emails/suppressions/:email', 'owner', async (ctx) => {
    const email = normalizeAddress(ctx.params.email);
    if (!email) throw new HttpError(400, 'Confira o e-mail.');
    if (!(await ledger.unsuppress(email))) throw new HttpError(404, 'Este endereço não está na lista de supressão.');
    await audit(ctx, { action: 'email.unsuppress', summary: 'Tirou um endereço da lista de supressão de e-mails', entity: 'email' });
    return json({ ok: true });
  });

  // ---- Campanhas promocionais ----
  //
  // Só chegam a quem consentiu e tem conta confirmada, nunca a endereço na lista de supressão. O envio é em fila, respeitando o teto diário de
  // promoções; quem se descadastra no meio do envio deixa de receber o resto. O dono confirma o NÚMERO de destinatários antes de enviar.

  const campaignSpec: Spec = {
    name: text('Nome da campanha', { min: 2, max: 80, required: true }),
    subject: text('Assunto', { min: 2, max: 150, required: true }),
    preheader: text('Resumo (pré-visualização)', { max: 150, nullable: true }),
    title: text('Título', { min: 2, max: 100, required: true }),
    body: text('Texto', { min: 2, max: 4000, required: true }),
    cta_label: text('Texto do botão', { min: 2, max: 40, nullable: true }),
    cta_url: text('Endereço do botão', { max: 500, nullable: true }),
  };

  // Regras de conteúdo (sem enganar filtros nem pessoas): assunto sem "Re:"/"Fwd:" falso e sem gritaria, botão só com https e sem encurtador.
  const SHORTENERS = /(^|\.)(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|cutt\.ly|rebrand\.ly|tiny\.cc|buff\.ly|shorturl\.at)$/i;
  function checkCampaign(values: Row) {
    // Campos de uma linha só (o assunto vira cabeçalho do e-mail: quebra de linha nele é tentativa de injeção de cabeçalho).
    for (const [key, label] of [['name', 'Nome'], ['subject', 'Assunto'], ['preheader', 'Resumo'], ['title', 'Título'], ['cta_label', 'Texto do botão'], ['cta_url', 'Endereço do botão']] as const) {
      if (typeof values[key] === 'string' && /[\r\n\u2028\u2029]/.test(values[key] as string)) throw new HttpError(400, `${label}: use uma linha só.`);
    }
    const subject = String(values.subject ?? '');
    if (/^\s*(re|res|fw|fwd|enc)\s*:/i.test(subject)) throw new HttpError(400, 'Assunto: não use "Re:" nem "Fwd:" (parece uma resposta que nunca existiu).');
    const letters = subject.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 8 && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length > 0.7) throw new HttpError(400, 'Assunto: evite escrever tudo em maiúsculas (cai no spam).');
    if ((values.cta_label ?? null) === null !== ((values.cta_url ?? null) === null)) throw new HttpError(400, 'Botão: informe o texto E o endereço, ou deixe os dois vazios.');
    if (typeof values.cta_url === 'string') {
      let url: URL;
      try {
        url = new URL(values.cta_url);
      } catch {
        throw new HttpError(400, 'Endereço do botão: confira o link.');
      }
      if (url.protocol !== 'https:' || url.username || url.password) throw new HttpError(400, 'Endereço do botão: só links https (sem usuário e senha).');
      if (SHORTENERS.test(url.hostname)) throw new HttpError(400, 'Endereço do botão: não use encurtador de link (bit.ly e parecidos); use o endereço verdadeiro.');
    }
  }

  const ELIGIBLE = `
    select p.email, c.id as customer_id
      from email_preferences p
      join customers c on lower(c.email) = p.email and c.active and c.email_verified_at is not null
     where p.marketing
       and not exists (select 1 from email_suppressions s where s.email = p.email and (s.expires_at is null or s.expires_at > now()))`;

  const audience = async () => (await one<{ n: number }>(`select count(*)::int as n from (${ELIGIBLE}) x`))?.n ?? 0;

  // Quantas mensagens de cada campanha estão em cada estado.
  const CAMPAIGN_LIST = `
    select c.id, c.created_at, c.created_by_name, c.name, c.subject, c.status, c.audience_total, c.started_at, c.finished_at,
           (select count(*)::int from email_messages m where m.campaign_id = c.id and m.kind = 'campaign' and m.status in ('queued', 'sending')) as pending,
           (select count(*)::int from email_messages m where m.campaign_id = c.id and m.kind = 'campaign' and m.status in ('accepted', 'delivered', 'delayed')) as sent,
           (select count(*)::int from email_messages m where m.campaign_id = c.id and m.kind = 'campaign' and m.status in ('failed', 'bounced', 'complained')) as failed,
           (select count(*)::int from email_messages m where m.campaign_id = c.id and m.kind = 'campaign' and m.status in ('blocked', 'cancelled')) as skipped
      from email_campaigns c`;

  r.get('/api/admin/emails/campaigns', 'admin', async () => {
    await ledger.finishCampaigns().catch(() => undefined);
    const campaigns = await query(`${CAMPAIGN_LIST} order by c.created_at desc limit 50`);
    return json({
      campaigns,
      audience: await audience(),
      // O que a loja pode mandar por dia: serve para estimar quantos dias a campanha leva (o resto espera na fila).
      promo_daily_limit: promoDailyLimit(),
      free_sender: sendsFromFreemail(),
    });
  });

  r.get('/api/admin/emails/campaigns/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const rows = await query(`${CAMPAIGN_LIST} where c.id = $1`, [id]);
    const full = await one('select preheader, title, body, cta_label, cta_url from email_campaigns where id = $1', [id]);
    if (!rows[0] || !full) throw new HttpError(404, 'Campanha não encontrada.');
    return json({ campaign: { ...rows[0], ...full } });
  });

  r.post('/api/admin/emails/campaigns', 'owner', async (ctx) => {
    const { values } = parse(campaignSpec, await readJson(ctx.req, 16 * 1024));
    checkCampaign(values);
    const row = await one<{ id: string }>(
      `insert into email_campaigns (created_by, created_by_name, name, subject, preheader, title, body, cta_label, cta_url)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [ctx.admin!.id, ctx.admin!.name, values.name, values.subject, values.preheader ?? null, values.title, values.body, values.cta_label ?? null, values.cta_url ?? null],
    );
    await audit(ctx, { action: 'email.campaign_create', summary: `Criou a campanha de e-mail “${values.name}” (rascunho)`, entity: 'email_campaign', entityId: row?.id });
    return json({ id: row!.id }, 201);
  });

  r.patch('/api/admin/emails/campaigns/:id', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const { values } = parse(campaignSpec, await readJson(ctx.req, 16 * 1024));
    checkCampaign(values);
    const row = await one<{ id: string }>(
      `update email_campaigns set name = $2, subject = $3, preheader = $4, title = $5, body = $6, cta_label = $7, cta_url = $8
        where id = $1 and status = 'draft' returning id`,
      [id, values.name, values.subject, values.preheader ?? null, values.title, values.body, values.cta_label ?? null, values.cta_url ?? null],
    );
    if (!row) throw new HttpError(409, 'Só dá para editar campanhas que ainda são rascunho.');
    await audit(ctx, { action: 'email.campaign_update', summary: `Editou a campanha de e-mail “${values.name}”`, entity: 'email_campaign', entityId: id });
    return json({ ok: true });
  });

  r.delete('/api/admin/emails/campaigns/:id', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const row = await one<{ name: string }>(`delete from email_campaigns where id = $1 and status = 'draft' returning name`, [id]);
    if (!row) throw new HttpError(409, 'Só dá para apagar campanhas que ainda são rascunho.');
    await audit(ctx, { action: 'email.campaign_delete', summary: `Apagou o rascunho da campanha “${row.name}”`, entity: 'email_campaign', entityId: id });
    return json({ ok: true });
  });

  // Manda a campanha SÓ para o e-mail de quem está logado, com o aviso "[Teste]". Serve para ver como chega no Gmail/Outlook antes de enviar.
  r.post('/api/admin/emails/campaigns/:id/test', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    if (!(await one('select 1 as ok from email_campaigns where id = $1', [id]))) throw new HttpError(404, 'Campanha não encontrada.');
    await reserve('campaign-test', ctx.admin!.id, 3600, 10, 'Muitos testes seguidos. Aguarde um pouco.');
    const message = await renderMessage({ kind: 'campaign_test', to: ctx.admin!.email.toLowerCase(), spec: { campaign_id: id, sample: true } }, ctx.req);
    if (!message) throw new HttpError(404, 'Campanha não encontrada.');
    const result = await deliver({ kind: 'campaign_test', to: ctx.admin!.email, message, req: ctx.req, campaignId: id });
    if (!result.ok) throw new HttpError(502, `Não foi possível enviar o teste: ${failureText(result)}`, { code: 'mail_failed' });
    return json({ ok: true, to: ctx.admin!.email });
  });

  // Enfileira a campanha para TODOS os que podem receber. O corpo traz `confirm_count`: o número que o dono viu na tela; se mudou, volta 409
  // com o número novo (ninguém envia para uma lista diferente da que confirmou). Remetente de e-mail gratuito exige `accept_risk`.
  r.post('/api/admin/emails/campaigns/:id/send', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 1024);
    const now = await audience();
    if (body.confirm_count !== now) throw new HttpError(409, `A lista mudou: agora são ${now} destinatário(s). Confira e confirme de novo.`, { code: 'audience_changed', audience: now });
    if (now === 0) throw new HttpError(409, 'Ninguém pode receber esta campanha agora: nenhum cliente com e-mail confirmado aceitou receber promoções.', { code: 'no_audience' });
    if (sendsFromFreemail() && body.accept_risk !== true) {
      throw new HttpError(409, 'O remetente é um e-mail gratuito (Gmail, Outlook...). Promoções em massa por ele têm limite baixo e podem levar a conta a ser bloqueada ou as mensagens ao spam. Marque que você entende o risco para continuar.', { code: 'free_sender_risk' });
    }
    const campaign = await one<{ name: string; subject: string }>(`update email_campaigns set status = 'sending', started_at = now(), audience_total = $2 where id = $1 and status = 'draft' returning name, subject`, [id, now]);
    if (!campaign) throw new HttpError(409, 'Esta campanha já foi enviada, está sendo enviada ou foi cancelada.');
    const queued = await query(
      `insert into email_messages (kind, category, audience, recipient_email, recipient_domain, customer_id, campaign_id, subject, status, spec, dedupe_key, max_attempts, next_attempt_at)
       select 'campaign', 'promotional', 'customer', e.email, split_part(e.email, '@', 2), e.customer_id, $1::uuid, $2, 'queued', jsonb_build_object('campaign_id', $1::text), 'campaign:' || $1::text || ':' || e.email, 3, now()
         from (${ELIGIBLE}) e
       on conflict (dedupe_key) where dedupe_key is not null do nothing
       returning id`,
      [id, campaign.subject],
    );
    await audit(ctx, { action: 'email.campaign_send', summary: `Enviou a campanha de e-mail “${campaign.name}” para ${queued.length} destinatário(s)`, entity: 'email_campaign', entityId: id, details: { recipients: queued.length } });
    kickQueue(ctx.req);
    return json({ ok: true, queued: queued.length }, 202);
  });

  // Para o envio: o que ainda está na fila não sai (o que já saiu, saiu).
  r.post('/api/admin/emails/campaigns/:id/cancel', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const campaign = await one<{ name: string }>(`update email_campaigns set status = 'cancelled', cancelled_at = now(), finished_at = now() where id = $1 and status = 'sending' returning name`, [id]);
    if (!campaign) throw new HttpError(409, 'Esta campanha não está sendo enviada.');
    const stopped = await query(`update email_messages set status = 'cancelled', block_reason = 'campanha cancelada', spec = null, next_attempt_at = null where campaign_id = $1 and status in ('queued') returning id`, [id]);
    await audit(ctx, { action: 'email.campaign_cancel', summary: `Cancelou o envio da campanha de e-mail “${campaign.name}” (${stopped.length} mensagem(ns) não saíram)`, entity: 'email_campaign', entityId: id });
    return json({ ok: true, stopped: stopped.length });
  });
}
