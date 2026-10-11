import { CheckCheck, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { api, friendlyError } from '../lib/api';
import { formatDateTime, money } from '../lib/format';
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

export function PaymentStateBadge({ status }: { status: PaymentState }) {
  return <Badge tone={STATE_TONE[status]}>{PAYMENT_STATE_LABEL[status]}</Badge>;
}

// A comissão só é "efetivada" quando a operadora confirma o valor repassado; antes disso é só uma conta.
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
export function OnlinePaymentCard({ order, payments, owner, onChanged }: { order: Pick<Order, 'order_status' | 'payment_status' | 'total'>; payments: AdminPayment[]; owner: boolean; onChanged: () => void }) {
  const last = payments[payments.length - 1];
  return (
    <Card title="Pagamento online (Pix)">
      <p className="text-sm text-white/75">
        O cliente paga pelo site e a operadora de pagamento confirma. O status não pode ser alterado à mão: use “Atualizar pagamento” para consultar a operadora.
      </p>
      {!last ? (
        <p className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-white/65">
          {order.order_status === 'awaiting_payment' ? 'O cliente ainda não gerou o Pix.' : 'Nenhuma cobrança foi criada para este pedido.'}
        </p>
      ) : (
        <ul className="mt-3 space-y-3" aria-label="Cobranças do pedido">
          {[...payments].reverse().map((p) => (
            <li key={p.id} data-payment={p.status} className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-white">
                  Tentativa {p.attempt} · {cents(p.amount_cents)}
                </p>
                <PaymentStateBadge status={p.status} />
              </div>
              <p className="mt-1 text-xs text-white/55">
                Criada {formatDateTime(p.created_at)}
                {p.paid_at ? ` · paga ${formatDateTime(p.paid_at)}` : p.expires_at && p.status === 'pending' ? ` · vence ${formatDateTime(p.expires_at)}` : ''}
              </p>
              {p.needs_attention && (
                <p role="status" className="mt-2 flex items-start gap-2 rounded-lg bg-amber-400/10 px-2.5 py-2 text-xs text-amber-100 ring-1 ring-amber-400/30">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{owner ? (p.attention_reason ?? 'Precisa de conferência.') : 'Este pagamento precisa de conferência do dono da loja.'}</span>
                </p>
              )}
              {owner && (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-white/50">Comissão ({(p.commission_bps ?? 0) / 100}%)</dt>
                  <dd className="text-white/85">
                    {cents(p.commission_cents)} <CommissionBadge state={p.commission_state ?? 'calculated'} />
                    {p.commission_state === 'confirmed' && <span className="ml-1 text-white/55">({cents(p.commission_confirmed_cents)} repassados)</span>}
                  </dd>
                  <dt className="text-white/50">Tarifas</dt>
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
