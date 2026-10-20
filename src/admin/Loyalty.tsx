import { Star } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, friendlyError } from '../lib/api';
import { formatDateTime, money, moneyInput, parseMoney } from '../lib/format';
import { Badge, Button, Card, EmptyState, ErrorState, Field, INPUT, PageHeader, Skeleton, Switch, useToast } from './ui';

// Programa de pontos (só o owner). Nasce DESLIGADO e sem valores: as regras são suas. O servidor credita os pontos quando o pedido de uma conta é entregue, estorna se o pagamento é
// devolvido e faz a troca por cupom pessoal; aqui é só o formulário, o resumo e o acerto manual.

type Rules = { enabled: boolean; points_per_real: number | null; redeem_points: number | null; reward_value: number | null; coupon_days: number | null };
type Movement = { kind: 'earn' | 'reverse' | 'redeem' | 'adjust'; points: number; note: string | null; created_at: string; customer_name: string; customer_email: string; order_number: number | null };
type Data = { settings: Rules; totals: { outstanding: number; customers_with_points: number }; movements: Movement[] };

const KIND: Record<Movement['kind'], string> = { earn: 'Crédito', reverse: 'Estorno', redeem: 'Troca', adjust: 'Acerto' };

export default function LoyaltyPage() {
  const toast = useToast();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [form, setForm] = useState({ enabled: false, per: '', redeem: '', reward: '', days: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [adjust, setAdjust] = useState({ email: '', points: '', note: '' });
  const [adjusting, setAdjusting] = useState(false);
  const [adjustError, setAdjustError] = useState('');

  const fill = (r: Rules) => setForm({ enabled: r.enabled, per: r.points_per_real === null ? '' : moneyInput(r.points_per_real), redeem: r.redeem_points === null ? '' : String(r.redeem_points), reward: r.reward_value === null ? '' : moneyInput(r.reward_value), days: r.coupon_days === null ? '' : String(r.coupon_days) });
  const load = useCallback(async () => {
    try {
      const d = await api.get<Data>('/api/admin/loyalty');
      setData(d);
      fill(d.settings);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    const per = form.per.trim() ? parseMoney(form.per) : null;
    const reward = form.reward.trim() ? parseMoney(form.reward) : null;
    const redeem = form.redeem.trim() ? Number(form.redeem) : null;
    const days = form.days.trim() ? Number(form.days) : null;
    if ((form.per.trim() && per === null) || (form.reward.trim() && reward === null)) return setFormError('Confira os valores: use números, como 1 ou 5,00.');
    setSaving(true);
    try {
      const res = await api.put<{ settings: Rules }>('/api/admin/loyalty/settings', { loyalty_enabled: form.enabled, loyalty_points_per_real: per, loyalty_redeem_points: redeem, loyalty_reward_value: reward, loyalty_coupon_days: days });
      setData((d) => (d ? { ...d, settings: res.settings } : d));
      fill(res.settings);
      toast.success('Regras salvas.', res.settings.enabled ? 'O programa de pontos está ligado.' : 'O programa de pontos está desligado.');
    } catch (err) {
      setFormError(friendlyError(err, 'Não foi possível salvar.'));
    } finally {
      setSaving(false);
    }
  };

  const doAdjust = async (e: FormEvent) => {
    e.preventDefault();
    setAdjustError('');
    const points = Number(adjust.points);
    if (!Number.isInteger(points) || points === 0) return setAdjustError('Pontos: informe um número inteiro, positivo para dar e negativo para tirar.');
    setAdjusting(true);
    try {
      const res = await api.post<{ balance: number }>('/api/admin/loyalty/adjust', { email: adjust.email.trim(), points, note: adjust.note.trim() });
      toast.success('Acerto registrado.', `Novo saldo: ${res.balance.toLocaleString('pt-BR')} pontos.`);
      setAdjust({ email: '', points: '', note: '' });
      void load();
    } catch (err) {
      setAdjustError(friendlyError(err, 'Não foi possível registrar o acerto.'));
    } finally {
      setAdjusting(false);
    }
  };

  return (
    <div data-loyalty-admin>
      <PageHeader title="Fidelidade (pontos)" description="Os clientes com conta ganham pontos quando o pedido é entregue e trocam por um cupom pessoal. Nada está ligado até você definir as regras." />
      {error && !data ? (
        <Card>
          <ErrorState message="Não foi possível carregar o programa de pontos." onRetry={() => void load()} />
        </Card>
      ) : !data ? (
        <div className="space-y-3">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <form onSubmit={save} noValidate className="lg:col-span-2">
            <Card title="Regras" description="Só você define. Ligar exige as quatro regras preenchidas.">
              <div className="space-y-4">
                <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Programa de pontos ligado" description="Desligado, ninguém ganha nem troca pontos (os saldos ficam guardados)." />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Pontos por R$ 1,00 em produtos" hint="Só os itens depois do desconto; entrega e taxas não contam.">
                    {(p) => <input {...p} className={INPUT} inputMode="decimal" value={form.per} onChange={(e) => setForm({ ...form, per: e.target.value })} placeholder="ex.: 1" data-loyalty-per />}
                  </Field>
                  <Field label="Pontos para trocar por um cupom">
                    {(p) => <input {...p} className={INPUT} inputMode="numeric" value={form.redeem} onChange={(e) => setForm({ ...form, redeem: e.target.value })} placeholder="ex.: 100" data-loyalty-redeem />}
                  </Field>
                  <Field label="Valor do cupom (R$)" hint="Cupom de valor fixo, de uso único, só da conta do cliente.">
                    {(p) => <input {...p} className={INPUT} inputMode="decimal" value={form.reward} onChange={(e) => setForm({ ...form, reward: e.target.value })} placeholder="ex.: 5,00" data-loyalty-reward />}
                  </Field>
                  <Field label="Validade do cupom (dias)">
                    {(p) => <input {...p} className={INPUT} inputMode="numeric" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} placeholder="ex.: 30" data-loyalty-days />}
                  </Field>
                </div>
                {formError && (
                  <p role="alert" data-loyalty-error className="text-sm font-medium text-rose-300">
                    {formError}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button type="submit" loading={saving} data-loyalty-save>
                    Salvar regras
                  </Button>
                </div>
              </div>
            </Card>
          </form>

          <Card title="Resumo">
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-white/55">Estado</dt>
                <dd className="mt-1">{data.settings.enabled ? <Badge tone="green">Ligado</Badge> : <Badge>Desligado</Badge>}</dd>
              </div>
              <div>
                <dt className="text-white/55">Pontos em circulação</dt>
                <dd className="mt-1 text-lg font-black text-white" data-loyalty-outstanding>
                  {data.totals.outstanding.toLocaleString('pt-BR')}
                </dd>
              </div>
              <div>
                <dt className="text-white/55">Clientes com saldo</dt>
                <dd className="mt-1 text-lg font-black text-white">{data.totals.customers_with_points}</dd>
              </div>
              {data.settings.redeem_points && data.settings.reward_value ? (
                <div>
                  <dt className="text-white/55">Custo se todos trocarem</dt>
                  <dd className="mt-1 text-lg font-black text-white">{money((data.totals.outstanding / data.settings.redeem_points) * data.settings.reward_value)}</dd>
                </div>
              ) : null}
            </dl>
            <p className="mt-4 text-xs text-white/50">Se um pagamento é devolvido depois de os pontos serem creditados, o crédito é estornado. O saldo pode ficar negativo quando os pontos já foram trocados.</p>
          </Card>

          <form onSubmit={doAdjust} noValidate>
            <Card title="Acerto manual" description="Dar ou tirar pontos de uma conta, sempre com motivo. Fica no registro de atividades.">
              <div className="space-y-3">
                <Field label="E-mail da conta">{(p) => <input {...p} type="email" className={INPUT} value={adjust.email} onChange={(e) => setAdjust({ ...adjust, email: e.target.value })} data-adjust-email />}</Field>
                <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
                  <Field label="Pontos (+/−)">{(p) => <input {...p} className={INPUT} inputMode="numeric" value={adjust.points} onChange={(e) => setAdjust({ ...adjust, points: e.target.value })} placeholder="50 ou -50" data-adjust-points />}</Field>
                  <Field label="Motivo">{(p) => <input {...p} className={INPUT} maxLength={120} value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} data-adjust-note />}</Field>
                </div>
                {adjustError && (
                  <p role="alert" data-adjust-error className="text-sm font-medium text-rose-300">
                    {adjustError}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button type="submit" variant="secondary" loading={adjusting} data-adjust-save>
                    Registrar acerto
                  </Button>
                </div>
              </div>
            </Card>
          </form>

          <Card title="Movimentos recentes" description="Os 50 mais novos, de todas as contas." className="lg:col-span-2" padded={false}>
            {data.movements.length === 0 ? (
              <EmptyState icon={<Star className="h-6 w-6" aria-hidden="true" />} title="Nenhum movimento ainda" description="Os pontos aparecem aqui quando o primeiro pedido de uma conta for entregue com o programa ligado." />
            ) : (
              <ul className="divide-y divide-white/[0.06]" data-loyalty-movements>
                {data.movements.map((m, i) => (
                  <li key={`${m.created_at}-${i}`} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5 text-sm sm:px-5">
                    <Badge tone={m.points > 0 ? 'green' : 'amber'}>{KIND[m.kind]}</Badge>
                    <span className="min-w-0 flex-1 basis-48">
                      <span className="block truncate font-semibold text-white">{m.customer_name}</span>
                      <span className="block truncate text-xs text-white/50">
                        {m.customer_email}
                        {m.order_number ? ` · pedido #${m.order_number}` : ''}
                        {m.note ? ` · ${m.note}` : ''}
                      </span>
                    </span>
                    <span className="text-xs text-white/45">{formatDateTime(m.created_at)}</span>
                    <span className={`w-20 text-right font-bold tabular-nums ${m.points > 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                      {m.points > 0 ? '+' : ''}
                      {m.points.toLocaleString('pt-BR')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
