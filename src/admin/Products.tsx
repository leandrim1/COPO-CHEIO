import { ArrowLeft, Copy, FileUp, GlassWater, Images, MoreHorizontal, Package, Pencil, Plus, Search, Snowflake, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import { comboNote, isEnergetico2L } from '../lib/combo';
import { isoToLocal, localToIso, money, moneyInput, normalizeText, parseMoney, promoState } from '../lib/format';
import { navigate } from '../lib/router';
import type { Category, ProductRecord } from '../lib/types';
import { commitProductPhoto, discardImages, emptyImage, generateThumbnailsFor, isStoredProductPhoto } from './client';
import type { ImageValue } from './client';
import { Badge, Button, Card, EmptyState, ErrorState, Field, INPUT, ImageInput, Modal, PageHeader, Skeleton, Spinner, Switch, cx, useConfirm, useToast } from './ui';

export const isSoldOut = (p: Pick<ProductRecord, 'sold_out' | 'stock'>) => p.sold_out || (p.stock !== null && p.stock <= 0);

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
    try {
      // O servidor também apaga a foto do Blob quando nenhum outro produto a usa.
      await api.delete(`/api/admin/products/${p.id}`);
    } catch (error) {
      toast.error('Não foi possível excluir o produto.', friendlyError(error, ''));
      return false;
    }
    toast.success('Produto excluído com sucesso.');
    reload();
    return true;
  };

  const duplicate = async (p: ProductRecord) => {
    try {
      const { product } = await api.post<{ product: ProductRecord }>(`/api/admin/products/${p.id}/duplicate`);
      toast.success('Produto duplicado.', 'A cópia está desativada: revise e ative quando quiser.');
      navigate(`/admin/produtos/${product.id}`);
    } catch (error) {
      toast.error('Não foi possível duplicar o produto.', friendlyError(error, ''));
    }
  };

  return { remove, duplicate };
}

// ---- Importar produtos (cardápio antigo em JSON ou planilha) ----------------------------------

type RawRow = Record<string, unknown>;
type ImportReport = { index: number; name: string; status: 'created' | 'existing' | 'repeated' | 'invalid'; reason?: string }[];
type ImportResult = { created: number; categories_created: number; existing: number; repeated: number; skipped: number; report: ImportReport };

const MAX_IMPORT = 500;

// Nome da coluna (sem acento e em minúsculas) → campo que o servidor entende.
const COLUMN: Record<string, string> = {
  nome: 'name', name: 'name', produto: 'name',
  preco: 'price', price: 'price', valor: 'price',
  promocao: 'promo_price', promo: 'promo_price', 'preco promocional': 'promo_price', promo_price: 'promo_price',
  categoria: 'category', category: 'category',
  descricao: 'description', description: 'description',
  imagem: 'image', image: 'image', foto: 'image',
  sku: 'sku', codigo: 'sku',
  estoque: 'stock', stock: 'stock',
  destaque: 'featured', featured: 'featured',
  esgotado: 'sold_out', soldout: 'sold_out', sold_out: 'sold_out',
};

// Uma planilha colada (CSV com ; ou , ou TAB) vira uma lista de linhas de células. Aspas protegem separadores dentro do texto.
function splitDelimited(text: string): string[][] {
  const head = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = ['\t', ';', ','].map((d) => [d, head.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') (cell += '"', i++);
      else quoted = false;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) (row.push(cell), (cell = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else cell += ch;
  }
  endRow();
  return rows;
}

const YES = new Set(['sim', 's', 'x', '1', 'true', 'verdadeiro', 'yes']);

function parseImport(text: string): { rows: RawRow[]; format: 'json' | 'planilha' } {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const raw: unknown = JSON.parse(trimmed);
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { produtos?: unknown }).produtos) ? (raw as { produtos: unknown[] }).produtos : null;
    if (!list) throw new Error('O arquivo precisa ser uma lista de produtos.');
    const rows = list.map((item): RawRow => {
      if (!item || typeof item !== 'object') return {};
      const p = item as Record<string, unknown>;
      const pick = (...keys: string[]) => keys.map((k) => p[k]).find((v) => v !== undefined && v !== null && v !== '');
      const available = pick('available', 'disponivel', 'disponível');
      return {
        name: pick('name', 'nome'),
        price: pick('price', 'preco', 'preço'),
        promo_price: pick('promo_price', 'promocao', 'promoção'),
        category: pick('category', 'categoria'),
        description: pick('description', 'descricao', 'descrição'),
        image: pick('image', 'imagem'),
        sku: pick('sku'),
        stock: pick('stock', 'estoque'),
        featured: p.featured === true || p.destaque === true,
        sold_out: available === false || p.soldOut === true || p.esgotado === true || p.sold_out === true,
      };
    });
    return { rows, format: 'json' };
  }
  const table = splitDelimited(trimmed);
  if (table.length < 2) throw new Error('A planilha precisa de uma linha de títulos (nome, preço, categoria…) e pelo menos um produto.');
  const fields = table[0].map((title) => COLUMN[normalizeText(title.trim())] ?? '');
  if (!fields.includes('name') || !fields.includes('price')) throw new Error('A primeira linha precisa ter as colunas “nome” e “preço”.');
  const rows = table.slice(1).map((cells): RawRow => {
    const row: RawRow = {};
    fields.forEach((field, i) => {
      const value = (cells[i] ?? '').trim();
      if (!field || value === '') return;
      if (field === 'featured' || field === 'sold_out') row[field] = YES.has(normalizeText(value));
      else if (field === 'price' || field === 'promo_price') row[field] = value.replace(/[^\d.,-]/g, '');
      else row[field] = value;
    });
    return row;
  });
  return { rows, format: 'planilha' };
}

const STATUS_LABEL: Record<ImportReport[number]['status'], string> = { created: 'Criado', existing: 'Já existia', repeated: 'Repetido', invalid: 'Com problema' };

function ImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ data: ImportResult; format: 'json' | 'planilha' } | null>(null);
  const preview = useMemo(() => {
    if (!text.trim()) return null;
    try {
      const parsed = parseImport(text);
      if (parsed.rows.length > MAX_IMPORT) return { error: `Envie até ${MAX_IMPORT} produtos por vez (o arquivo tem ${parsed.rows.length}).` };
      return parsed;
    } catch (e) {
      return { error: e instanceof Error && /^(O arquivo|A planilha|A primeira)/.test(e.message) ? e.message : 'Não consegui ler o conteúdo. Confira o formato.' };
    }
  }, [text]);

  const close = () => {
    setResult(null);
    setError('');
    onClose();
  };

  const run = async () => {
    if (!preview || 'error' in preview) return;
    setBusy(true);
    setError('');
    try {
      const data = await api.post<ImportResult>('/api/admin/products/import', { rows: preview.rows });
      setResult({ data, format: preview.format });
      setText('');
      onDone();
      toast.success(`${data.created} produto(s) importado(s).`, data.skipped ? `${data.skipped} linha(s) com problema: veja o relatório.` : undefined);
    } catch (err) {
      // Nenhuma linha valia: o servidor devolve o relatório mesmo assim, para a pessoa saber o motivo de cada uma.
      const report = err instanceof ApiError ? (err.data.report as ImportReport | undefined) : undefined;
      if (report && preview) setResult({ data: { created: 0, categories_created: 0, existing: 0, repeated: 0, skipped: report.length, report }, format: preview.format });
      else setError(friendlyError(err, 'Não foi possível importar os produtos.'));
    } finally {
      setBusy(false);
    }
  };

  const problems = result?.data.report.filter((item) => item.status !== 'created') ?? [];
  const unit = result?.format === 'json' ? 'Item' : 'Linha';

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={result ? 'Resultado da importação' : 'Importar produtos'}
      description={
        result ? undefined : 'Traga produtos de um arquivo JSON (formato do produtos.json) ou cole uma planilha (CSV ou colunas copiadas do Excel). Nada é apagado: produtos com o mesmo nome e categoria são mantidos.'
      }
      footer={
        result ? (
          <Button onClick={close}>Fechar</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancelar
            </Button>
            <Button loading={busy} disabled={!preview || 'error' in preview || preview.rows.length === 0} onClick={() => void run()}>
              Importar {preview && !('error' in preview) ? preview.rows.length : ''} produtos
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {[
              ['Criados', result.data.created, 'text-emerald-200'],
              ['Já existiam', result.data.existing, 'text-white'],
              ['Repetidos', result.data.repeated, 'text-white'],
              ['Com problema', result.data.skipped, result.data.skipped ? 'text-amber-200' : 'text-white'],
            ].map(([label, value, tone]) => (
              <li key={String(label)} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <p className={cx('text-2xl font-black tabular-nums', String(tone))}>{String(value)}</p>
                <p className="text-xs text-white/65">{String(label)}</p>
              </li>
            ))}
          </ul>
          {result.data.categories_created > 0 && <p className="text-sm text-white/70">{result.data.categories_created} categoria(s) nova(s) criada(s).</p>}
          {problems.length > 0 && (
            <div>
              <p className="mb-1.5 text-sm font-semibold text-white">O que não entrou, e por quê</p>
              <ul className="max-h-64 divide-y divide-white/[0.06] overflow-y-auto rounded-xl border border-white/10" aria-label="Itens que não foram criados">
                {problems.map((item) => (
                  <li key={`${item.index}-${item.status}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                    <span className="w-16 shrink-0 text-xs tabular-nums text-white/60">
                      {unit} {item.index + 1}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-white/85">{item.name || '(sem nome)'}</span>
                    <Badge tone={item.status === 'invalid' ? 'amber' : 'gray'}>{STATUS_LABEL[item.status]}</Badge>
                    {item.reason && <span className="basis-full text-xs text-white/65 sm:ml-[4.75rem]">{item.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 px-4 py-3 text-sm font-semibold text-white/70 hover:border-[#2563FF] hover:text-white">
            <FileUp className="h-4 w-4" aria-hidden="true" />
            Escolher arquivo (.json, .csv ou .txt)
            <input
              type="file"
              accept="application/json,.json,text/csv,.csv,text/plain,.txt,.tsv"
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
            aria-label="Conteúdo a importar (JSON ou planilha)"
            placeholder={'Planilha (primeira linha com os títulos):\nnome;preço;categoria;estoque\nCoca-Cola 2L;12,50;Refrigerantes;24\n\nou JSON:\n[{ "name": "Coca-Cola 2L", "price": 12.5, "category": "Refrigerantes" }]'}
            className={cx(INPUT, 'font-mono text-xs')}
          />
          <p className="text-xs text-white/60">Colunas aceitas: nome, preço, preço promocional, categoria, descrição, imagem (endereço), SKU, estoque, destaque e esgotado (sim/não). Até {MAX_IMPORT} produtos por vez.</p>
          {preview && 'error' in preview && <p className="text-sm text-rose-300">{preview.error}</p>}
          {preview && !('error' in preview) && (
            <p className="text-sm text-white/70">
              {preview.rows.length} {preview.format === 'json' ? 'item(ns)' : 'linha(s)'} lido(s). Cada uma é conferida pelo servidor: o relatório mostra o que entrou e o que ficou de fora.
            </p>
          )}
          {error && <p className="text-sm text-rose-300">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

// ---- Lista (/admin/produtos) -------------------------------------------------------------------

type Filter = 'all' | 'active' | 'inactive' | 'soldout' | 'featured' | 'ice';

export function ProductsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [products, setProducts] = useState<ProductRecord[] | null>(null);
  // Geração das miniaturas das fotos que já existiam (ver `generateThumbnailsFor`): andamento enquanto roda.
  const [thumbJob, setThumbJob] = useState<{ done: number; total: number; failed: number } | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const [categories, setCategories] = useState<Category[]>([]);
  const [featuredLimit, setFeaturedLimit] = useState(4);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ products: ProductRecord[]; categories: Category[]; featured_limit: number }>('/api/admin/products');
      setError(false);
      setCategories(data.categories);
      setProducts(sortProducts(data.products, data.categories));
      setFeaturedLimit(data.featured_limit);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { remove, duplicate } = useProductActions(() => void load());
  const categoryName = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const patch = async (p: ProductRecord, change: Partial<ProductRecord>, message: string) => {
    setProducts((list) => list?.map((x) => (x.id === p.id ? { ...x, ...change } : x)) ?? null);
    try {
      const { product } = await api.patch<{ product: ProductRecord }>(`/api/admin/products/${p.id}`, change);
      setProducts((list) => list?.map((x) => (x.id === p.id ? product : x)) ?? null);
      toast.success(message);
    } catch (err) {
      setProducts((list) => list?.map((x) => (x.id === p.id ? p : x)) ?? null);
      toast.error('Não foi possível salvar o produto.', friendlyError(err, ''));
    }
  };

  // Fotos do Blob da loja que ainda não têm miniatura (as cadastradas antes das miniaturas existirem).
  const withoutThumbs = useMemo(() => (products ?? []).filter((p) => isStoredProductPhoto(p.image_url) && !p.image_sm_url), [products]);

  const generateThumbs = async () => {
    const queue = withoutThumbs;
    const go = await confirm({
      title: 'Gerar miniaturas das fotos',
      description: `${queue.length} foto(s) ainda não têm miniatura. Com elas, o cardápio do site baixa umas 7 vezes menos dados no celular (cada foto da lista passa de ~150 KB para ~15 KB) e rola mais leve. A foto original não muda. Pode levar alguns minutos: deixe esta página aberta. Se fechar, é só voltar e clicar de novo: continua de onde parou.`,
      confirmLabel: 'Gerar agora',
      tone: 'primary',
    });
    if (!go) return;
    let done = 0;
    let failed = 0;
    let reason = '';
    setThumbJob({ done, total: queue.length, failed });
    for (const p of queue) {
      if (!mounted.current) return;
      try {
        const made = await generateThumbnailsFor(p.image_url!);
        // `thumbnails_for`: o servidor só aceita se a foto do produto ainda é esta (se foi trocada nesse meio tempo, recusa).
        const { product } = await api.patch<{ product: ProductRecord }>(`/api/admin/products/${p.id}`, { image_sm_url: made.sm, image_md_url: made.md, thumbnails_for: p.image_url });
        if (mounted.current) setProducts((list) => list?.map((x) => (x.id === p.id ? { ...x, image_sm_url: product.image_sm_url, image_md_url: product.image_md_url } : x)) ?? null);
      } catch (err) {
        failed += 1;
        reason ||= err instanceof Error ? err.message : '';
      }
      done += 1;
      if (mounted.current) setThumbJob({ done, total: queue.length, failed });
    }
    if (!mounted.current) return;
    setThumbJob(null);
    if (failed === 0) toast.success('Miniaturas geradas.', `${done} foto(s) prontas: o site já usa as versões leves.`);
    else toast.error(`${failed} de ${done} foto(s) ficaram sem miniatura.`, reason ? `${reason} Depois de resolver, clique em "Gerar miniaturas" de novo.` : 'Clique em "Gerar miniaturas" de novo para tentar as que faltam.');
  };

  const featuredCount = products?.filter((p) => p.featured && p.active).length ?? 0;
  const term = normalizeText(query.trim());
  const visible = (products ?? []).filter((p) => {
    if (category !== 'all' && (category === 'none' ? p.category_id !== null : p.category_id !== category)) return false;
    if (filter === 'active' && !p.active) return false;
    if (filter === 'inactive' && p.active) return false;
    if (filter === 'soldout' && !isSoldOut(p)) return false;
    if (filter === 'featured' && !p.featured) return false;
    if (filter === 'ice' && !p.ice_choice_required) return false;
    return !term || normalizeText(`${p.name} ${p.sku ?? ''} ${p.description ?? ''}`).includes(term);
  });

  const toggleFeatured = (p: ProductRecord) => {
    if (!p.featured && featuredCount >= featuredLimit) {
      toast.push({ kind: 'info', title: `O site mostra até ${featuredLimit} destaques.`, description: 'O novo destaque entra na fila: mude o limite em Site → Seção Bebidas.' });
    }
    void patch(p, { featured: !p.featured }, p.featured ? 'Produto removido dos destaques.' : 'Produto marcado como destaque.');
  };

  // O gelo é escolhido produto a produto: quem pede este produto passa a escolher (ou deixa de escolher) entre gelo normal e de sabor.
  const toggleIce = (p: ProductRecord) =>
    void patch(p, { ice_choice_required: !p.ice_choice_required }, p.ice_choice_required ? 'Este produto não pergunta mais o gelo.' : 'Este produto agora pede a escolha do gelo.');

  const categoryLabel = (p: ProductRecord) => (p.category_id ? (categoryName.get(p.category_id)?.name ?? '—') : 'Outros');
  // Produto numa categoria oculta não aparece no site, mesmo ativo e com estoque.
  const hiddenByCategory = (p: ProductRecord) => Boolean(p.category_id && categoryName.get(p.category_id)?.active === false);

  const statusBadges = (p: ProductRecord) => (
    <div className="flex flex-wrap gap-1">
      {!p.active && <Badge>Inativo</Badge>}
      {isSoldOut(p) && <Badge tone="red">Esgotado</Badge>}
      {p.featured && <Badge tone="blue">Destaque</Badge>}
      {p.ice_choice_required && <Badge tone="blue">Pede o gelo</Badge>}
      {promoState(p) === 'scheduled' && <Badge tone="violet">Promoção agendada</Badge>}
      {promoState(p) === 'expired' && <Badge>Promoção encerrada</Badge>}
      {p.active && hiddenByCategory(p) && <Badge tone="amber">Categoria oculta</Badge>}
      {p.active && !hiddenByCategory(p) && !isSoldOut(p) && <Badge tone="green">Disponível</Badge>}
    </div>
  );

  // O preço riscado só aparece enquanto a promoção está valendo (agendada ou encerrada, vale o preço normal).
  const price = (p: ProductRecord) =>
    promoState(p) === 'active' ? (
      <span>
        <span className="font-bold text-white">{money(Number(p.promo_price))}</span>{' '}
        <s className="text-xs text-white/60">{money(Number(p.price))}</s>
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
            {(withoutThumbs.length > 0 || thumbJob) && (
              <Button variant="secondary" icon={<Images className="h-4 w-4" aria-hidden="true" />} loading={Boolean(thumbJob)} onClick={() => void generateThumbs()}>
                {thumbJob ? `Gerando miniaturas… ${thumbJob.done}/${thumbJob.total}` : `Gerar miniaturas (${withoutThumbs.length})`}
              </Button>
            )}
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
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/55" aria-hidden="true" />
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
          <option value="ice">Pedem o gelo</option>
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
            {/* Colunas de largura fixa: o nome (a única coluna flexível) é cortado com "…" em vez de empurrar "Ativo" e "Ações" para fora
                da tela. Categoria, estoque e situação ganham coluna própria só a partir de 1536 px; antes disso aparecem sob o nome. */}
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col />
                <col className="hidden w-36 2xl:table-column" />
                <col className="w-36" />
                <col className="hidden w-20 2xl:table-column" />
                <col className="hidden w-44 2xl:table-column" />
                <col className="w-20" />
                <col className="w-60" />
              </colgroup>
              <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wide text-white/60">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">Produto</th>
                  <th scope="col" className="hidden px-4 py-3 font-semibold 2xl:table-cell">Categoria</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Preço</th>
                  <th scope="col" className="hidden px-4 py-3 font-semibold 2xl:table-cell">Estoque</th>
                  <th scope="col" className="hidden px-4 py-3 font-semibold 2xl:table-cell">Situação</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Ativo</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {visible.map((p) => (
                  <tr key={p.id} className={cx('hover:bg-white/[0.02]', !p.active && 'opacity-60')}>
                    <td className="px-4 py-2.5">
                      <a href={`/admin/produtos/${p.id}`} title={p.name} className="flex items-center gap-3">
                        <Thumb url={p.image_sm_url ?? p.image_url} name={p.name} soldOut={isSoldOut(p)} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-white hover:text-[#8FB1FF]">{p.name}</p>
                          {p.sku && <p className="truncate text-xs text-white/60">SKU {p.sku}</p>}
                          <p className="truncate text-xs text-white/60 2xl:hidden">
                            {categoryLabel(p)}
                            {p.stock !== null ? ` · estoque ${p.stock}` : ''}
                          </p>
                          <div className="mt-1 2xl:hidden">{statusBadges(p)}</div>
                        </div>
                      </a>
                    </td>
                    <td className="hidden truncate px-4 py-2.5 text-white/70 2xl:table-cell">{categoryLabel(p)}</td>
                    <td className="px-4 py-2.5">{price(p)}</td>
                    <td className="hidden px-4 py-2.5 tabular-nums text-white/70 2xl:table-cell">{p.stock === null ? <span className="text-white/55">—</span> : p.stock}</td>
                    <td className="hidden px-4 py-2.5 2xl:table-cell">{statusBadges(p)}</td>
                    <td className="px-4 py-2.5">
                      <Switch checked={p.active} onChange={(v) => void patch(p, { active: v }, v ? 'Produto ativado no site.' : 'Produto desativado: saiu do site.')} ariaLabel={`${p.name}: ativo no site`} />
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => toggleFeatured(p)}
                          aria-pressed={p.featured}
                          aria-label={p.featured ? `Tirar ${p.name} dos destaques` : `Destacar ${p.name}`}
                          title={p.featured ? 'Tirar dos destaques' : 'Marcar como destaque'}
                          className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-xl hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]', p.featured ? 'text-amber-300' : 'text-white/55')}
                        >
                          <Star className="h-[18px] w-[18px]" fill={p.featured ? 'currentColor' : 'none'} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleIce(p)}
                          aria-pressed={p.ice_choice_required === true}
                          aria-label={p.ice_choice_required ? `Não pedir a escolha do gelo em ${p.name}` : `Pedir a escolha do gelo em ${p.name}`}
                          title={p.ice_choice_required ? 'Pede o gelo: clique para não perguntar' : 'Clique para pedir a escolha do gelo'}
                          className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-xl hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]', p.ice_choice_required ? 'text-sky-300' : 'text-white/55')}
                        >
                          <Snowflake className="h-[18px] w-[18px]" aria-hidden="true" />
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
                    <Thumb url={p.image_sm_url ?? p.image_url} name={p.name} soldOut={isSoldOut(p)} />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-white">{p.name}</span>
                      <span className="block text-xs text-white/60">
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
                      className={cx('grid h-9 w-9 place-items-center rounded-xl hover:bg-white/[0.08]', p.featured ? 'text-amber-300' : 'text-white/60')}
                    >
                      <Star className="h-[18px] w-[18px]" fill={p.featured ? 'currentColor' : 'none'} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleIce(p)}
                      aria-pressed={p.ice_choice_required === true}
                      aria-label={p.ice_choice_required ? `Não pedir a escolha do gelo em ${p.name}` : `Pedir a escolha do gelo em ${p.name}`}
                      className={cx('grid h-9 w-9 place-items-center rounded-xl hover:bg-white/[0.08]', p.ice_choice_required ? 'text-sky-300' : 'text-white/60')}
                    >
                      <Snowflake className="h-[18px] w-[18px]" aria-hidden="true" />
                    </button>
                    <Button size="sm" variant="ghost" onClick={() => void patch(p, { sold_out: !p.sold_out }, p.sold_out ? 'Produto disponível novamente.' : 'Produto marcado como esgotado.')}>
                      {p.sold_out ? 'Disponibilizar' : 'Esgotar'}
                    </Button>
                    <Switch checked={p.active} onChange={(v) => void patch(p, { active: v }, v ? 'Produto ativado no site.' : 'Produto desativado: saiu do site.')} ariaLabel={`${p.name}: ativo no site`} />
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
  promoFrom: string;
  promoUntil: string;
  category_id: string;
  // Combos (troca de energético): o produto do cardápio que é o energético que vem no combo ('' = nenhum), o VALOR dele quando não é um
  // produto do cardápio, e os energéticos que o cliente pode escolher na troca (nenhum marcado = qualquer energético de 2L).
  swap_base: string;
  swap_price: string;
  swap_options: string[];
  // Quem pede este produto escolhe o gelo (normal ou de sabor).
  ice: boolean;
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
  promoFrom: '',
  promoUntil: '',
  category_id: '',
  swap_base: '',
  swap_price: '',
  swap_options: [],
  ice: false,
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
  const confirm = useConfirm();
  const [original, setOriginal] = useState<ProductRecord | null>(null);
  const [form, setForm] = useState<Form | null>(isNew ? EMPTY_FORM : null);
  const [categories, setCategories] = useState<Category[]>([]);
  // Todos os produtos: a lista de energéticos de 2L para escolher o que vem num combo.
  const [allProducts, setAllProducts] = useState<ProductRecord[]>([]);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [saving, setSaving] = useState(false);
  const [missing, setMissing] = useState(false);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const { remove } = useProductActions(() => navigate('/admin/produtos'));

  useEffect(() => {
    let alive = true;
    void (async () => {
      let categories: Category[] = [];
      let product: ProductRecord | null = null;
      try {
        if (isNew) categories = (await api.get<{ categories: Category[] }>('/api/admin/categories')).categories;
        else ({ categories, product } = await api.get<{ categories: Category[]; product: ProductRecord }>(`/api/admin/products/${id}`));
      } catch {
        if (alive) setMissing(true);
        return;
      }
      if (!alive) return;
      setCategories(categories);
      try {
        const all = await api.get<{ products: ProductRecord[] }>('/api/admin/products');
        if (alive) setAllProducts(all.products);
      } catch {
        /* sem a lista, só não dá para escolher o energético do combo agora */
      }
      if (!alive) return;
      if (isNew) {
        const first = categories[0];
        setForm((f) => (f && !f.category_id && first ? { ...f, category_id: first.id } : f));
        return;
      }
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
        promoFrom: isoToLocal(product.promo_starts_at),
        promoUntil: isoToLocal(product.promo_ends_at),
        category_id: product.category_id ?? '',
        swap_base: product.swap_base_product_id ?? '',
        swap_price: moneyInput(product.swap_base_price === null || product.swap_base_price === undefined ? null : Number(product.swap_base_price)),
        swap_options: product.swap_option_ids ?? [],
        ice: product.ice_choice_required === true,
        sku: product.sku ?? '',
        trackStock: product.stock !== null,
        stock: product.stock === null ? '' : String(product.stock),
        featured: product.featured,
        active: product.active,
        sold_out: product.sold_out,
        position: String(product.position),
        image: emptyImage(product.image_url),
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

  // O campo do energético aparece nos produtos da categoria "Combos" (e em qualquer produto que já tenha um definido, para poder limpar).
  const categoryOf = (categoryId: string | null) => categories.find((c) => c.id === categoryId)?.name ?? '';
  const swapChoices = allProducts.filter((p) => !isNew && p.id === id ? false : isEnergetico2L({ name: p.name, category: categoryOf(p.category_id) }));
  const swapOptionsVisible = comboNote(categoryOf(form.category_id || null)) !== null || form.swap_base !== '' || form.swap_price !== '' || form.swap_options.length > 0;
  // Os energéticos de 2L que podem ser marcados na lista da troca (sem o que já vem no combo).
  const optionChoices = swapChoices.filter((choice) => choice.id !== form.swap_base);
  const toggleOption = (optionId: string) => set('swap_options', form.swap_options.includes(optionId) ? form.swap_options.filter((x) => x !== optionId) : [...form.swap_options, optionId]);

  const createCategory = async () => {
    const name = newCategory?.trim();
    if (!name) return;
    try {
      const { category } = await api.post<{ category: Category }>('/api/admin/categories', { name });
      setCategories((list) => [...list, category]);
      set('category_id', category.id);
      setNewCategory(null);
      toast.success('Categoria criada.');
    } catch (error) {
      toast.error('Não foi possível criar a categoria.', friendlyError(error, ''));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Partial<Record<keyof Form, string>> = {};
    const price = parseMoney(form.price);
    const promo = parseMoney(form.promo);
    const stock = form.trackStock ? Number(form.stock || '0') : null;
    const position = Number(form.position || '0');
    if (!form.name.trim()) next.name = 'Informe o nome.';
    if (price === null || Number.isNaN(price) || price <= 0) next.price = 'Informe um preço maior que zero. Ex.: 12,50';
    if (promo !== null && (Number.isNaN(promo) || promo <= 0 || (price !== null && !Number.isNaN(price) && promo >= price))) next.promo = promo !== null && promo <= 0 ? 'O preço promocional precisa ser maior que zero.' : 'O preço promocional precisa ser menor que o preço.';
    const promoFrom = promo !== null && form.promoFrom ? localToIso(form.promoFrom) : null;
    const promoUntil = promo !== null && form.promoUntil ? localToIso(form.promoUntil) : null;
    if (promo !== null && form.promoFrom && !promoFrom) next.promoFrom = 'Data inválida.';
    if (promo !== null && form.promoUntil && !promoUntil) next.promoUntil = 'Data inválida.';
    if (promoFrom && promoUntil && new Date(promoUntil) <= new Date(promoFrom)) next.promoUntil = 'O fim precisa ser depois do início.';
    if (stock !== null && (!Number.isInteger(stock) || stock < 0)) next.stock = 'Use um número inteiro (0 ou mais).';
    if (!Number.isInteger(position)) next.position = 'Use um número inteiro.';
    const swapPrice = form.swap_base ? null : parseMoney(form.swap_price);
    if (swapPrice !== null && (Number.isNaN(swapPrice) || swapPrice <= 0)) next.swap_price = 'Informe um valor maior que zero. Ex.: 12,00';
    if (swapPrice === null && !form.swap_base && form.swap_options.length > 0) next.swap_price = 'Informe o valor do energético que vem no combo (ou escolha o produto acima) para a troca funcionar.';
    setErrors(next);
    if (Object.keys(next).length) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }

    setSaving(true);
    let photo: Awaited<ReturnType<typeof commitProductPhoto>>;
    try {
      // A foto (até 1200 px) e as duas miniaturas (400 e 720 px) que o site usa nas listas.
      photo = await commitProductPhoto(form.image);
    } catch (err) {
      setSaving(false);
      toast.error('Não foi possível enviar a imagem.', friendlyError(err, err instanceof Error ? err.message : ''));
      return;
    }
    const row = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      price: price!,
      promo_price: promo,
      // Sem preço promocional, as datas não valem: o servidor também zera.
      promo_starts_at: promo === null ? null : promoFrom,
      promo_ends_at: promo === null ? null : promoUntil,
      category_id: form.category_id || null,
      swap_base_product_id: form.swap_base || null,
      // Com um produto escolhido, o valor vem do preço dele; o valor digitado só vale quando o energético não é um produto do cardápio.
      swap_base_price: form.swap_base ? null : swapPrice,
      swap_option_ids: form.swap_options.filter((id) => id !== form.swap_base),
      ice_choice_required: form.ice,
      sku: form.sku.trim() || null,
      stock,
      featured: form.featured,
      active: form.active,
      sold_out: form.sold_out,
      position,
      image_url: photo.url,
      // Foto nova: as miniaturas dela. Sem foto nova, as que já estão salvas continuam valendo (o servidor zera se a foto sair ou mudar).
      ...(photo.changed ? { image_sm_url: photo.sm, image_md_url: photo.md } : {}),
    };
    const send = (extra: { confirm_duplicate?: boolean } = {}) =>
      // A URL do Blob fica no Neon; o servidor apaga do Blob a foto antiga que ficou sem uso.
      isNew ? api.post('/api/admin/products', { ...row, ...extra }) : api.patch(`/api/admin/products/${id}`, { ...row, ...extra });
    try {
      try {
        await send();
      } catch (err) {
        // Já existe outro produto com este nome nesta categoria: só cadastra se a pessoa confirmar.
        if (err instanceof ApiError && err.code === 'duplicate_product') {
          const again = await confirm({
            title: 'Já existe um produto com este nome',
            description: `${err.message} Duplicados confundem o cliente e o estoque.`,
            confirmLabel: 'Salvar mesmo assim',
            tone: 'primary',
          });
          if (!again) {
            setSaving(false);
            await discardImages(photo.uploaded);
            return;
          }
          await send({ confirm_duplicate: true });
        } else throw err;
      }
    } catch (err) {
      setSaving(false);
      await discardImages(photo.uploaded);
      toast.error('Não foi possível salvar o produto.', friendlyError(err, ''));
      return;
    }
    setSaving(false);
    toast.success(
      isNew ? 'Produto cadastrado.' : 'Produto salvo.',
      row.active ? (photo.changed && !photo.sm ? 'Já está no site (sem miniatura da foto: use "Gerar miniaturas" na lista).' : 'Já está no site.') : 'Está desativado: não aparece no site.',
    );
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
              {form.promo.trim() !== '' && (
                <>
                  <Field label="A promoção começa em" error={errors.promoFrom} hint="Opcional. Vazio = já vale. Horário de Brasília.">
                    {(p) => <input {...p} type="datetime-local" value={form.promoFrom} onChange={(e) => set('promoFrom', e.target.value)} className={cx(INPUT, '[color-scheme:dark]')} />}
                  </Field>
                  <Field label="A promoção termina em" error={errors.promoUntil} hint="Opcional. Vazio = sem data para acabar. Depois dela, volta o preço normal sozinho.">
                    {(p) => <input {...p} type="datetime-local" value={form.promoUntil} onChange={(e) => set('promoUntil', e.target.value)} className={cx(INPUT, '[color-scheme:dark]')} />}
                  </Field>
                </>
              )}
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
              {swapOptionsVisible && (
                <div className="space-y-4 rounded-2xl border border-[#2563FF]/30 bg-[#145CFF]/[0.06] p-4 sm:col-span-2">
                  <div>
                    <p className="text-sm font-bold text-white">Troca do energético (combos)</p>
                    <p className="mt-1 text-xs text-white/60">
                      O cliente pode trocar o energético que vem no combo por outro. Se o novo for mais caro, ele paga só a diferença; se for o mesmo valor, o preço se mantém.
                    </p>
                  </div>
                  <Field label="Energético que vem neste combo" hint="Escolha o produto do cardápio. Se o energético do combo não é vendido avulso, deixe “Nenhum” e informe o valor logo abaixo.">
                    {(p) => (
                      <select {...p} value={form.swap_base} onChange={(e) => set('swap_base', e.target.value)} className={INPUT}>
                        <option value="">Nenhum (informar o valor)</option>
                        {swapChoices.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.name} · {moneyInput(Number(choice.promo_price ?? choice.price))}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  {!form.swap_base && (
                    <Field label="Valor do energético que vem no combo (R$)" error={errors.swap_price} hint="É a base da conta: o cliente paga a diferença de quem custar mais que isso. Ex.: 12,00">
                      {(p) => <input {...p} inputMode="decimal" value={form.swap_price} onChange={(e) => set('swap_price', e.target.value)} className={INPUT} placeholder="12,00" />}
                    </Field>
                  )}
                  <fieldset>
                    <legend className="text-sm font-semibold text-white">Energéticos que o cliente pode escolher na troca</legend>
                    <p className="mt-1 text-xs text-white/60">
                      {form.swap_options.length === 0 ? 'Nenhum marcado: vale qualquer energético de 2L do cardápio.' : `${form.swap_options.length} marcado(s): o cliente só vê estes na troca.`}
                    </p>
                    {optionChoices.length === 0 ? (
                      <p className="mt-2 text-xs text-white/50">Não há energéticos de 2L cadastrados (o nome precisa ter “2L”, “2 litros” ou “2000ml”).</p>
                    ) : (
                      <>
                        <div className="mt-2 flex gap-2">
                          <Button size="sm" variant="secondary" onClick={() => set('swap_options', optionChoices.map((choice) => choice.id))}>
                            Marcar todos
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => set('swap_options', [])} disabled={form.swap_options.length === 0}>
                            Limpar
                          </Button>
                        </div>
                        <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-2">
                          {optionChoices.map((choice) => (
                            <li key={choice.id}>
                              <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm text-white hover:bg-white/[0.06]">
                                <input type="checkbox" checked={form.swap_options.includes(choice.id)} onChange={() => toggleOption(choice.id)} className="h-4 w-4 shrink-0 accent-[#2563FF]" />
                                <span className="min-w-0 flex-1">{choice.name}</span>
                                <span className="shrink-0 text-xs text-white/60">{moneyInput(Number(choice.promo_price ?? choice.price))}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </fieldset>
                </div>
              )}
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
          <Card title="Gelo">
            <Switch
              checked={form.ice}
              onChange={(v) => set('ice', v)}
              label="Pedir a escolha do gelo"
              description="Quem pedir este produto escolhe entre gelo normal e gelo de sabor. A escolha aparece no pedido, no acompanhamento e no recibo. Desligado, o produto é pedido sem perguntar."
            />
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
