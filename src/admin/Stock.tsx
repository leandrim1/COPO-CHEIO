import { Boxes, Minus, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, friendlyError } from '../lib/api';
import { normalizeText } from '../lib/format';
import type { Category, ProductRecord } from '../lib/types';
import { ExportButton } from './ExportCsv';
import { isSoldOut } from './Products';
import { Badge, Button, Card, EmptyState, ErrorState, INPUT, IconButton, PageHeader, Skeleton, Switch, cx, useToast } from './ui';

// O padrão da loja (Configurações do Estoque) vale para quem não tem limite próprio; sem resposta do servidor, 5 (o valor de sempre).
const FALLBACK_LOW = 5;
const limitOf = (p: ProductRecord, shopDefault: number) => p.low_stock_threshold ?? shopDefault;
type Filter = 'all' | 'soldout' | 'low' | 'untracked';

function StockRow({ product, category, shopDefault, onChanged }: { product: ProductRecord; category: string; shopDefault: number; onChanged: (p: ProductRecord) => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const soldOut = isSoldOut(product);

  // `enable` = ligar o controle de estoque de um produto que não tinha: só acontece de propósito (botão "Começar a controlar").
  const adjust = async (delta: number, enable = false) => {
    if (!Number.isInteger(delta) || delta === 0) {
      toast.error('Informe uma quantidade inteira.');
      return;
    }
    setBusy(true);
    try {
      const { product: updated } = await api.post<{ product: ProductRecord }>(`/api/admin/products/${product.id}/stock`, { delta, ...(enable ? { enable_tracking: true } : {}) });
      setAmount('');
      onChanged(updated);
      toast.success(enable ? `Estoque de ${product.name} agora é controlado` : delta > 0 ? `+${delta} em ${product.name}` : `${delta} em ${product.name}`, `Estoque atual: ${updated.stock}`);
    } catch (error) {
      toast.error('Não foi possível atualizar o estoque.', friendlyError(error, ''));
    } finally {
      setBusy(false);
    }
  };

  const update = async (change: Partial<ProductRecord>, message: string) => {
    setBusy(true);
    try {
      const { product: updated } = await api.patch<{ product: ProductRecord }>(`/api/admin/products/${product.id}`, change);
      onChanged(updated);
      toast.success(message);
    } catch (error) {
      toast.error('Não foi possível salvar.', friendlyError(error, ''));
    } finally {
      setBusy(false);
    }
  };

  const qty = Number(amount);
  return (
    <li className="grid gap-3 px-3 py-3 sm:px-5 md:grid-cols-[1fr_auto_auto] md:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/[0.06]">
          {product.image_url ? <img src={product.image_sm_url ?? product.image_url} alt="" className={cx('h-full w-full object-contain p-1', soldOut && 'opacity-50 grayscale')} /> : <Boxes className="h-5 w-5 text-white/55" aria-hidden="true" />}
        </span>
        <div className="min-w-0">
          <p className="truncate font-semibold text-white">{product.name}</p>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-white/60">
            {category}
            {product.stock === null ? (
              <Badge>Sem controle</Badge>
            ) : soldOut ? (
              <Badge tone="red">Esgotado</Badge>
            ) : product.stock <= limitOf(product, shopDefault) ? (
              <Badge tone="amber">Estoque baixo</Badge>
            ) : (
              <Badge tone="green">Disponível</Badge>
            )}
            {product.stock === null && product.sold_out && <Badge tone="red">Esgotado</Badge>}
          </p>
          {product.stock !== null && (
            <label className="mt-1 flex items-center gap-1.5 text-[11px] text-white/55">
              Avisar com até
              <input
                type="number"
                min={0}
                max={100000}
                step={1}
                inputMode="numeric"
                defaultValue={product.low_stock_threshold ?? ''}
                key={`${product.id}-${product.low_stock_threshold ?? 'padrao'}`}
                placeholder={String(shopDefault)}
                aria-label={`Avisar estoque baixo de ${product.name} com até quantas unidades (vazio = padrão da loja: ${shopDefault})`}
                data-low-threshold
                onBlur={(e) => {
                  const raw = e.target.value.trim();
                  const next = raw === '' ? null : Number(raw);
                  if (next !== null && (!Number.isInteger(next) || next < 0)) return toast.error('Informe um número inteiro a partir de 0.');
                  if (next === (product.low_stock_threshold ?? null)) return;
                  void update({ low_stock_threshold: next }, next === null ? 'Voltou ao padrão da loja.' : `Aviso com até ${next} un.`);
                }}
                className={cx(INPUT, 'h-7 w-16 px-2 py-0 text-xs')}
              />
              un.
            </label>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {product.stock !== null && (
          <IconButton label={`Retirar 1 de ${product.name}`} disabled={busy || product.stock === 0} onClick={() => void adjust(-1)} className="border border-white/10">
            <Minus className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        )}
        <span className={cx('min-w-[3.5rem] text-center text-2xl font-black tabular-nums', product.stock === null ? 'text-white/55' : soldOut ? 'text-rose-300' : 'text-white')} aria-label={`Estoque: ${product.stock ?? 'sem controle'}`}>
          {product.stock ?? '—'}
        </span>
        {product.stock !== null && (
          <IconButton label={`Adicionar 1 em ${product.name}`} disabled={busy} onClick={() => void adjust(1)} className="border border-white/10">
            <Plus className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label={product.stock === null ? `Quantidade em estoque agora de ${product.name}` : `Quantidade para ${product.name}`}
          placeholder={product.stock === null ? 'Tenho' : 'Qtd.'}
          className={cx(INPUT, 'w-20')}
        />
        <Button size="sm" variant="secondary" disabled={busy || !(qty > 0)} onClick={() => void adjust(Math.trunc(qty), product.stock === null)}>
          {product.stock === null ? 'Começar a controlar' : '+ Adicionar'}
        </Button>
        {product.stock !== null && (
          <Button size="sm" variant="ghost" disabled={busy || !(qty > 0)} onClick={() => void adjust(-Math.trunc(qty))}>
            − Retirar
          </Button>
        )}
        {product.stock === null ? (
          <Button size="sm" variant={product.sold_out ? 'secondary' : 'ghost'} disabled={busy} onClick={() => void update({ sold_out: !product.sold_out }, product.sold_out ? 'Produto disponível.' : 'Produto marcado como esgotado.')}>
            {product.sold_out ? 'Disponibilizar' : 'Esgotar'}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update({ stock: null, sold_out: false }, 'Estoque não é mais controlado.')}>
            Parar de controlar
          </Button>
        )}
      </div>
    </li>
  );
}

export default function StockPage() {
  const [products, setProducts] = useState<ProductRecord[] | null>(null);
  const [categories, setCategories] = useState<Map<string, Category>>(new Map());
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<Filter>(() => (new URLSearchParams(window.location.search).get('filtro') === 'baixo' ? 'low' : 'all'));
  const [query, setQuery] = useState('');
  const [shopDefault, setShopDefault] = useState(FALLBACK_LOW);
  const [defaultInput, setDefaultInput] = useState('');
  const [savingDefault, setSavingDefault] = useState(false);
  // Aviso por e-mail aos donos quando o estoque fica baixo ou esgota (um por dia, só quando a lista muda).
  const [emailAlert, setEmailAlert] = useState(true);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [data, settings] = await Promise.all([
        api.get<{ products: ProductRecord[]; categories: Category[] }>('/api/admin/products'),
        api.get<{ store: { low_stock_default?: number; low_stock_email?: boolean } }>('/api/admin/settings').catch(() => null),
      ]);
      setEmailAlert(settings?.store?.low_stock_email !== false);
      const def = Number(settings?.store?.low_stock_default);
      if (Number.isInteger(def) && def >= 0) {
        setShopDefault(def);
        setDefaultInput(String(def));
      } else setDefaultInput(String(FALLBACK_LOW));
      setError(false);
      setProducts(data.products);
      setCategories(new Map(data.categories.map((cat) => [cat.id, cat])));
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const term = normalizeText(query.trim());
  const visible = (products ?? []).filter((p) => {
    if (filter === 'soldout' && !isSoldOut(p)) return false;
    if (filter === 'low' && !(p.stock !== null && p.stock > 0 && p.stock <= limitOf(p, shopDefault))) return false;
    if (filter === 'untracked' && p.stock !== null) return false;
    return !term || normalizeText(`${p.name} ${p.sku ?? ''}`).includes(term);
  });
  const counts = {
    soldout: products?.filter(isSoldOut).length ?? 0,
    low: products?.filter((p) => p.stock !== null && p.stock > 0 && p.stock <= limitOf(p, shopDefault)).length ?? 0,
  };

  return (
    <>
      <PageHeader
        title="Estoque"
        description="Adicione ou retire unidades. Quando chega a 0, o produto aparece como ESGOTADO no site e não pode ser pedido."
        actions={<ExportButton kind="stock" />}
      />
      <form
        data-low-default
        className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-[#0C1018] px-4 py-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const next = Number(defaultInput);
          if (!Number.isInteger(next) || next < 0 || next > 1000) return toast.error('Informe um número inteiro de 0 a 1000.');
          setSavingDefault(true);
          try {
            await api.patch('/api/admin/store', { low_stock_default: next });
            setShopDefault(next);
            toast.success('Padrão salvo.', `Produtos sem limite próprio aparecem como “estoque baixo” com até ${next} unidade(s).`);
          } catch (error) {
            toast.error('Não foi possível salvar.', friendlyError(error, ''));
          } finally {
            setSavingDefault(false);
          }
        }}
      >
        <label className="text-sm text-white/80">
          <span className="mb-1 block text-xs font-semibold text-white/60">Estoque baixo: avisar com até</span>
          <span className="flex items-center gap-2">
            <input type="number" min={0} max={1000} step={1} inputMode="numeric" value={defaultInput} onChange={(e) => setDefaultInput(e.target.value)} className={cx(INPUT, 'w-24')} data-low-default-input />
            <span className="text-xs text-white/60">unidades (padrão da loja; cada produto pode ter o seu abaixo)</span>
          </span>
        </label>
        <Button type="submit" size="sm" variant="secondary" loading={savingDefault}>
          Salvar padrão
        </Button>
      </form>
      <div data-low-email className="mb-4 rounded-2xl border border-white/10 bg-[#0C1018] px-4 py-3">
        <Switch
          checked={emailAlert}
          onChange={async (next) => {
            setEmailAlert(next);
            try {
              await api.patch('/api/admin/store', { low_stock_email: next });
              toast.success(next ? 'Aviso por e-mail ligado.' : 'Aviso por e-mail desligado.');
            } catch (error) {
              setEmailAlert(!next);
              toast.error('Não foi possível salvar.', friendlyError(error, ''));
            }
          }}
          label="Avisar os donos por e-mail"
          description="Quando algum produto ficar com estoque baixo ou esgotar. No máximo um e-mail por dia, só quando a lista muda. Sai pelo envio de e-mail da loja (se estiver configurado)."
        />
      </div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div role="group" aria-label="Filtro" className="inline-flex shrink-0 rounded-xl border border-white/10 bg-[#0C1018] p-1">
          {(
            [
              ['all', 'Todos'],
              ['soldout', `Esgotados${counts.soldout ? ` (${counts.soldout})` : ''}`],
              ['low', `Baixo${counts.low ? ` (${counts.low})` : ''}`],
              ['untracked', 'Sem controle'],
            ] as [Filter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cx('rounded-lg px-3 py-1.5 text-sm font-semibold', filter === value ? 'bg-[#145CFF] text-white' : 'text-white/60 hover:text-white')}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="relative block flex-1">
          <span className="sr-only">Buscar produto</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/55" aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar produto" className={cx(INPUT, 'pl-9')} />
        </label>
      </div>

      {error && !products ? (
        <Card>
          <ErrorState message="Não foi possível carregar o estoque." onRetry={() => void load()} />
        </Card>
      ) : !products ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-16 rounded-2xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState icon={<Boxes className="h-6 w-6" aria-hidden="true" />} title={products.length ? 'Nada por aqui' : 'Nenhum produto cadastrado'} description={products.length ? 'Nenhum produto neste filtro.' : 'Cadastre produtos para controlar o estoque.'} />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-white/[0.06]">
            {visible.map((p) => (
              <StockRow
                key={p.id}
                product={p}
                category={p.category_id ? (categories.get(p.category_id)?.name ?? '—') : 'Outros'}
                shopDefault={shopDefault}
                onChanged={(next) => setProducts((list) => list?.map((x) => (x.id === next.id ? next : x)) ?? null)}
              />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
