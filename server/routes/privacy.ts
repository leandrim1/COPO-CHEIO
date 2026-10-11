// Privacidade (LGPD). Qualquer pessoa, com ou sem conta, pode pedir acesso, correção ou exclusão dos próprios dados; a loja trata
// os pedidos no painel (Clientes) e, a pedido do titular, anonimiza os pedidos de quem comprou como visitante.
import { audit } from '../audit.js';
import { reserve } from '../auth.js';
import { one, query } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import { normalizeLoginEmail } from '../emailAddress.js';
import { digits, oneOf, parse, text } from '../validate.js';
import type { Spec } from '../validate.js';

const KINDS = ['access', 'correction', 'deletion', 'other'] as const;
const KIND_LABEL: Record<(typeof KINDS)[number], string> = { access: 'acesso aos dados', correction: 'correção de dados', deletion: 'exclusão de dados', other: 'outro assunto' };

const requestSpec: Spec = {
  kind: oneOf('Assunto', KINDS),
  name: text('Nome', { min: 2, max: 80, required: true }),
  message: text('Mensagem', { max: 1000, nullable: true }),
};

// Telefone (10 a 13 dígitos) ou e-mail: o que a loja usa para responder.
function contactOf(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.includes('@')) {
    const mail = normalizeLoginEmail(raw);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail) || mail.length > 254) throw new HttpError(400, 'Contato: confira o e-mail.');
    return mail;
  }
  return String(digits('Contato', { min: 10, max: 13 }).parse(raw));
}

export function registerPrivacy(r: Router) {
  // Público. Resposta sempre igual; sem dado sensível. O campo "website" é uma armadilha para robôs: pessoas não o veem nem preenchem.
  r.post('/api/privacy/request', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 8 * 1024);
    await reserve('privacy-ip', ctx.ip, 3600, 5, 'Muitos pedidos em pouco tempo. Tente de novo mais tarde ou fale com a loja pelo WhatsApp.');
    if (typeof body.website === 'string' && body.website.trim() !== '') return json({ ok: true }, 201);
    const { values } = parse(requestSpec, body);
    const contact = contactOf(body.contact);
    await query('insert into privacy_requests (kind, name, contact, message) values ($1, $2, $3, $4)', [values.kind ?? 'other', values.name, contact, values.message ?? null]);
    return json({ ok: true }, 201);
  });

  // Painel: lista dos pedidos (abertos primeiro).
  r.get('/api/admin/privacy', 'admin', async (ctx) => {
    const status = ctx.url.searchParams.get('status');
    const where = status === 'open' || status === 'done' || status === 'rejected' ? 'where status = $1' : '';
    const rows = await query(`select * from privacy_requests ${where} order by (status = 'open') desc, created_at desc limit 200`, where ? [status] : []);
    const open = (await one<{ n: number }>("select count(*) as n from privacy_requests where status = 'open'"))?.n ?? 0;
    return json({ requests: rows, open });
  });

  r.patch('/api/admin/privacy/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 4 * 1024);
    const { values } = parse({ status: oneOf('Situação', ['open', 'done', 'rejected'] as const, { required: true }), handled_note: text('Observação', { max: 500, nullable: true }) }, body);
    const row = await one<{ kind: (typeof KINDS)[number] }>(
      `update privacy_requests
          set status = $2, handled_note = $3,
              handled_by = case when $2 = 'open' then null else $4::uuid end,
              handled_by_name = case when $2 = 'open' then null else $5 end,
              handled_at = case when $2 = 'open' then null else now() end
        where id = $1 returning kind`,
      [id, values.status, values.handled_note ?? null, ctx.admin!.id, ctx.admin!.name],
    );
    if (!row) throw new HttpError(404, 'Pedido não encontrado.');
    await audit(ctx, { action: 'privacy.update', summary: `Marcou um pedido de ${KIND_LABEL[row.kind]} como ${values.status === 'done' ? 'atendido' : values.status === 'rejected' ? 'recusado' : 'aberto'}`, entity: 'privacy_request', entityId: id });
    return json({ ok: true });
  });

  // A pedido do titular: apaga a conta e tira dos pedidos o que identifica a pessoa (nome, telefone, e-mail, endereço, observações).
  // Só o owner, e fica registrado (sem repetir os dados pessoais no registro).
  r.post('/api/admin/privacy/anonymize', 'owner', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const phone = typeof body.phone === 'string' ? body.phone : '';
    const email = typeof body.email === 'string' ? body.email : '';
    if (!phone.replace(/\D/g, '') && !email.trim()) throw new HttpError(400, 'Informe o telefone (com DDD) ou o e-mail da pessoa.');
    const result = await one<{ r: { orders: number; customers: number } }>('select anonymize_person($1, $2) as r', [phone, email]);
    const done = result?.r ?? { orders: 0, customers: 0 };
    await audit(ctx, { action: 'privacy.anonymize', summary: `Anonimizou os dados de uma pessoa a pedido dela: ${done.orders} pedido(s) e ${done.customers} conta(s)`, entity: 'privacy', details: { orders: done.orders, customers: done.customers } });
    return json(done);
  });
}
