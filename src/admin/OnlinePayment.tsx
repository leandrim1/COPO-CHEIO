import { CheckCheck, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { api, friendlyError } from '../lib/api';
import { formatDateTime, money, percentFromBps, taxaWording } from '../lib/format';
import type { AdminPayment, CommissionState, Order, PaymentState } from '../lib/types';
import { Badge, Button, Card, useToast } from './ui';

// Pedaços do pagamento online no painel: a mesma linguagem na página do pedido e na página de Pagamentos.

export const cents = (value: number | null | undefined) => (value === null || value === undefined ? '—' : money(value / 100));

export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  creating: 'Gerando o Pix',
  pending: 'Aguardando pagamento',
  paid: 'Pago',
  expired: 'Venceu',
  cancelled: 'Cancelado',
  failed: 'Falhou',
  refunded: 'Estornado',
};

const STATE_TONE: Record<PaymentState, 'blue' | 'green' | 'amber' | 'red' | 'gray'> = {
  creating: 'gray',
  pending: 'amber',
  paid: 'green',
  expired: 'gray',
  cancelled: 'gray',
  failed: 'red',
  refunded: 'red',
};

export function PaymentStateBadge({ status, method }: { status: PaymentState; method?: 'pix' | 'card' }) {
  // "creating" no cartão é a cobrança em andamento (ou sem resposta da operadora): não é "gerando o Pix".
  const label = status === 'creating' && method === 'card' ? 'Processando o cartão' : status === 'pending' && method === 'card' ? 'Aguardando o banco' : PAYMENT_STATE_LABEL[status];
  return <Badge tone={STATE_TONE[status]}>{label}</Badge>;
}

// A taxa (comissão) só é "efetivada" quando a operadora confirma o valor repassado; antes disso é só uma conta.
export const COMMISSION_LABEL: Record<CommissionState, string> = {
  calculated: 'Calculada, repasse ainda não confirmado',
  confirmed: 'Efetivada (repasse confirmado pela operadora)',
  failed: 'Falhou: não foi repassada',
  not_applicable: 'Sem divisão nesta cobrança',
};

export function CommissionBadge({ state }: { state: CommissionState }) {
  const tone = state === 'confirmed' ? 'green' : state === 'failed' ? 'red' : 'amber';
  const short = { calculated: 'Só calculada', confirmed: 'Efetivada', failed: 'Falhou', not_applicable: 'Sem divisão' }[state];
  return (
    <Badge tone={state === 'not_applicable' ? 'gray' : tone} className="max-w-full">
      <span title={COMMISSION_LABEL[state]}>{short}</span>
    </Badge>
  );
}

const shortId = (id: string | null | undefined) => (id ? (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-5)}` : id) : '—');

// Botões "Atualizar pagamento" e "Marcar como conferido" (só o owner usa).
export function PaymentActions({ payment, onChanged }: { payment: AdminPayment; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'refresh' | 'ack' | null>(null);

  const run = async (kind: 'refresh' | 'ack') => {
    setBusy(kind);
    try {
      await api.post(`/api/admin/payments/${payment.id}/${kind}`);
      toast.success(kind === 'refresh' ? 'Pagamento atualizado.' : 'Marcado como conferido.', `Pedido #${payment.order_number}`);
      onChanged();
    } catch (error) {
      toast.error(kind === 'refresh' ? 'Não foi possível atualizar o pagamento.' : 'Não foi possível marcar como conferido.', friendlyError(error, ''));
    } finally {
      setBusy(null);
    }
  };

  const open = payment.status === 'pending' || payment.status === 'creating' || payment.status === 'paid' || payment.needs_attention;
  return (
    <div className="flex flex-wrap gap-2">
      {open && (
        <Button size="sm" variant="secondary" loading={busy === 'refresh'} icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => void run('refresh')}>
          Atualizar pagamento
        </Button>
      )}
      {payment.needs_attention && (
        <Button size="sm" variant="ghost" loading={busy === 'ack'} icon={<CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => void run('ack')}>
          Marcar como conferido
        </Button>
      )}
    </div>
  );
}

// Detalhe de um pedido de pagamento online: situação, tentativas e (para o owner) comissão e tarifas.
export function OnlinePaymentCard({
  order,
  payments,
  owner,
  onChanged,
}: {
  order: Pick<Order, 'order_status' | 'payment_status' | 'total' | 'payment_method' | 'payment_fee' | 'payment_fee_bps' | 'payment_fee_fixed' | 'subtotal' | 'delivery_fee' | 'discount'>;
  payments: AdminPayment[];
  owner: boolean;
  onChanged: () => void;
}) {
  const last = payments[payments.length - 1];
  const card = order.payment_method === 'card_online';
  // Pedidos de Pix feitos depois da taxa de serviço trazem o valor dela; os de antes (taxa 0) continuam sem o quadro.
  const pixFee = order.payment_method === 'pix_online' && Number(order.payment_fee) > 0;
  const feeLabel = card ? 'Taxa do cartão (paga pelo cliente)' : 'Taxa de serviço do Pix (paga pelo cliente)';
  return (
    <Card title={card ? 'Pagamento online (cartão de crédito)' : 'Pagamento online (Pix)'}>
      <p className="text-sm text-white/75">
        {card
          ? 'O cliente paga no cartão pelo site (o cartão passa direto pela operadora, nunca pela loja), cobrado na subconta do estabelecimento, sem divisão (split), e a operadora confirma. '
          : 'O cliente paga pelo site e a operadora de pagamento confirma. '}O status não pode ser alterado à mão: use “Atualizar pagamento” para
        consultar a operadora.
      </p>
      {(card || pixFee) && (
        <dl data-card-breakdown={card ? 'card' : 'pix'} className="mt-3 space-y-1 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-xs">
          <div className="flex justify-between text-white/65">
            <dt>Subtotal</dt>
            <dd className="tabular-nums">{money(Number(order.subtotal))}</dd>
          </div>
          <div className="flex justify-between text-white/65">
            <dt>Entrega</dt>
            <dd className="tabular-nums">{money(Number(order.delivery_fee))}</dd>
          </div>
          {Number(order.discount) > 0 && (
            <div className="flex justify-between text-white/65">
              <dt>Desconto</dt>
              <dd className="tabular-nums">− {money(Number(order.discount))}</dd>
            </div>
          )}
          <div className="flex justify-between text-white/85">
            <dt>
              {feeLabel}
              {owner && order.payment_fee_bps !== null && order.payment_fee_bps !== undefined && (
                <span className="ml-1 text-white/50">
                  · {percentFromBps(order.payment_fee_bps)}
                  {card ? ` + ${money(Number(order.payment_fee_fixed ?? 0))}` : ''} usados no cálculo
                </span>
              )}
            </dt>
            <dd className="tabular-nums">{money(Number(order.payment_fee))}</dd>
          </div>
          <div className="flex justify-between border-t border-white/[0.08] pt-1 font-bold text-white">
            <dt>{card ? 'Total cobrado no cartão' : 'Total cobrado no Pix'}</dt>
            <dd className="tabular-nums">{money(Number(order.total))}</dd>
          </div>
        </dl>
      )}
      {!last ? (
        <p className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-white/65">
          {order.order_status === 'awaiting_payment' ? (card ? 'O cliente ainda não pagou com o cartão.' : 'O cliente ainda não gerou o Pix.') : 'Nenhuma cobrança foi criada para este pedido.'}
        </p>
      ) : (
        <ul className="mt-3 space-y-3" aria-label="Cobranças do pedido">
          {[...payments].reverse().map((p) => (
            <li key={p.id} data-payment={p.status} className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-white">
                  Tentativa {p.attempt} · {cents(p.amount_cents)}
                </p>
                <PaymentStateBadge status={p.status} method={p.method} />
              </div>
              <p className="mt-1 text-xs text-white/55">
                Criada {formatDateTime(p.created_at)}
                {p.paid_at ? ` · paga ${formatDateTime(p.paid_at)}` : p.expires_at && p.status === 'pending' ? ` · vence ${formatDateTime(p.expires_at)}` : ''}
              </p>
              {p.needs_attention && (
                <p role="status" className="mt-2 flex items-start gap-2 rounded-lg bg-amber-400/10 px-2.5 py-2 text-xs text-amber-100 ring-1 ring-amber-400/30">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{owner ? (taxaWording(p.attention_reason) || 'Precisa de conferência.') : 'Este pagamento precisa de conferência do dono da loja.'}</span>
                </p>
              )}
              {owner && (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  {p.method === 'card' ? (
                    <>
                      <dt className="text-white/50">Valor cobrado</dt>
                      <dd className="text-white/85">{cents(p.amount_cents)}</dd>
                      <dt className="text-white/50">Taxa do cartão (cliente)</dt>
                      <dd className="text-white/85">{cents(p.customer_fee_cents ?? 0)}</dd>
                      <dt className="text-white/50">Envios à operadora</dt>
                      <dd className="text-white/85">{p.card_attempts ?? 1}</dd>
                    </>
                  ) : (
                    <>
                      <dt className="text-white/50">Taxa ({percentFromBps(p.commission_bps)})</dt>
                      <dd className="text-white/85">
                        {cents(p.commission_cents)} <CommissionBadge state={p.commission_state ?? 'calculated'} />
                        {p.commission_state === 'confirmed' && <span className="ml-1 text-white/55">({cents(p.commission_confirmed_cents)} repassados)</span>}
                      </dd>
                      {(p.customer_fee_cents ?? 0) > 0 && (
                        <>
                          <dt className="text-white/50">Quem paga a taxa</dt>
                          <dd className="text-white/85" data-pix-fee-split>
                            cliente {cents(p.customer_fee_cents ?? 0)} · estabelecimento {cents(Math.max(0, (p.commission_cents ?? 0) - (p.customer_fee_cents ?? 0)))}
                          </dd>
                        </>
                      )}
                    </>
                  )}
                  <dt className="text-white/50">{p.method === 'card' ? 'Tarifa da operadora' : 'Tarifas'}</dt>
                  <dd className="text-white/85">{p.fee_cents === null || p.fee_cents === undefined ? 'a operadora ainda não informou' : cents(p.fee_cents)}</dd>
                  <dt className="text-white/50">Líquido</dt>
                  <dd className="text-white/85">{p.net_cents === null || p.net_cents === undefined ? '—' : cents(p.net_cents)}</dd>
                  {(p.refunded_cents ?? 0) > 0 && (
                    <>
                      <dt className="text-white/50">Devolvido</dt>
                      <dd className="text-white/85">{cents(p.refunded_cents)}</dd>
                    </>
                  )}
                  <dt className="text-white/50">Código na operadora</dt>
                  <dd className="font-mono text-white/70" title="Identificador da cobrança na operadora">
                    {shortId(p.provider_charge_id)}
                  </dd>
                </dl>
              )}
              {owner && <div className="mt-3"><PaymentActions payment={p} onChanged={onChanged} /></div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export const when = (iso: string | null | undefined) => (iso ? formatDateTime(iso) : '—');
