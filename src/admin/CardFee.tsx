import { CreditCard, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, friendlyError } from '../lib/api';
import { cardFeeCents, parseMoneyToCents, parsePercentToBps } from '../lib/cardFee';
import { formatDateTime, money } from '../lib/format';
import type { CardFeeSettings, PaymentsOverview } from '../lib/types';
import { Badge, Button, Card, Field, INPUT, Switch, useToast } from './ui';

// Cartão de crédito online (só o owner): a taxa de processamento repassada ao cliente e o botão que liga o cartão no checkout.
//
// Os valores de referência (5,37% + R$ 0,37) vêm do pedido da loja; NÃO são lidos de nenhuma documentação ou contrato da ValidaPay. Por isso o cartão
// só liga depois que o owner marca que CONFERIU os valores com o contrato/painel da ValidaPay (o servidor registra quem e quando, e tira a
// conferência de qualquer valor que mude).

const reaisFromCents = (value: number) => (value / 100).toFixed(2).replace('.', ',');
const percentFromBps = (value: number) => (value / 100).toFixed(2).replace('.', ',');

export function CardFeeCard({ overview, onChanged }: { overview: PaymentsOverview; onChanged: () => void }) {
  const toast = useToast();
  const [fee, setFee] = useState<CardFeeSettings | null>(null);
  const [percent, setPercent] = useState('');
  const [fixed, setFixed] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'save' | 'toggle' | null>(null);
  const [errors, setErrors] = useState<{ percent?: string; fixed?: string }>({});

  const load = useCallback(async () => {
    try {
      const next = await api.get<CardFeeSettings>('/api/admin/payment-fees/card');
      setFee(next);
      setPercent(percentFromBps(next.bps));
      setFixed(reaisFromCents(next.fixed_cents));
      setConfirmed(false);
    } catch {
      /* a página de Pagamentos já mostra o erro de carregamento */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const method = overview.card.method;
  const enabled = method?.enabled ?? false;
  const bps = parsePercentToBps(percent);
  const fixedCents = parseMoneyToCents(fixed);
  const valid = bps !== null && fixedCents !== null;
  const changed = fee !== null && valid && (bps !== fee.bps || fixedCents !== fee.fixed_cents);
  const rate = valid ? { bps, fixedCents } : null;
  // Exemplos ao vivo com o que está digitado: o dono vê o efeito antes de salvar.
  const examples = rate ? [1000, 5000, 10000].map((base) => ({ base, fee: cardFeeCents(base, rate) })) : [];

  const save = async () => {
    const next: typeof errors = {};
    if (bps === null) next.percent = 'Use o formato 5,37 (de 0 a 25).';
    if (fixedCents === null) next.fixed = 'Use o formato 0,37 (de 0 a 10,00).';
    setErrors(next);
    if (bps === null || fixedCents === null) return;
    setBusy('save');
    try {
      const saved = await api.patch<CardFeeSettings>('/api/admin/payment-fees/card', { percent: percent.trim(), fixed: fixed.trim(), confirmed });
      setFee(saved);
      setPercent(percentFromBps(saved.bps));
      setFixed(reaisFromCents(saved.fixed_cents));
      setConfirmed(false);
      toast.success(saved.confirmed_at ? 'Taxa do cartão salva e conferida.' : 'Taxa do cartão salva (ainda não conferida).', 'O checkout já usa estes valores.');
      onChanged();
    } catch (error) {
      toast.error('Não foi possível salvar a taxa.', friendlyError(error, ''));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (on: boolean) => {
    setBusy('toggle');
    try {
      await api.patch('/api/admin/payments/card_online', { enabled: on });
      toast.success(on ? 'Cartão online ligado.' : 'Cartão online desligado.', on ? 'O cliente já pode pagar no cartão pelo site, com a taxa do cartão no total.' : 'O site deixou de oferecer essa opção.');
      onChanged();
    } catch (error) {
      toast.error('Não foi possível alterar.', friendlyError(error, ''));
    } finally {
      setBusy(null);
    }
  };

  const readiness = overview.card.readiness;
  const alreadyConfirmed = fee?.confirmed_at != null;

  return (
    <Card
      className="mt-4"
      title="Cartão de crédito online"
      description="O cliente paga no cartão pelo site e a taxa de processamento do cartão é somada ao total, mostrada antes de ele confirmar. A cobrança do cartão é feita na conta principal da ValidaPay, separada do Pix: sem divisão (split) e sem depender da subconta. O Pix e os pagamentos na entrega não têm essa taxa."
    >
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[14rem_1fr]">
        <dt className="font-semibold text-white/60">Cartão online no site</dt>
        <dd data-card-method={enabled ? 'on' : 'off'}>
          <Switch checked={enabled} disabled={busy === 'toggle' || (!readiness.ready && !enabled)} onChange={(v) => void toggle(v)} ariaLabel="Oferecer cartão de crédito online no checkout" />
          <p className="mt-1.5 text-xs text-white/55">
            {enabled
              ? 'Ligado: o cliente pode escolher “Cartão online” ao finalizar o pedido.'
              : readiness.ready
                ? 'Desligado. Ligue para o cliente poder pagar no cartão pelo site.'
                : 'Indisponível: ainda falta o que está listado abaixo.'}
          </p>
          {!readiness.ready && (
            <ul data-card-missing={readiness.missing.join(',')} className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-amber-100">
              {readiness.missing.map((item) => (
                <li key={item}>
                  {item === 'VALIDAPAY_PUBLIC_ID' ? (
                    <>
                      Variável <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11px]">VALIDAPAY_PUBLIC_ID</code> no servidor (Id Público da conta: ValidaPay → Gerenciamento → Minha Conta)
                    </>
                  ) : (
                    item
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>

      <div className="mt-5 border-t border-white/[0.08] pt-5">
        <h3 className="flex items-center gap-2 text-sm font-black text-white">
          <CreditCard className="h-4 w-4 text-[#8FB1FF]" aria-hidden="true" /> Taxa do cartão repassada ao cliente
          {fee &&
            (alreadyConfirmed ? (
              <Badge tone="green">Conferida</Badge>
            ) : (
              <Badge tone="amber">Ainda NÃO conferida</Badge>
            ))}
        </h3>
        <p className="mt-1 text-xs text-white/60">
          Percentual e tarifa fixa que a operadora cobra de você em cada venda no cartão. O cliente paga a taxa para você receber o valor do pedido inteiro:{' '}
          <span className="text-white/80">total = (pedido + tarifa fixa) ÷ (1 − percentual)</span>, em centavos.
        </p>
        <p role="note" className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2.5 text-xs text-amber-100">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Os valores 5,37% + R$ 0,37 são os de referência informados pela loja. <strong>Confira no painel ou no contrato da ValidaPay</strong> (e o prazo de recebimento, D+1, habilitado na sua conta principal) antes de ligar o cartão em produção. Se a tarifa
            real for diferente, a loja paga ou cobra a mais a diferença.
          </span>
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 sm:max-w-md">
          <Field label="Percentual (%)" hint="Ex.: 5,37" error={errors.percent}>
            {(p) => (
              <input
                {...p}
                value={percent}
                inputMode="decimal"
                onChange={(e) => {
                  setPercent(e.target.value);
                  setErrors((x) => ({ ...x, percent: undefined }));
                }}
                className={INPUT}
              />
            )}
          </Field>
          <Field label="Tarifa fixa por venda (R$)" hint="Ex.: 0,37" error={errors.fixed}>
            {(p) => (
              <input
                {...p}
                value={fixed}
                inputMode="decimal"
                onChange={(e) => {
                  setFixed(e.target.value);
                  setErrors((x) => ({ ...x, fixed: undefined }));
                }}
                className={INPUT}
              />
            )}
          </Field>
        </div>

        {examples.length > 0 && (
          <table data-card-examples className="mt-4 w-full max-w-md text-left text-xs">
            <caption className="mb-1 text-left font-semibold text-white/60">Como fica para o cliente (com estes valores)</caption>
            <thead className="text-white/50">
              <tr>
                <th className="py-1 pr-3 font-semibold">Pedido</th>
                <th className="py-1 pr-3 font-semibold">Taxa do cartão</th>
                <th className="py-1 font-semibold">Total no cartão</th>
              </tr>
            </thead>
            <tbody className="tabular-nums text-white/85">
              {examples.map((row) => (
                <tr key={row.base} className="border-t border-white/[0.06]">
                  <td className="py-1 pr-3">{money(row.base / 100)}</td>
                  <td className="py-1 pr-3">{money(row.fee / 100)}</td>
                  <td className="py-1 font-bold">{money((row.base + row.fee) / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <label className="mt-4 flex max-w-xl items-start gap-2.5 text-sm text-white/85">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#145CFF]" data-card-confirm />
          <span>
            <strong>Conferi estes valores no contrato ou painel da ValidaPay.</strong> Só assim o cartão online pode ser ligado.
          </span>
        </label>
        {changed && enabled && !confirmed && <p className="mt-2 text-xs text-amber-200">O cartão está ligado: para mudar a taxa, marque que conferiu os novos valores.</p>}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button loading={busy === 'save'} disabled={!valid || (!changed && !confirmed)} icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />} onClick={() => void save()} data-card-save>
            {changed ? 'Salvar taxa' : 'Confirmar conferência'}
          </Button>
          {fee?.confirmed_at && (
            <p className="text-xs text-white/55">
              Conferida {formatDateTime(fee.confirmed_at)}
              {fee.confirmed_by_name ? ` por ${fee.confirmed_by_name}` : ''}.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
