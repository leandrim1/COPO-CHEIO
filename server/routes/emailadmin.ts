// Painel "E-mails e Entregabilidade": o que foi enviado, o que falhou, quem está na lista de supressão, a fila e as ações do dono.
//
// • Ver (estatísticas, histórico, supressões): qualquer administrador logado.
// • Agir (reenviar, cancelar, processar a fila, suprimir ou liberar um endereço): só o owner, e tudo fica no histórico de atividades.
// • Nada aqui mostra senha, código, link nem corpo de e-mail: o registro não os guarda.
import { audit } from '../audit.js';
import { batch, query } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import { cancel, normalizeAddress, processQueue, requeue } from '../email/service.js';
import { KINDS, isKind } from '../email/kinds.js';
import * as ledger from '../email/ledger.js';

const STATUSES = ['queued', 'sending', 'accepted', 'delivered', 'delayed', 'bounced', 'complained', 'failed', 'blocked', 'cancelled'];

// Linha da lista: o que o painel precisa para mostrar e filtrar (nunca o corpo nem a receita).
const LIST_COLUMNS = `m.id, m.created_at, m.kind, m.category, m.audience, m.recipient_email, m.recipient_domain, m.subject, m.status, m.transport,
  m.attempts, m.max_attempts, m.next_attempt_at, m.accepted_at, m.delivered_at, m.bounced_at, m.complained_at, m.opens, m.clicks, m.bounce_type,
  m.error_kind, m.error_code, m.error_detail, m.block_reason, m.campaign_id, o.order_number`;

const withLabel = (row: Row): Row => ({ ...row, kind_label: isKind(String(row.kind)) ? KINDS[row.kind as keyof typeof KINDS].label : String(row.kind) });

export function registerEmailAdmin(r: Router) {
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

}
