// Cancelamento do pedido pelo próprio cliente (pelo código de acompanhamento ou pela conta).
//
// As regras ficam no banco (migration 0027): customer_cancel_order trava o pedido, confere se ainda pode ser cancelado (order_cancel_why: só até a loja
// confirmar e sem dinheiro recebido), grava quem, quando, o motivo e o estado anterior, devolve o estoque UMA vez e encerra a cobrança em aberto. Este módulo
// cuida do que o banco não alcança: achar o pedido ANTES (para saber quais cobranças Pix estavam em aberto) e cancelar essas cobranças na operadora DEPOIS.
import { one } from './db.js';
import { HttpError } from './http.js';
import { cancelProviderCharges, openPixCharges } from './payments/service.js';

export type CancelRequest = {
  // Código de acompanhamento (hash) com ou sem o número do pedido, OU a conta (customerId) com o número. Um dos dois, nunca nenhum.
  hash: string | null;
  number: string | null;
  customerId: string | null;
  // Quem cancelou, como vai no histórico do pedido.
  actor: string;
  reason: unknown;
};

// O motivo é opcional, texto simples de até 200 caracteres (sem caracteres de controle).
export function cleanReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'O motivo precisa ser um texto.');
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (text.length > 200) throw new HttpError(400, 'O motivo pode ter até 200 caracteres.');
  return text || null;
}

// null = não há pedido com esses dados (código errado, vencido ou pedido de outra conta: a mesma resposta). Se o pedido existe mas não pode mais ser
// cancelado, o banco recusa com 409 (código `cancel_not_allowed` e o motivo em `why`).
export async function cancelForCustomer(request: CancelRequest): Promise<{ order: Record<string, unknown>; already: boolean } | null> {
  const reason = cleanReason(request.reason);
  const found = request.customerId
    ? await one<{ id: string }>('select id from orders where customer_id = $1::uuid and order_number = $2::bigint', [request.customerId, request.number])
    : await one<{ id: string }>(
        `select o.id
           from orders o
           join order_tracking_tokens t on t.order_id = o.id
           join store_settings s on s.id = 1
          where t.token_hash = $1
            and t.revoked_at is null
            and ($2::bigint is null or o.order_number = $2::bigint)
            and o.updated_at > now() - make_interval(days => s.tracking_retention_days)`,
        [request.hash, request.number],
      );
  if (!found) return null;

  const open = await openPixCharges(found.id);
  const row = await one<{ order: Record<string, unknown> | null }>('select customer_cancel_order($1, $2::bigint, $3::uuid, $4, $5) as "order"', [
    request.hash,
    request.number,
    request.customerId,
    reason,
    request.actor,
  ]);
  if (!row?.order) return null;
  const { already_cancelled: already, ...order } = row.order as Record<string, unknown> & { already_cancelled?: boolean };
  // Só quem acabou de cancelar mexe na operadora (um segundo toque, que devolve o pedido já cancelado, não repete nada).
  if (already !== true) await cancelProviderCharges(open);
  return { order, already: already === true };
}
