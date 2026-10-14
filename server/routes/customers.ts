// Painel: contas de clientes (suporte). A loja não vê senhas; só gera link de redefinição e desativa/exclui contas.
import { randomBytes } from 'node:crypto';
import { audit } from '../audit.js';
import { sha256 } from '../auth.js';
import { batch, one, query } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Ctx, Router } from '../http.js';
import { deliver } from '../email/service.js';
import { mailConfigured } from '../mail.js';

const RESET_HOURS = 24;

// Avisa a pessoa, na caixa de e-mail da conta, que a loja gerou um link para trocar a senha dela. Melhor esforço: se o e-mail não
// puder sair, o link continua valendo e a resposta diz que o aviso não foi enviado.
async function noticeCustomer(ctx: Ctx, customer: { name: string; email: string; email_verified_at: string | null }): Promise<boolean> {
  if (!customer.email_verified_at || !mailConfigured()) return false;
  try {
    // Se o servidor de e-mail falhar agora, o aviso fica na fila e sai depois (a resposta diz só se saiu agora).
    const result = await deliver({ kind: 'admin_reset_notice', to: customer.email, spec: { name: customer.name, at: new Date().toISOString() }, req: ctx.req });
    return result.ok;
  } catch {
    console.error('[clientes] o aviso do link de nova senha não foi enviado');
    return false;
  }
}

export function registerCustomers(r: Router) {
  r.get('/api/admin/customers', 'admin', async (ctx) => {
    const term = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 80);
    const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit') ?? 50) || 50, 1), 200);
    const params: unknown[] = [];
    let where = '';
    if (term) {
      const digits = term.replace(/\D/g, '');
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like);
      const parts = [`c.name ilike $${params.length}`, `c.email ilike $${params.length}`];
      if (digits.length >= 3) {
        params.push(`%${digits}%`);
        parts.push(`c.phone like $${params.length}`);
      }
      where = `where ${parts.join(' or ')}`;
    }
    params.push(limit + 1);
    const rows = await query(
      `select c.id, c.name, c.email, c.phone, c.active, c.status, c.email_verified_at, c.created_at, c.last_login_at,
              (select count(*) from orders o where o.customer_id = c.id) as orders
         from customers c ${where} order by c.created_at desc limit $${params.length}`,
      params,
    );
    return json({ customers: rows.slice(0, limit), has_more: rows.length > limit });
  });

  // Link de redefinição de senha (uso único, vale 24 horas). SÓ O OWNER gera: quem tem o link assume a conta, então a ação fica
  // restrita, registrada no histórico de atividades e avisada por e-mail ao próprio cliente. A loja confirma quem é a pessoa e
  // envia o link por um canal que já conhece (WhatsApp do pedido). O código só aparece nesta resposta.
  r.post('/api/admin/customers/:id/reset-link', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const token = randomBytes(24).toString('base64url');
    const [, created] = await batch([
      ['delete from customer_password_resets where customer_id = $1 and used_at is null', [id]],
      [
        `insert into customer_password_resets (token_hash, customer_id, created_by, expires_at)
         select $2, c.id, $3, now() + make_interval(hours => $4) from customers c where c.id = $1
         returning expires_at`,
        [id, sha256(token), ctx.admin!.id, RESET_HOURS],
      ],
    ]);
    if (!created.length) throw new HttpError(404, 'Cliente não encontrado.');
    const customer = await one<{ name: string; email: string; email_verified_at: string | null }>('select name, email, email_verified_at from customers where id = $1', [id]);
    const notified = customer ? await noticeCustomer(ctx, customer) : false;
    await audit(ctx, {
      action: 'customer.reset_link',
      summary: `Gerou um link de nova senha para o cliente ${customer?.name ?? ''} (${customer?.email ?? ''})${notified ? ' e avisou o cliente por e-mail' : ''}`,
      entity: 'customer',
      entityId: id,
      details: { notified },
    });
    return json({ token, expires_at: created[0].expires_at, notified }, 201);
  });

  r.patch('/api/admin/customers/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 1024);
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'Nada para atualizar.');
    const customer = await one('update customers set active = $2 where id = $1 returning id, name, email, phone, active, status, email_verified_at', [id, body.active]);
    if (!customer) throw new HttpError(404, 'Cliente não encontrado.');
    if (!body.active) await query('delete from customer_sessions where customer_id = $1', [id]);
    await audit(ctx, { action: 'customer.update', summary: `${body.active ? 'Reativou' : 'Desativou'} a conta do cliente ${customer.name} (${customer.email})`, entity: 'customer', entityId: id });
    return json({ customer });
  });

  // Exclusão a pedido do titular: apaga a conta e o endereço guardado. Os pedidos ficam (histórico e
  // obrigações fiscais) e perdem a ligação com a conta.
  r.delete('/api/admin/customers/:id', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const removed = await one<{ name: string; email: string }>('delete from customers where id = $1 returning name, email', [id]);
    if (!removed) throw new HttpError(404, 'Cliente não encontrado.');
    await audit(ctx, { action: 'customer.delete', summary: `Excluiu a conta do cliente ${removed.name} (${removed.email})`, entity: 'customer', entityId: id });
    return json({ ok: true });
  });
}
