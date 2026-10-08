import { ArrowLeft, Copy, FileUp, GlassWater, MoreHorizontal, Package, Pencil, Plus, Search, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { money, moneyInput, normalizeText, parseMoney } from '../lib/format';
import { navigate } from '../lib/router';
import { MEDIA_BUCKET, friendlyError } from '../lib/supabase';
import type { Category, ProductRecord } from '../lib/types';
import { admin, commitImage, emptyImage, removeImages } from './client';
import type { ImageValue } from './client';
import { Badge, Button, Card, EmptyState, ErrorState, Field, INPUT, ImageInput, Modal, PageHeader, Skeleton, Spinner, Switch, cx, useConfirm, useToast } from './ui';

const PRODUCT_FOLDER = 'products';

export const isSoldOut = (p: Pick<ProductRecord, 'sold_out' | 'stock'>) => p.sold_out || (p.stock !== null && p.stock <= 0);

// Remove a imagem do Storage se nenhum outro produto usa o mesmo arquivo.
async function releaseImage(path: string | null, exceptId?: string) {
  if (!path) return;
  let query = admin.from('products').select('id', { count: 'exact', head: true }).eq('image_path', path);
  if (exceptId) query = query.neq('id', exceptId);
  const { count } = await query;
  if (!count) await removeImages([path]);
}

function sortProducts(products: ProductRecord[], categories: Category[]) {
  const pos = new Map(categories.map((c) => [c.id, c.position]));
  return [...products].sort(
    (a, b) =>
      (a.category_id ? (pos.get(a.category_id) ?? 9999) : 10000) - (b.category_id ? (pos.get(b.category_id) ?? 9999) : 10000) ||
      a.position - b.position ||
      a.name.localeCompare(b.name, 'pt-BR'),
  );
}

function Thumb({ url, name, soldOut }: { url: string | null; name: string; soldOut?: boolean }) {
  return (
    <span className="relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-[radial-gradient(circle_at_50%_60%,rgba(37,99,255,0.35),rgba(255,255,255,0.03)_75%)] ring-1 ring-white/[0.08]">
      {url ? (
        <img src={url} alt={name} loading="lazy" className={cx('h-full w-full object-contain p-1', soldOut && 'opacity-50 grayscale')} />
      ) : (
        <GlassWater className="h-5 w-5 text-[#2563FF]/70" aria-hidden="true" />
      )}
    </span>
  );
}

function RowMenu({ onEdit, onDuplicate, onDelete }: { onEdit: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const item = 'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:outline-none';
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Mais ações"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="grid h-9 w-9 place-items-center rounded-xl text-white/60 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]"
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-30 w-44 rounded-xl border border-white/10 bg-[#0F1420] p-1 shadow-2xl">
          <button role="menuitem" type="button" className={cx(item, 'text-white/85')} onClick={() => (setOpen(false), onEdit())}>
            <Pencil className="h-4 w-4" aria-hidden="true" /> Editar
          </button>
          <button role="menuitem" type="button" className={cx(item, 'text-white/85')} onClick={() => (setOpen(false), onDuplicate())}>
            <Copy className="h-4 w-4" aria-hidden="true" /> Duplicar
          </button>
          <button role="menuitem" type="button" className={cx(item, 'text-rose-300')} onClick={() => (setOpen(false), onDelete())}>
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Excluir
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Ações compartilhadas pela lista e pelo formulário -----------------------------------------

function useProductActions(reload: () => void) {
  const toast = useToast();
  const confirm = useConfirm();

  const remove = async (p: ProductRecord) => {
    const ok = await confirm({
      title: `Excluir “${p.name}”?`,
      description: 'O produto sai do site e do painel. Pedidos antigos continuam com o nome e o preço da época.',
      confirmLabel: 'Excluir produto',
    });
    if (!ok) return false;
    const { error } = await admin.from('products').delete().eq('id', p.id);
    if (error) {
      toast.error('Não foi possível excluir o produto.', friendlyError(error, ''));
      return false;
    }
    await releaseImage(p.image_path);
    toast.success('Produto excluído com sucesso.');
    reload();
    return true;
  };

  const duplicate = async (p: ProductRecord) => {
    let image_url = p.image_url;
    let image_path: string | null = null;
    if (p.image_path) {
      const copyPath = `${PRODUCT_FOLDER}/${crypto.randomUUID()}.${p.image_path.split('.').pop()}`;
      const { error } = await admin.storage.from(MEDIA_BUCKET).copy(p.image_path, copyPath);
      if (!error) {
        image_path = copyPath;
        image_url = admin.storage.from(MEDIA_BUCKET).getPublicUrl(copyPath).data.publicUrl;
      }
    }
    const { data, error } = await admin
      .from('products')
      .insert({
        category_id: p.category_id,
        name: `${p.name} (cópia)`.slice(0, 80),
        description: p.description,
        price: p.price,
        promo_price: p.promo_price,
        image_url,
        image_path,
        sku: null,
        stock: p.stock,
        featured: false,
        active: false,
        sold_out: p.sold_out,
        position: p.position + 1,
      })
      .select('id')
      .single();
    if (error) {
      await removeImages([image_path]);
      toast.error('Não foi possível duplicar o produto.', friendlyError(error, ''));
      return;
    }
    toast.success('Produto duplicado.', 'A cópia está desativada: revise e ative quando quiser.');
    navigate(`/admin/produtos/${data.id}`);
  };

  return { remove, duplicate };
}

// ---- Importar produtos (migração do cardápio antigo) -------------------------------------------

type ImportRow = { name: string; price: number; category: string; description: string | null; image: string | null; featured: boolean; soldOut: boolean };

function parseImport(text: string): { rows: ImportRow[]; skipped: number } {
  const raw: unknown = JSON.parse(text);
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { produtos?: unknown }).produtos) ? (raw as { produtos: unknown[] }).produtos : null;
  if (!list) throw new Error('O arquivo precisa ser uma lista de produtos.');
  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      skipped++;
      continue;
    }
    const p = item as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const name = str(p.name) ?? str(p.nome);
    const priceRaw = p.price ?? p.preco ?? p['preço'];
    const price = typeof priceRaw === 'number' ? priceRaw : parseMoney(String(priceRaw ?? ''));
    if (!name || price === null || Number.isNaN(price) || price < 0) {
      skipped++;
      continue;
    }
    const available = p.available ?? p.disponivel ?? p['disponível'];
    rows.push({
      name: name.slice(0, 80),
      price: Math.round(price * 100) / 100,
      category: (str(p.category) ?? str(p.categoria) ?? 'Outros').slice(0, 40),
      description: (str(p.description) ?? str(p.descricao) ?? str(p['descrição']))?.slice(0, 300) ?? null,
      image: str(p.image) ?? str(p.imagem),
      featured: p.featured === true || p.destaque === true,
      soldOut: available === false || p.soldOut === true || p.esgotado === true,
    });
  }
  return { rows, skipped };
}

function ImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const preview = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return parseImport(text);
    } catch (e) {
      return { error: e instanceof Error && e.message.startsWith('O arquivo') ? e.message : 'JSON inválido. Confira o conteúdo.' };
    }
  }, [text]);

  const run = async () => {
    if (!preview || 'error' in preview) return;
    setBusy(true);
    setError('');
    const { data: cats } = await admin.from('categories').select('*');
    const categories = new Map(((cats ?? []) as Category[]).map((c) => [normalizeText(c.name.trim()), c]));
    let position = categories.size;
    for (const name of new Set(preview.rows.map((r) => r.category))) {
      const key = normalizeText(name.trim());
      if (categories.has(key) || name === 'Outros') continue;
      const { data, error: err } = await admin.from('categories').insert({ name, position: position++ }).select().single();
      if (err) {
        setBusy(false);
        setError(friendlyError(err, `Não foi possível criar a categoria ${name}.`));
        return;
      }
      categories.set(key, data as Category);
    }
    const { data: existing } = await admin.from('products').select('name,category_id');
    const seen = new Set(((existing ?? []) as { name: string; category_id: string | null }[]).map((p) => `${normalizeText(p.name)}|${p.category_id ?? ''}`));
    const rows = preview.rows
      .map((r, i) => {
        const category = r.category === 'Outros' ? null : (categories.get(normalizeText(r.category.trim())) ?? null);
        return {
          name: r.name,
          price: r.price,
          description: r.description,
          image_url: r.image,
          category_id: category?.id ?? null,
          featured: r.featured,
          sold_out: r.soldOut,
          active: true,
          position: i,
        };
      })
      .filter((r) => !seen.has(`${normalizeText(r.name)}|${r.category_id ?? ''}`));
    const ignored = preview.rows.length - rows.length;
    if (rows.length) {
      const { error: err } = await admin.from('products').insert(rows);
      if (err) {
        setBusy(false);
        setError(friendlyError(err, 'Não foi possível importar os produtos.'));
        return;
      }
    }
    setBusy(false);
    toast.success(`${rows.length} produto(s) importado(s).`, ignored ? `${ignored} já existiam e foram mantidos.` : undefined);
    setText('');
    onDone();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Importar produtos"
      description="Traga os produtos do cardápio antigo (formato do produtos.json). Nada é apagado: produtos com o mesmo nome e categoria são mantidos."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={busy} disabled={!preview || 'error' in preview || preview.rows.length === 0} onClick={() => void run()}>
            Importar {preview && !('error' in preview) ? preview.rows.length : ''} produtos
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 px-4 py-3 text-sm font-semibold text-white/70 hover:border-[#2563FF] hover:text-white">
          <FileUp className="h-4 w-4" aria-hidden="true" />
          Escolher arquivo .json
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then(setText);
              e.target.value = '';
            }}
          />
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={9}
          spellCheck={false}
          aria-label="Conteúdo JSON dos produtos"
          placeholder={'[\n  { "name": "Coca-Cola 2L", "price": 12, "category": "Refrigerantes", "image": "https://...", "description": "..." }\n]'}
          className={cx(INPUT, 'font-mono text-xs')}
        />
        {preview && 'error' in preview && <p className="text-sm text-rose-300">{preview.error}</p>}
        {preview && !('error' in preview) && (
          <p className="text-sm text-white/65">
            {preview.rows.length} produto(s) prontos em {new Set(preview.rows.map((r) => r.category)).size} categoria(s)
            {preview.skipped ? ` · ${preview.skipped} ignorado(s) sem nome ou preço` : ''}.
          </p>
        )}
        {error && <p className="text-sm text-rose-300">{error}</p>}
      </div>
    </Modal>
  );
}

// ---- Lista (/admin/produtos) -------------------------------------------------------------------

type Filter = 'all' | 'active' | 'inactive' | 'soldout' | 'featured';

export function ProductsPage() {
  const toast = useToast();
  const [products, setProducts] = useState<ProductRecord[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [featuredLimit, setFeaturedLimit] = useState(4);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    const [p, c, s] = await Promise.all([
      admin.from('products').select('*'),
      admin.from('categories').select('*').order('position').order('name'),
      admin.from('site_settings').select('featured_limit').eq('id', 1).single(),
    ]);
    if (p.error || c.error) {
      setError(true);
      return;
    }
    setError(false);
    setCategories(c.data as Category[]);
    setProducts(sortProducts(p.data as ProductRecord[], c.data as Category[]));
    if (s.data) setFeaturedLimit(s.data.featured_limit);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { remove, duplicate } = useProductActions(() => void load());
  const categoryName = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const patch = async (p: ProductRecord, change: Partial<ProductRecord>, message: string) => {
    setProducts((list) => list?.map((x) => (x.id === p.id ? { ...x, ...change } : x)) ?? null);
    const { data, error: err } = await admin.from('products').update(change).eq('id', p.id).select().single();
    if (err) {
      setProducts((list) => list?.map((x) => (x.id === p.id ? p : x)) ?? null);
      toast.error('Não foi possível salvar o produto.', friendlyError(err, ''));
      return;
    }
    setProducts((list) => list?.map((x) => (x.id === p.id ? (data as ProductRecord) : x)) ?? null);
    toast.success(message);
  };

  const featuredCount = products?.filter((p) => p.featured && p.active).length ?? 0;
  const term = normalizeText(query.trim());
  const visible = (products ?? []).filter((p) => {
    if (category !== 'all' && (category === 'none' ? p.category_id !== null : p.category_id !== category)) return false;
    if (filter === 'active' && !p.active) return false;
    if (filter === 'inactive' && p.active) return false;
    if (filter === 'soldout' && !isSoldOut(p)) return false;
    if (filter === 'featured' && !p.featured) return false;
    return !term || normalizeText(`${p.name} ${p.sku ?? ''} ${p.description ?? ''}`).includes(term);
  });

  const toggleFeatured = (p: ProductRecord) => {
    if (!p.featured && featuredCount >= featuredLimit) {
      toast.push({ kind: 'info', title: `O site mostra até ${featuredLimit} destaques.`, description: 'O novo destaque entra na fila: mude o limite em Site → Seção Bebidas.' });
    }
    void patch(p, { featured: !p.featured }, p.featured ? 'Produto removido dos destaques.' : 'Produto marcado como destaque.');
  };

  const statusBadges = (p: ProductRecord) => (
    <div className="flex flex-wrap gap-1">
      {!p.active && <Badge>Inativo</Badge>}
      {isSoldOut(p) && <Badge tone="red">Esgotado</Badge>}
      {p.featured && <Badge tone="blue">Destaque</Badge>}
      {p.active && !isSoldOut(p) && <Badge tone="green">Disponível</Badge>}
    </div>
  );

  const price = (p: ProductRecord) =>
    p.promo_price !== null ? (
      <span>
        <span className="font-bold text-white">{money(Number(p.promo_price))}</span>{' '}
        <s className="text-xs text-white/40">{money(Number(p.price))}</s>
      </span>
    ) : (
      <span className="font-bold text-white">{money(Number(p.price))}</span>
    );

  return (
    <>
      <PageHeader
        title="Produtos"
        description={products ? `${products.length} produto(s) · ${featuredCount} de ${featuredLimit} destaques no site` : undefined}
        actions={
          <>
            <Button variant="secondary" icon={<FileUp className="h-4 w-4" aria-hidden="true" />} onClick={() => setImporting(true)}>
              Importar
            </Button>
            <Button icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => navigate('/admin/produtos/novo')}>
              Novo produto
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <label className="relative block">
          <span className="sr-only">Buscar produtos</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nome ou SKU" className={cx(INPUT, 'pl-9')} />
        </label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filtrar por categoria" className={cx(INPUT, 'sm:w-48')}>
          <option value="all">Todas as categorias</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value="none">Sem categoria</option>
        </select>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filtrar por situação" className={cx(INPUT, 'sm:w-40')}>
          <option value="all">Todos</option>
          <option value="active">Ativos</option>
          <option value="inactive">Inativos</option>
          <option value="soldout">Esgotados</option>
          <option value="featured">Destaques</option>
        </select>
      </div>

      {error && !products ? (
        <Card>
          <ErrorState message="Não foi possível carregar os produtos." onRetry={() => void load()} />
        </Card>
      ) : !products ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[72px] rounded-2xl" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Package className="h-6 w-6" aria-hidden="true" />}
            title="Nenhum produto cadastrado"
            description="Cadastre o primeiro produto ou importe o cardápio antigo. Eles aparecem no site na hora."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" onClick={() => setImporting(true)}>
                  Importar produtos
                </Button>
                <Button onClick={() => navigate('/admin/produtos/novo')}>Novo produto</Button>
              </div>
            }
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState icon={<Search className="h-6 w-6" aria-hidden="true" />} title="Nenhum produto encontrado" description="Tente outra busca ou filtro." />
        </Card>
      ) : (
        <>
          <div className="hidden overflow-visible rounded-2xl border border-white/[0.08] bg-[#0C1018] lg:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wide text-white/45">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">Produto</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Categoria</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Preço</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Estoque</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Situação</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Ativo</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {visible.map((p) => (
                  <tr key={p.id} className={cx('hover:bg-white/[0.02]', !p.active && 'opacity-60')}>
                    <td className="px-4 py-2.5">
                      <a href={`/admin/produtos/${p.id}`} className="flex items-center gap-3">
                        <Thumb url={p.image_url} name={p.name} soldOut={isSoldOut(p)} />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-white hover:text-[#8FB1FF]">{p.name}</span>
                          {p.sku && <span className="block text-xs text-white/40">SKU {p.sku}</span>}
                        </span>
                      </a>
                    </td>
                    <td className="px-4 py-2.5 text-white/65">{p.category_id ? (categoryName.get(p.category_id)?.name ?? '—') : 'Outros'}</td>
                    <td className="px-4 py-2.5">{price(p)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-white/70">{p.stock === null ? <span className="text-white/35">—</span> : p.stock}</td>
                    <td className="px-4 py-2.5">{statusBadges(p)}</td>
                    <td className="px-4 py-2.5">
                      <Switch checked={p.active} onChange={(v) => void patch(p, { active: v }, v ? 'Produto ativado no site.' : 'Produto desativado: saiu do site.')} label={undefined} />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => toggleFeatured(p)}
                          aria-pressed={p.featured}
                          aria-label={p.featured ? `Tirar ${p.name} dos destaques` : `Destacar ${p.name}`}
                          title={p.featured ? 'Tirar dos destaques' : 'Marcar como destaque'}
                          className={cx('grid h-9 w-9 place-items-center rounded-xl hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]', p.featured ? 'text-amber-300' : 'text-white/40')}
                        >
                          <Star className="h-[18px] w-[18px]" fill={p.featured ? 'currentColor' : 'none'} aria-hidden="true" />
                        </button>
                        <Button size="sm" variant={p.sold_out ? 'secondary' : 'ghost'} onClick={() => void patch(p, { sold_out: !p.sold_out }, p.sold_out ? 'Produto disponível novamente.' : 'Produto marcado como esgotado.')}>
                          {p.sold_out ? 'Disponibilizar' : 'Esgotar'}
                        </Button>
                        <RowMenu onEdit={() => navigate(`/admin/produtos/${p.id}`)} onDuplicate={() => void duplicate(p)} onDelete={() => void remove(p)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="space-y-2.5 lg:hidden">
            {visible.map((p) => (
              <li key={p.id} className={cx('rounded-2xl border border-white/[0.08] bg-[#0C1018] p-3', !p.active && 'opacity-70')}>
                <div className="flex items-start gap-3">
                  <a href={`/admin/produtos/${p.id}`} className="flex min-w-0 flex-1 items-start gap-3">
                    <Thumb url={p.image_url} name={p.name} soldOut={isSoldOut(p)} />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-white">{p.name}</span>
                      <span className="block text-xs text-white/45">
                        {p.category_id ? (categoryName.get(p.category_id)?.name ?? '—') : 'Outros'}
                        {p.stock !== null ? ` · estoque ${p.stock}` : ''}
                      </span>
                      <span className="mt-1 block text-sm">{price(p)}</span>
                    </span>
                  </a>
                  <RowMenu onEdit={() => navigate(`/admin/produtos/${p.id}`)} onDuplicate={() => void duplicate(p)} onDelete={() => void remove(p)} />
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
                  {statusBadges(p)}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleFeatured(p)}
                      aria-pressed={p.featured}
                      aria-label={p.featured ? `Tirar ${p.name} dos destaques` : `Destacar ${p.name}`}
                      className={cx('grid h-9 w-9 place-items-center rounded-xl hover:bg-white/[0.08]', p.featured ? 'text-amber-300' : 'text-white/40')}
                    >
                      <Star className="h-[18px] w-[18px]" fill={p.featured ? 'currentColor' : 'none'} aria-hidden="true" />
                    </button>
                    <Button size="sm" variant="ghost" onClick={() => void patch(p, { sold_out: !p.sold_out }, p.sold_out ? 'Produto disponível novamente.' : 'Produto marcado como esgotado.')}>
                      {p.sold_out ? 'Disponibilizar' : 'Esgotar'}
                    </Button>
                    <Switch checked={p.active} onChange={(v) => void patch(p, { active: v }, v ? 'Produto ativado no site.' : 'Produto desativado: saiu do site.')} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <ImportModal open={importing} onClose={() => setImporting(false)} onDone={() => void load()} />
    </>
  );
}

// ---- Formulário (/admin/produtos/novo e /admin/produtos/:id) -----------------------------------

type Form = {
  name: string;
  description: string;
  price: string;
  promo: string;
  category_id: string;
  sku: string;
  trackStock: boolean;
  stock: string;
  featured: boolean;
  active: boolean;
  sold_out: boolean;
  position: string;
  image: ImageValue;
};

const EMPTY_FORM: Form = {
  name: '',
  description: '',
  price: '',
  promo: '',
  category_id: '',
  sku: '',
  trackStock: false,
  stock: '',
  featured: false,
  active: true,
  sold_out: false,
  position: '0',
  image: emptyImage(),
};

export function ProductFormPage({ id }: { id: string }) {
  const isNew = id === 'novo';
  const toast = useToast();
  const [original, setOriginal] = useState<ProductRecord | null>(null);
  const [form, setForm] = useState<Form | null>(isNew ? EMPTY_FORM : null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [saving, setSaving] = useState(false);
  const [missing, setMissing] = useState(false);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const { remove } = useProductActions(() => navigate('/admin/produtos'));

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [c, p] = await Promise.all([
        admin.from('categories').select('*').order('position').order('name'),
        isNew ? Promise.resolve(null) : admin.from('products').select('*').eq('id', id).maybeSingle(),
      ]);
      if (!alive) return;
      setCategories((c.data ?? []) as Category[]);
      if (isNew) {
        const first = (c.data ?? [])[0] as Category | undefined;
        setForm((f) => (f && !f.category_id && first ? { ...f, category_id: first.id } : f));
        return;
      }
      const product = p?.data as ProductRecord | null;
      if (!product) {
        setMissing(true);
        return;
      }
      setOriginal(product);
      setForm({
        name: product.name,
        description: product.description ?? '',
        price: moneyInput(Number(product.price)),
        promo: moneyInput(product.promo_price === null ? null : Number(product.promo_price)),
        category_id: product.category_id ?? '',
        sku: product.sku ?? '',
        trackStock: product.stock !== null,
        stock: product.stock === null ? '' : String(product.stock),
        featured: product.featured,
        active: product.active,
        sold_out: product.sold_out,
        position: String(product.position),
        image: emptyImage(product.image_url, product.image_path),
      });
    })();
    return () => {
      alive = false;
    };
  }, [id, isNew]);

  if (missing)
    return (
      <Card>
        <EmptyState icon={<Package className="h-6 w-6" aria-hidden="true" />} title="Produto não encontrado" action={<Button variant="secondary" onClick={() => navigate('/admin/produtos')}>Voltar</Button>} />
      </Card>
    );
  if (!form) return <Spinner label="Carregando o produto" />;

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const createCategory = async () => {
    const name = newCategory?.trim();
    if (!name) return;
    const { data, error } = await admin
      .from('categories')
      .insert({ name, position: categories.length ? Math.max(...categories.map((c) => c.position)) + 1 : 0 })
      .select()
      .single();
    if (error) {
      toast.error('Não foi possível criar a categoria.', friendlyError(error, ''));
      return;
    }
    setCategories((list) => [...list, data as Category]);
    set('category_id', (data as Category).id);
    setNewCategory(null);
    toast.success('Categoria criada.');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Partial<Record<keyof Form, string>> = {};
    const price = parseMoney(form.price);
    const promo = parseMoney(form.promo);
    const stock = form.trackStock ? Number(form.stock || '0') : null;
    const position = Number(form.position || '0');
    if (!form.name.trim()) next.name = 'Informe o nome.';
    if (price === null || Number.isNaN(price)) next.price = 'Informe o preço. Ex.: 12,50';
    if (promo !== null && (Number.isNaN(promo) || (price !== null && promo >= price))) next.promo = 'O preço promocional precisa ser menor que o preço.';
    if (stock !== null && (!Number.isInteger(stock) || stock < 0)) next.stock = 'Use um número inteiro (0 ou mais).';
    if (!Number.isInteger(position)) next.position = 'Use um número inteiro.';
    setErrors(next);
    if (Object.keys(next).length) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }

    setSaving(true);
    let image: Awaited<ReturnType<typeof commitImage>>;
    try {
      image = await commitImage(form.image, PRODUCT_FOLDER, 1200);
    } catch (err) {
      setSaving(false);
      toast.error('Não foi possível enviar a imagem.', err instanceof Error ? err.message : '');
      return;
    }
    const row = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      price: price!,
      promo_price: promo,
      category_id: form.category_id || null,
      sku: form.sku.trim() || null,
      stock,
      featured: form.featured,
      active: form.active,
      sold_out: form.sold_out,
      position,
      image_url: image.url,
      image_path: image.url ? image.path : null,
    };
    const result = isNew ? await admin.from('products').insert(row).select().single() : await admin.from('products').update(row).eq('id', id).select().single();
    setSaving(false);
    if (result.error) {
      if (image.uploaded) await removeImages([image.path]);
      toast.error('Não foi possível salvar o produto.', friendlyError(result.error, ''));
      return;
    }
    if (original?.image_path && original.image_path !== row.image_path) await releaseImage(original.image_path, id);
    toast.success(isNew ? 'Produto cadastrado.' : 'Produto salvo.', row.active ? 'Já está no site.' : 'Está desativado: não aparece no site.');
    navigate('/admin/produtos');
  };

  const stockZero = form.trackStock && Number(form.stock || '0') === 0;

  return (
    <form onSubmit={submit} noValidate>
      <a href="/admin/produtos" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-white/55 hover:text-white">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Produtos
      </a>
      <PageHeader
        title={isNew ? 'Novo produto' : form.name || 'Editar produto'}
        actions={
          <>
            {original && (
              <Button variant="danger-ghost" icon={<Trash2 className="h-4 w-4" aria-hidden="true" />} onClick={() => void remove(original)}>
                Excluir
              </Button>
            )}
            <Button variant="secondary" onClick={() => navigate('/admin/produtos')}>
              Cancelar
            </Button>
            <Button type="submit" loading={saving}>
              Salvar produto
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card title="Informações">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome *" error={errors.name} count={form.name.length} max={80} className="sm:col-span-2">
                {(p) => <input {...p} value={form.name} maxLength={80} onChange={(e) => set('name', e.target.value)} className={INPUT} placeholder="Ex.: Coca-Cola 2L" />}
              </Field>
              <Field label="Descrição" count={form.description.length} max={300} className="sm:col-span-2">
                {(p) => <textarea {...p} value={form.description} maxLength={300} rows={3} onChange={(e) => set('description', e.target.value)} className={cx(INPUT, 'resize-none')} />}
              </Field>
              <Field label="Preço *" error={errors.price} hint="Em reais. Ex.: 12,50">
                {(p) => <input {...p} value={form.price} inputMode="decimal" onChange={(e) => set('price', e.target.value)} className={INPUT} placeholder="0,00" />}
              </Field>
              <Field label="Preço promocional" error={errors.promo} hint="Opcional. O site mostra o preço antigo riscado.">
                {(p) => <input {...p} value={form.promo} inputMode="decimal" onChange={(e) => set('promo', e.target.value)} className={INPUT} placeholder="0,00" />}
              </Field>
              <Field label="Categoria" className="sm:col-span-2" hint={newCategory === null ? 'Sem categoria, o produto aparece em “Outros”.' : undefined}>
                {(p) =>
                  newCategory === null ? (
                    <div className="flex gap-2">
                      <select {...p} value={form.category_id} onChange={(e) => set('category_id', e.target.value)} className={INPUT}>
                        <option value="">Sem categoria (Outros)</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                            {c.active ? '' : ' (inativa)'}
                          </option>
                        ))}
                      </select>
                      <Button variant="secondary" onClick={() => setNewCategory('')}>
                        Nova
                      </Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        {...p}
                        autoFocus
                        value={newCategory}
                        maxLength={40}
                        onChange={(e) => setNewCategory(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void createCategory();
                          }
                        }}
                        className={INPUT}
                        placeholder="Nome da nova categoria"
                      />
                      <Button onClick={() => void createCategory()}>Criar</Button>
                      <Button variant="ghost" onClick={() => setNewCategory(null)}>
                        Cancelar
                      </Button>
                    </div>
                  )
                }
              </Field>
              <Field label="SKU (opcional)" count={form.sku.length} max={40}>
                {(p) => <input {...p} value={form.sku} maxLength={40} onChange={(e) => set('sku', e.target.value)} className={INPUT} />}
              </Field>
              <Field label="Ordem de exibição" error={errors.position} hint="Menor aparece primeiro na categoria.">
                {(p) => <input {...p} type="number" step={1} value={form.position} onChange={(e) => set('position', e.target.value)} className={INPUT} />}
              </Field>
            </div>
          </Card>

          <Card title="Estoque">
            <div className="space-y-4">
              <Switch
                checked={form.trackStock}
                onChange={(v) => set('trackStock', v)}
                label="Controlar estoque"
                description="Cada pedido desconta do estoque. Chegou a 0, o produto fica ESGOTADO sozinho."
              />
              {form.trackStock && (
                <Field label="Estoque atual" error={errors.stock} className="sm:max-w-xs">
                  {(p) => <input {...p} type="number" min={0} step={1} value={form.stock} onChange={(e) => set('stock', e.target.value)} className={INPUT} placeholder="0" />}
                </Field>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Imagem">
            <ImageInput label="Foto do produto" value={form.image} onChange={(v) => set('image', v)} hint="Quadrada, de preferência com fundo transparente (PNG/WebP)." />
          </Card>
          <Card title="Visibilidade">
            <div className="space-y-4">
              <Switch checked={form.active} onChange={(v) => set('active', v)} label="Ativo no site" description="Desativado, o produto some do site." />
              <Switch
                checked={form.sold_out || stockZero}
                disabled={stockZero}
                onChange={(v) => set('sold_out', v)}
                label="Esgotado"
                description={stockZero ? 'Estoque em 0: adicione estoque para vender.' : 'O site mostra ESGOTADO e não deixa pedir.'}
              />
              <Switch checked={form.featured} onChange={(v) => set('featured', v)} label="Produto em destaque" description="Aparece em “Os favoritos da galera”." />
            </div>
          </Card>
        </div>
      </div>
    </form>
  );
}
