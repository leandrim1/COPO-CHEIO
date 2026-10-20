import { RotateCcw, Search } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, friendlyError } from '../lib/api';
import type { AdminPayment, RefundReason, RefundRow, RefundState } from '../lib/types';
import { cents, when } from './OnlinePayment';
import { Badge, Button, Field, INPUT, Modal, useToast } from './ui';

// Devolução (estorno) de um pagamento online, só para o owner. A regra que o texto abaixo repete é a do servidor: o valor só é "devolvido" quando a operadora CONFIRMA.

const REASONS: { value: RefundReason; label: string; pixOnly?: boolean }[] = [
  { value: 'CUSTOMER_REQUEST', label: 'Pedido do cliente' },
  { value: 'FRAUD', label: 'Suspeita de fraude' },
  { value: 'BANK_ERROR', label: 'Erro bancário' },
  { value: 'PIX_CHANGE_ERROR', label: 'Erro na transação Pix', pixOnly: true },
];

const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.value, r.label])) as Record<RefundReason, string>;

const STATE: Record<RefundState, { label: string; tone: 'blue' | 'green' | 'amber' | 'red' | 'gray'; help: string }> = {
  requested: { label: 'Sem resposta da operadora', tone: 'amber', help: 'Não se sabe se a operadora recebeu o pedido. Use “Conferir devolução” antes de pedir de novo.' },
  processing: { label: 'Aguardando a operadora', tone: 'amber', help: 'A operadora recebeu o pedido e ainda não confirmou que o valor voltou.' },
  confirmed: { label: 'Devolução confirmada', tone: 'green', help: 'A operadora confirmou que o valor voltou ao pagador.' },
  failed: { label: 'Não foi devolvida', tone: 'red', help: 'A operadora recusou ou a devolução falhou. Nada foi devolvido por este pedido.' },
};

const openRefund = (refunds: RefundRow[]) => refunds.some((r) => r.status === 'requested' || r.status === 'processing');

// "12,50" ou "12.5" (vazio = tudo o que falta). Só valida o formato; o servidor confere limites e estado.
const looksLikeAmount = (text: string) => text.trim() === '' || /^(R\$\s*)?\d{1,6}([.,]\d{1,2})?$/i.test(text.trim());

export function RefundPanel({ payment, onChanged }: { payment: AdminPayment; onChanged: () => void }) {
  const toast = useToast();
  const refunds = payment.refunds ?? [];
  const left = Math.max(0, payment.amount_cents - (payment.refunded_cents ?? 0));
  const open = openRefund(refunds);
  const available = payment.refund_available === true;
  const canAsk = available && payment.status === 'paid' && left > 0 && !open && Boolean(payment.provider_charge_id);

  const [dialog, setDialog] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<RefundReason | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'ask' | 'check' | null>(null);

  if (payment.status !== 'paid' && payment.status !== 'refunded' && refunds.length === 0) return null;

  const reasons = REASONS.filter((r) => !r.pixOnly || payment.method === 'pix');
  const leftText = (left / 100).toFixed(2).replace('.', ',');

  const start = () => {
    setAmount(leftText);
    setReason('');
    setNote('');
    setError(null);
    setDialog(true);
  };

  const ask = async () => {
    if (!reason) return setError('Escolha o motivo da devolução.');
    if (!looksLikeAmount(amount)) return setError('Informe o valor em reais (ex.: 12,50).');
    setError(null);
    setBusy('ask');
    try {
      const result = await api.post<{ outcome: 'processing' | 'confirmed' | 'failed' | 'unknown'; message: string }>(`/api/admin/payments/${payment.id}/refund`, {
        amount: amount.trim() === '' ? null : amount.trim(),
        reason,
        note: note.trim() || undefined,
      });
      setDialog(false);
      if (result.outcome === 'confirmed') toast.success('Devolução confirmada pela operadora.', `Pedido #${payment.order_number}`);
      else if (result.outcome === 'failed') toast.error('A operadora não fez a devolução.', result.message);
      else toast.push({ kind: 'info', title: result.outcome === 'processing' ? 'Pedido de devolução enviado.' : 'Sem resposta da operadora.', description: result.message });
      onChanged();
    } catch (e) {
      setError(friendlyError(e, 'Não foi possível pedir a devolução.'));
      if (e instanceof ApiError && e.status === 409) onChanged();
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy('check');
    try {
      const result = await api.post<{ changed: boolean }>(`/api/admin/payments/${payment.id}/refunds/check`);
      toast.push({ kind: 'info', title: result.changed ? 'Devolução atualizada.' : 'Nada mudou na operadora.', description: `Pedido #${payment.order_number}` });
      onChanged();
    } catch (e) {
      toast.error('Não foi possível conferir a devolução.', friendlyError(e, ''));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-refund-panel className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-white/60">Devolução do pagamento</p>
        <div className="flex flex-wrap gap-2">
          {open && (
            <Button size="sm" variant="secondary" loading={busy === 'check'} icon={<Search className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => void check()} data-refund-check>
              Conferir devolução
            </Button>
          )}
          {canAsk && (
            <Button size="sm" variant="danger-ghost" icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />} onClick={start} data-refund-open>
              Devolver pagamento
            </Button>
          )}
        </div>
      </div>

      {refunds.length === 0 ? (
        <p className="mt-2 text-xs text-white/55" data-refund-empty>
          {available || payment.status !== 'paid'
            ? 'Nenhuma devolução pedida por aqui. O valor só aparece como devolvido depois que a operadora confirmar.'
            : 'A devolução pelo painel está desligada. Para devolver, use o painel da ValidaPay e depois “Atualizar pagamento”: o valor só aparece como devolvido quando a operadora informar.'}
        </p>
      ) : (
        <ul className="mt-2 space-y-2" aria-label="Devoluções do pagamento">
          {[...refunds].reverse().map((r) => (
            <li key={r.id} data-refund={r.status} className="rounded-lg bg-white/[0.03] px-2.5 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold text-white">
                  {cents(r.amount_cents)} · {REASON_LABEL[r.reason] ?? r.reason}
                </span>
                <Badge tone={STATE[r.status].tone}>{STATE[r.status].label}</Badge>
              </div>
              <p className="mt-1 text-white/55">
                Pedida {when(r.requested_at)}
                {r.requested_by_name ? ` por ${r.requested_by_name}` : ''}
                {r.confirmed_at ? ` · confirmada ${when(r.confirmed_at)}` : ''}
              </p>
              <p className="mt-1 text-white/65">{STATE[r.status].help}</p>
              {r.note && <p className="mt-1 text-white/55">Anotação: {r.note}</p>}
              {r.status === 'failed' && r.last_error && <p className="mt-1 text-rose-200">{r.last_error}</p>}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={dialog}
        onClose={() => (busy ? undefined : setDialog(false))}
        size="sm"
        title="Devolver pagamento"
        description={`Pedido #${payment.order_number} · ainda dá para devolver ${cents(left)}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(false)} disabled={busy === 'ask'}>
              Cancelar
            </Button>
            <Button variant="danger" loading={busy === 'ask'} onClick={() => void ask()} data-refund-submit>
              Pedir devolução
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="rounded-xl bg-amber-400/10 px-3 py-2.5 text-xs leading-relaxed text-amber-100 ring-1 ring-amber-400/30">
            O pedido vai para a operadora de pagamento. A loja só marca o valor como devolvido quando a operadora <strong>confirmar</strong>; até lá fica “aguardando”. Depois de enviado, o
            pedido não pode ser desfeito por aqui.
          </p>
          <Field label="Valor a devolver (R$)" hint="Deixe o valor cheio para devolver tudo o que falta, ou digite uma parte.">
            {(props) => <input {...props} className={INPUT} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} data-refund-amount />}
          </Field>
          <Field label="Motivo">
            {(props) => (
              <select {...props} className={INPUT} value={reason} onChange={(e) => setReason(e.target.value as RefundReason | '')} data-refund-reason>
                <option value="">Escolha…</option>
                {reasons.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Anotação (opcional)" count={note.length} max={200}>
            {(props) => <input {...props} className={INPUT} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} data-refund-note />}
          </Field>
          {error && (
            <p role="alert" data-refund-error className="text-sm font-medium text-rose-300">
              {error}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
