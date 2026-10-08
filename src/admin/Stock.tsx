import { Boxes, Minus, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, friendlyError } from '../lib/api';
import { normalizeText } from '../lib/format';
import type { Category, ProductRecord } from '../lib/types';
import { isSoldOut } from './Products';
import { Badge, Button, Card, EmptyState, ErrorState, INPUT, IconButton, PageHeader, Skeleton, cx, useToast } from './ui';

const LOW = 5;
type Filter = 'all' | 'soldout' | 'low' | 'untracked';

function StockRow({ product, category, onChanged }: { product: ProductRecord; category: string; onChanged: (p: ProductRecord) => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const soldOut = isSoldOut(product);

  const adjust = async (delta: number) => {
    if (!Number.isInteger(delta) || delta === 0) {
      toast.error('Informe uma quantidade inteira.');
      return;
    }
    setBusy(true);
    try {
      const { product: updated } = await api.post<{ product: ProductRecord }>(`/api/admin/products/${product.id}/stock`, { delta });
      setAmount('');
      onChanged(updated);
      toast.success(delta > 0 ? `+${delta} em ${product.name}` : `${delta} em ${product.name}`, `Estoque atual: ${updated.stock}`);
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
          {product.image_url ? <img src={product.image_url} alt="" className={cx('h-full w-full object-contain p-1', soldOut && 'opacity-50 grayscale')} /> : <Boxes className="h-5 w-5 text-white/30" aria-hidden="true" />}
        </span>
        <div className="min-w-0">
          <p className="truncate font-semibold text-white">{product.name}</p>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-white/45">
            {category}
            {product.stock === null ? (
              <Badge>Sem controle</Badge>
            ) : soldOut ? (
              <Badge tone="red">Esgotado</Badge>
            ) : product.stock <= LOW ? (
              <Badge tone="amber">Estoque baixo</Badge>
            ) : (
              <Badge tone="green">Disponível</Badge>
            )}
            {product.stock === null && product.sold_out && <Badge tone="red">Esgotado</Badge>}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {product.stock !== null && (
          <IconButton label={`Retirar 1 de ${product.name}`} disabled={busy || product.stock === 0} onClick={() => void adjust(-1)} className="border border-white/10">
            <Minus className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        )}
        <span className={cx('min-w-[3.5rem] text-center text-2xl font-black tabular-nums', product.stock === null ? 'text-white/30' : soldOut ? 'text-rose-300' : 'text-white')} aria-label={`Estoque: ${product.stock ?? 'sem controle'}`}>
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
          aria-label={`Quantidade para ${product.name}`}
          placeholder="Qtd."
          className={cx(INPUT, 'w-20')}
        />
        <Button size="sm" variant="secondary" disabled={busy || !(qty > 0)} onClick={() => void adjust(Math.trunc(qty))}>
          + Adicionar
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
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ products: ProductRecord[]; categories: Category[] }>('/api/admin/products');
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
    if (filter === 'low' && !(p.stock !== null && p.stock > 0 && p.stock <= LOW)) return false;
    if (filter === 'untracked' && p.stock !== null) return false;
    return !term || normalizeText(`${p.name} ${p.sku ?? ''}`).includes(term);
  });
  const counts = {
    soldout: products?.filter(isSoldOut).length ?? 0,
    low: products?.filter((p) => p.stock !== null && p.stock > 0 && p.stock <= LOW).length ?? 0,
  };

  return (
    <>
      <PageHeader
        title="Estoque"
        description="Adicione ou retire unidades. Quando chega a 0, o produto aparece como ESGOTADO no site e não pode ser pedido."
      />
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
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" aria-hidden="true" />
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
                onChanged={(next) => setProducts((list) => list?.map((x) => (x.id === next.id ? next : x)) ?? null)}
              />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
