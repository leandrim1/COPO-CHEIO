import { Pencil, Plus, Ticket, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, friendlyError } from '../lib/api';
import { formatDateTime, money, moneyInput, parseMoney } from '../lib/format';
import type { Category, Coupon, CouponKind } from '../lib/types';
import { Badge, Button, Card, EmptyState, ErrorState, Field, INPUT, IconButton, Modal, PageHeader, Skeleton, Switch, useConfirm, useToast } from './ui';

// Cupons de desconto (só o owner). Tudo é conferido de novo no servidor: aqui é só o formulário.

const KIND_LABEL: Record<CouponKind, string> = { percent: 'Porcentagem (%)', fixed: 'Valor fixo (R$)', free_delivery: 'Frete grátis' };

type Form = {
  id?: string;
  code: string;
  description: string;
  kind: CouponKind;
  value: string;
  max_discount: string;
  min_order: string;
  starts_at: string;
  ends_at: string;
  usage_limit: string;
  per_customer_limit: string;
  excludes_promo: boolean;
  active: boolean;
  category_ids: string[];
};

const EMPTY: Form = {
  code: '',
  description: '',
  kind: 'percent',
  value: '10',
  max_discount: '',
  min_order: '',
  starts_at: '',
  ends_at: '',
  usage_limit: '',
  per_customer_limit: '',
  excludes_promo: false,
  active: true,
  category_ids: [],
};

// ISO (UTC) → "AAAA-MM-DDTHH:mm" no fuso do aparelho, para o campo de data e hora.
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fromCoupon = (c: Coupon): Form => ({
  id: c.id,
  code: c.code,
  description: c.description ?? '',
  kind: c.kind,
  value: c.kind === 'free_delivery' ? '' : c.kind === 'percent' ? String(Number(c.value)) : moneyInput(Number(c.value)),
  max_discount: c.max_discount === null ? '' : moneyInput(Number(c.max_discount)),
  min_order: Number(c.min_order) > 0 ? moneyInput(Number(c.min_order)) : '',
  starts_at: toLocalInput(c.starts_at),
  ends_at: toLocalInput(c.ends_at),
  usage_limit: c.usage_limit === null ? '' : String(c.usage_limit),
  per_customer_limit: c.per_customer_limit === null ? '' : String(c.per_customer_limit),
  excludes_promo: c.excludes_promo,
  active: c.active,
  category_ids: c.category_ids,
});

const summary = (c: Coupon) => {
  const what = c.kind === 'percent' ? `${Number(c.value)}% de desconto` : c.kind === 'fixed' ? `${money(Number(c.value))} de desconto` : 'Frete grátis';
  const cap = c.kind === 'percent' && c.max_discount !== null ? ` (até ${money(Number(c.max_discount))})` : '';
  const min = Number(c.min_order) > 0 ? ` · pedido a partir de ${money(Number(c.min_order))}` : '';
  return `${what}${cap}${min}`;
};

const state = (c: Coupon, now = Date.now()): { label: string; tone: 'green' | 'gray' | 'amber' | 'red' } => {
  if (!c.active) return { label: 'Desligado', tone: 'gray' };
  if (c.starts_at && new Date(c.starts_at).getTime() > now) return { label: 'Ainda não começou', tone: 'amber' };
  if (c.ends_at && new Date(c.ends_at).getTime() <= now) return { label: 'Vencido', tone: 'red' };
  if (c.usage_limit !== null && c.used >= c.usage_limit) return { label: 'Esgotado', tone: 'red' };
  return { label: 'Valendo', tone: 'green' };
};

export default function CouponsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Coupon[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, cats] = await Promise.all([api.get<{ coupons: Coupon[] }>('/api/admin/coupons'), api.get<{ categories: Category[] }>('/api/admin/categories')]);
      setError(false);
      setRows(list.coupons);
      setCategories(cats.categories);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const code = editing.code.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{2,29}$/.test(code)) return setFormError('O código precisa ter de 3 a 30 letras, números, hífen ou sublinhado (sem espaço nem acento).');
    let value = 0;
    if (editing.kind === 'percent') {
      value = Number(editing.value.replace(',', '.'));
      if (!Number.isFinite(value) || value < 1 || value > 100) return setFormError('A porcentagem precisa ficar entre 1 e 100.');
    } else if (editing.kind === 'fixed') {
      const parsed = parseMoney(editing.value);
      if (parsed === null || Number.isNaN(parsed) || parsed <= 0) return setFormError('Informe o valor do desconto em reais.');
      value = parsed;
    }
    const minOrder = editing.min_order.trim() ? parseMoney(editing.min_order) : 0;
    if (minOrder === null || Number.isNaN(minOrder)) return setFormError('O pedido mínimo está inválido.');
    const maxDiscount = editing.kind === 'percent' && editing.max_discount.trim() ? parseMoney(editing.max_discount) : null;
    if (editing.kind === 'percent' && editing.max_discount.trim() && (maxDiscount === null || Number.isNaN(maxDiscount) || maxDiscount <= 0)) return setFormError('O desconto máximo está inválido.');
    const usage = editing.usage_limit.trim() ? Number(editing.usage_limit) : null;
    const perCustomer = editing.per_customer_limit.trim() ? Number(editing.per_customer_limit) : null;
    if ((usage !== null && (!Number.isInteger(usage) || usage < 1)) || (perCustomer !== null && (!Number.isInteger(perCustomer) || perCustomer < 1))) return setFormError('Os limites de uso precisam ser números inteiros a partir de 1 (ou vazios).');
    const startsAt = editing.starts_at ? new Date(editing.starts_at) : null;
    const endsAt = editing.ends_at ? new Date(editing.ends_at) : null;
    if ((startsAt && Number.isNaN(startsAt.getTime())) || (endsAt && Number.isNaN(endsAt.getTime()))) return setFormError('A data está inválida.');
    if (startsAt && endsAt && endsAt <= startsAt) return setFormError('O fim da validade precisa ser depois do início.');

    setFormError('');
    setSaving(true);
    const body = {
      code,
      description: editing.description.trim() || null,
      kind: editing.kind,
      value,
      max_discount: maxDiscount,
      min_order: minOrder,
      starts_at: startsAt ? startsAt.toISOString() : null,
      ends_at: endsAt ? endsAt.toISOString() : null,
      usage_limit: usage,
      per_customer_limit: perCustomer,
      excludes_promo: editing.excludes_promo,
      active: editing.active,
      category_ids: editing.category_ids,
    };
    try {
      if (editing.id) await api.patch(`/api/admin/coupons/${editing.id}`, body);
      else await api.post('/api/admin/coupons', body);
    } catch (err) {
      setSaving(false);
      setFormError(friendlyError(err, 'Não foi possível salvar o cupom.'));
      return;
    }
    setSaving(false);
    toast.success(editing.id ? 'Cupom salvo.' : 'Cupom criado.', 'Pedidos já feitos não mudam.');
    setEditing(null);
    void load();
  };

  const toggle = async (row: Coupon, active: boolean) => {
    setRows((list) => list?.map((r) => (r.id === row.id ? { ...r, active } : r)) ?? null);
    const failed = await api.patch(`/api/admin/coupons/${row.id}`, { active }).then(
      () => false,
      () => true,
    );
    if (failed) {
      setRows((list) => list?.map((r) => (r.id === row.id ? row : r)) ?? null);
      toast.error('Não foi possível atualizar o cupom.');
    } else toast.success(active ? 'Cupom ligado.' : 'Cupom desligado.');
  };

  const remove = async (row: Coupon) => {
    const ok = await confirm({
      title: `Excluir o cupom ${row.code}?`,
      description: row.used
        ? `${row.used} pedido(s) já usaram este cupom. Eles continuam como estão (o código e o desconto ficam gravados no pedido). Para só parar de aceitar, prefira desligar o cupom.`
        : 'Ninguém usou este cupom ainda.',
      confirmLabel: 'Excluir cupom',
    });
    if (!ok) return;
    try {
      await api.delete(`/api/admin/coupons/${row.id}`);
      toast.success('Cupom excluído.');
      void load();
    } catch (err) {
      toast.error('Não foi possível excluir o cupom.', friendlyError(err, ''));
    }
  };

  const open = (form: Form) => {
    setFormError('');
    setEditing(form);
  };
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setEditing((f) => (f ? { ...f, [key]: value } : f));

  return (
    <>
      <PageHeader
        title="Cupons"
        description="Códigos de desconto que o cliente digita no pedido. O servidor confere tudo na hora de fechar o pedido; um cupom por pedido."
        actions={
          <Button icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => open(EMPTY)} data-coupon-new>
            Novo cupom
          </Button>
        }
      />

      {error && !rows ? (
        <Card>
          <ErrorState message="Não foi possível carregar os cupons." onRetry={() => void load()} />
        </Card>
      ) : !rows ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Ticket className="h-6 w-6" aria-hidden="true" />}
            title="Nenhum cupom"
            description="Crie um código (ex.: BEMVINDO10) para dar desconto ou frete grátis. Nenhum cupom existe até você criar."
            action={<Button onClick={() => open(EMPTY)}>Criar cupom</Button>}
          />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-white/[0.06]" aria-label="Cupons">
            {rows.map((row) => {
              const st = state(row);
              return (
                <li key={row.id} data-coupon={row.code} className="flex flex-wrap items-center gap-3 px-3 py-3 sm:px-5">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-black tracking-wide text-white">{row.code}</span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {row.excludes_promo && <Badge>Sem itens em promoção</Badge>}
                    </p>
                    <p className="mt-0.5 text-sm text-white/75">{summary(row)}</p>
                    <p className="mt-0.5 text-xs text-white/55">
                      {row.used} uso(s){row.usage_limit !== null ? ` de ${row.usage_limit}` : ''}
                      {row.per_customer_limit !== null ? ` · ${row.per_customer_limit} por cliente` : ''}
                      {row.category_ids.length ? ` · só em ${row.category_ids.length} categoria(s)` : ''}
                      {row.starts_at ? ` · de ${formatDateTime(row.starts_at)}` : ''}
                      {row.ends_at ? ` · até ${formatDateTime(row.ends_at)}` : ''}
                    </p>
                    {row.description && <p className="mt-0.5 text-xs text-white/55">{row.description}</p>}
                  </div>
                  <Switch checked={row.active} onChange={(v) => void toggle(row, v)} ariaLabel={`Cupom ${row.code}: ligado`} />
                  <IconButton label={`Editar ${row.code}`} onClick={() => open(fromCoupon(row))}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                  <IconButton label={`Excluir ${row.code}`} onClick={() => void remove(row)} className="hover:text-rose-300">
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => (saving ? undefined : setEditing(null))}
        title={editing?.id ? 'Editar cupom' : 'Novo cupom'}
        description="Mudar um cupom nunca altera pedidos que já foram feitos."
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" form="cupom-form" loading={saving} data-coupon-save>
              Salvar
            </Button>
          </>
        }
      >
        {editing && (
          <form id="cupom-form" onSubmit={save} noValidate className="space-y-4">
            <Field label="Código" hint="O cliente digita este código no pedido (maiúsculas, números, - e _).">
              {(p) => <input {...p} className={INPUT} value={editing.code} maxLength={30} autoCapitalize="characters" autoComplete="off" onChange={(e) => set('code', e.target.value.toUpperCase())} data-coupon-code />}
            </Field>
            <Field label="Descrição (só para você)" count={editing.description.length} max={120}>
              {(p) => <input {...p} className={INPUT} value={editing.description} maxLength={120} onChange={(e) => set('description', e.target.value)} />}
            </Field>
            <Field label="Tipo de desconto">
              {(p) => (
                <select {...p} className={INPUT} value={editing.kind} onChange={(e) => set('kind', e.target.value as CouponKind)} data-coupon-kind>
                  {(Object.keys(KIND_LABEL) as CouponKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {editing.kind !== 'free_delivery' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={editing.kind === 'percent' ? 'Porcentagem de desconto' : 'Valor do desconto (R$)'}>
                  {(p) => <input {...p} className={INPUT} inputMode="decimal" value={editing.value} onChange={(e) => set('value', e.target.value)} data-coupon-value />}
                </Field>
                {editing.kind === 'percent' && (
                  <Field label="Desconto máximo (R$, opcional)" hint="Teto do desconto em reais.">
                    {(p) => <input {...p} className={INPUT} inputMode="decimal" value={editing.max_discount} onChange={(e) => set('max_discount', e.target.value)} />}
                  </Field>
                )}
              </div>
            )}
            <Field label="Pedido mínimo (R$, opcional)" hint="Vale sobre os itens, antes do desconto.">
              {(p) => <input {...p} className={INPUT} inputMode="decimal" value={editing.min_order} onChange={(e) => set('min_order', e.target.value)} />}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Começa em (opcional)" hint="Horário do seu aparelho.">
                {(p) => <input {...p} type="datetime-local" className={INPUT} value={editing.starts_at} onChange={(e) => set('starts_at', e.target.value)} />}
              </Field>
              <Field label="Termina em (opcional)">{(p) => <input {...p} type="datetime-local" className={INPUT} value={editing.ends_at} onChange={(e) => set('ends_at', e.target.value)} />}</Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Limite total de usos (opcional)" hint="Pedido cancelado não conta.">
                {(p) => <input {...p} className={INPUT} inputMode="numeric" value={editing.usage_limit} onChange={(e) => set('usage_limit', e.target.value.replace(/\D/g, ''))} />}
              </Field>
              <Field label="Usos por cliente (opcional)" hint="Conta pelo telefone do pedido ou pela conta.">
                {(p) => <input {...p} className={INPUT} inputMode="numeric" value={editing.per_customer_limit} onChange={(e) => set('per_customer_limit', e.target.value.replace(/\D/g, ''))} />}
              </Field>
            </div>
            {editing.kind !== 'free_delivery' && categories.length > 0 && (
              <fieldset className="rounded-xl border border-white/[0.08] p-3">
                <legend className="px-1 text-[13px] font-semibold text-white/80">Vale só para estas categorias (opcional)</legend>
                <p className="mb-2 text-xs text-white/60">Sem nenhuma marcada, vale para todos os itens.</p>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {categories.map((cat) => (
                    <label key={cat.id} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-white/85">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[#2563FF]"
                        checked={editing.category_ids.includes(cat.id)}
                        onChange={(e) => set('category_ids', e.target.checked ? [...editing.category_ids, cat.id] : editing.category_ids.filter((id) => id !== cat.id))}
                      />
                      {cat.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {editing.kind !== 'free_delivery' && (
              <Switch checked={editing.excludes_promo} onChange={(v) => set('excludes_promo', v)} label="Não vale para itens em promoção" description="O desconto ignora os produtos que estão com preço promocional." />
            )}
            <Switch checked={editing.active} onChange={(v) => set('active', v)} label="Cupom ligado" description="Desligado, o cliente não consegue usar." />
            {formError && (
              <p role="alert" data-coupon-error className="text-sm font-medium text-rose-300">
                {formError}
              </p>
            )}
          </form>
        )}
      </Modal>
    </>
  );
}
