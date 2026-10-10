import { ArrowDown, ArrowLeft, ArrowUp, Image as ImageIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, friendlyError } from '../lib/api';
import type { Banner, BannerPlacement } from '../lib/types';
import { commitImage, discardImages, emptyImage } from './client';
import type { ImageValue } from './client';
import { Badge, Button, Card, EmptyState, ErrorState, Field, INPUT, IconButton, ImageInput, Modal, PageHeader, Skeleton, Switch, cx, useConfirm, useImagePreview, useToast } from './ui';

type Draft = {
  id?: string;
  placement: BannerPlacement;
  title: string;
  subtitle: string;
  button_text: string;
  link: string;
  active: boolean;
  desktop: ImageValue;
  mobile: ImageValue;
  original?: Banner;
};

const toDraft = (placement: BannerPlacement, b?: Banner): Draft => ({
  id: b?.id,
  placement: b?.placement ?? placement,
  title: b?.title ?? '',
  subtitle: b?.subtitle ?? '',
  button_text: b?.button_text ?? '',
  // A capa já fica na página Bebidas: um link para /bebidas não levaria a lugar nenhum, então ela começa sem link.
  link: b ? (b.link ?? '') : placement === 'menu' ? '/bebidas' : '',
  active: b?.active ?? true,
  desktop: emptyImage(b?.image_desktop_url ?? null),
  mobile: emptyImage(b?.image_mobile_url ?? null),
  original: b,
});

const byPosition = (a: Banner, b: Banner) => a.position - b.position;
const imageOf = (b: Banner, view: 'mobile' | 'desktop' = 'mobile') => (view === 'mobile' ? (b.image_mobile_url ?? b.image_desktop_url) : (b.image_desktop_url ?? b.image_mobile_url));

// ---- A capa como o site mostra -------------------------------------------------------------------

// Medidas da capa no site (px): a altura é fixa e a largura vai até 704 px. A prévia usa as mesmas proporções para
// mostrar onde ficam os botões "Início" e "Acompanhar" e a logo, que cobrem um pedaço da imagem.
const COVER_VIEWS = {
  mobile: { label: 'Celular', width: 390, height: 176, track: 132, logoLeft: 16 },
  desktop: { label: 'Computador', width: 704, height: 208, track: 200, logoLeft: 24 },
} as const;
type CoverView = keyof typeof COVER_VIEWS;
const PILL = { inset: 16, height: 38, home: 100 };
const LOGO_SIZE = 96;
const COVER_BACKDROP = 'bg-gradient-to-b from-[#0E36B8] via-[#0A2273] to-[#07123A]';

const pct = (px: number, of: number) => `${(px / of) * 100}%`;

function CoverPreview({ mobile, desktop, label }: { mobile: ImageValue; desktop: ImageValue; label: string }) {
  const [view, setView] = useState<CoverView>('mobile');
  const mobileSrc = useImagePreview(mobile);
  const desktopSrc = useImagePreview(desktop);
  const v = COVER_VIEWS[view];
  // Mesma escolha do site: no celular vale a imagem de celular (se houver); no computador, a de computador.
  const src = view === 'mobile' ? (mobileSrc ?? desktopSrc) : (desktopSrc ?? mobileSrc);
  const fontSize = `${(14 / v.width) * 100}cqw`;
  const pill = 'absolute grid place-items-center whitespace-nowrap rounded-full border border-white/25 bg-black/45 font-semibold text-white backdrop-blur-sm';
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-white/80">Prévia na página</p>
        <div role="radiogroup" aria-label="Tamanho da tela da prévia" className="flex gap-1 rounded-full bg-white/[0.05] p-1">
          {(Object.keys(COVER_VIEWS) as CoverView[]).map((key) => (
            <label key={key} className="cursor-pointer">
              <input type="radio" name="cover-preview-view" value={key} checked={view === key} onChange={() => setView(key)} className="peer sr-only" />
              <span className="block rounded-full px-3 py-1 text-xs font-semibold text-white/60 transition-colors hover:text-white peer-checked:bg-[#145CFF] peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-[#5B8CFF]">
                {COVER_VIEWS[key].label}
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="mx-auto" style={{ maxWidth: v.width, containerType: 'inline-size' }}>
        <div data-testid="cover-preview" className={cx('relative overflow-hidden rounded-b-[1.75rem] border border-white/10', COVER_BACKDROP)} style={{ aspectRatio: `${v.width} / ${v.height}` }}>
          {src ? (
            <img src={src} alt={label ? `Prévia: ${label}` : 'Prévia do banner da capa'} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <p className="absolute inset-0 grid place-items-center px-6 text-center text-xs text-white/60">Envie uma imagem para ver a prévia.</p>
          )}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/45 to-transparent" style={{ height: pct(80, v.height) }} />
          <span aria-hidden="true" className={pill} style={{ left: pct(PILL.inset, v.width), top: pct(PILL.inset, v.height), width: pct(PILL.home, v.width), height: pct(PILL.height, v.height), fontSize }}>
            <span className="inline-flex items-center gap-[0.4em]">
              <ArrowLeft className="h-[1.1em] w-[1.1em]" aria-hidden="true" />
              Início
            </span>
          </span>
          <span aria-hidden="true" className={pill} style={{ right: pct(PILL.inset, v.width), top: pct(PILL.inset, v.height), width: pct(v.track, v.width), height: pct(PILL.height, v.height), fontSize }}>
            {view === 'mobile' ? 'Acompanhar' : 'Acompanhar pedido'}
          </span>
          <span
            aria-hidden="true"
            className="absolute grid place-items-center rounded-full bg-[#050505]/90 font-semibold text-white/60 ring-2 ring-white/20"
            style={{ left: pct(v.logoLeft, v.width), top: pct(v.height - LOGO_SIZE / 2, v.height), width: pct(LOGO_SIZE, v.width), aspectRatio: '1', fontSize }}
          >
            <span className="-translate-y-[1.2em]">logo</span>
          </span>
        </div>
      </div>
      <p className="mt-2 text-xs text-white/45">Os botões “Início” e “Acompanhar” e a logo ficam por cima da imagem: deixe essas áreas sem texto importante.</p>
    </div>
  );
}

// ---- Lista ---------------------------------------------------------------------------------------

type CardActions = {
  index: number;
  count: number;
  onMove: (delta: -1 | 1) => void;
  onToggle: (active: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
};

function BannerActions({ banner, index, count, onMove, onToggle, onEdit, onRemove }: CardActions & { banner: Banner }) {
  return (
    <div className="flex items-center gap-1 px-3 py-2.5">
      <IconButton label="Subir" disabled={index === 0} onClick={() => onMove(-1)}>
        <ArrowUp className="h-4 w-4" aria-hidden="true" />
      </IconButton>
      <IconButton label="Descer" disabled={index === count - 1} onClick={() => onMove(1)}>
        <ArrowDown className="h-4 w-4" aria-hidden="true" />
      </IconButton>
      <span className="min-w-0 flex-1 truncate px-1 text-xs text-white/45">{banner.link ?? 'Sem link'}</span>
      <Switch checked={banner.active} onChange={onToggle} />
      <IconButton label="Editar banner" onClick={onEdit}>
        <Pencil className="h-4 w-4" aria-hidden="true" />
      </IconButton>
      <IconButton label="Excluir banner" className="hover:text-rose-300" onClick={onRemove}>
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function CoverCard({ banner, ...actions }: CardActions & { banner: Banner }) {
  const image = imageOf(banner);
  return (
    <li data-testid="cover-card" className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0C1018]">
      <div className={cx('relative aspect-[390/176]', COVER_BACKDROP)}>
        {image && <img src={image} alt={banner.title ? `Capa: ${banner.title}` : 'Imagem da capa'} className="absolute inset-0 h-full w-full object-cover" />}
        {!banner.active && <Badge className="absolute right-3 top-3 bg-black/60">Inativo</Badge>}
      </div>
      <BannerActions banner={banner} {...actions} />
    </li>
  );
}

function MenuCard({ banner, ...actions }: CardActions & { banner: Banner }) {
  const image = imageOf(banner, 'desktop');
  return (
    <li className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0C1018]">
      <div className="relative aspect-[21/8] bg-gradient-to-br from-[#145CFF]/40 via-[#0B1230] to-[#050505]">
        {image && <img src={image} alt="" className="absolute inset-0 h-full w-full object-cover" />}
        {(banner.title || banner.subtitle) && (
          <div className="absolute inset-0 flex flex-col justify-center bg-gradient-to-r from-black/75 to-transparent p-4">
            {banner.title && <p className="max-w-[70%] text-lg font-black leading-tight text-white">{banner.title}</p>}
            {banner.subtitle && <p className="mt-1 max-w-[70%] text-xs text-white/80">{banner.subtitle}</p>}
          </div>
        )}
        {!banner.active && <Badge className="absolute right-3 top-3 bg-black/60">Inativo</Badge>}
      </div>
      <BannerActions banner={banner} {...actions} />
    </li>
  );
}

function SectionHead({ id, title, description, status, action }: { id: string; title: string; description: string; status?: ReactNode; action: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex-1 basis-72">
        <h2 id={id} className="text-lg font-black tracking-tight text-white">
          {title}
        </h2>
        <p className="mt-0.5 max-w-xl text-sm text-white/55">{description}</p>
        {status && <div className="mt-2">{status}</div>}
      </div>
      {action}
    </div>
  );
}

// Onde o banner aparece, como botões de escolha (rádios de verdade: setas do teclado e leitor de tela funcionam).
function PlacementPicker({ value, onChange }: { value: BannerPlacement; onChange: (value: BannerPlacement) => void }) {
  const options: { value: BannerPlacement; label: string; hint: string }[] = [
    { value: 'cover', label: 'Capa da página', hint: 'Topo da página Bebidas, no lugar dos gelos.' },
    { value: 'menu', label: 'Carrossel do cardápio', hint: 'Abaixo do título “Bebidas”, com texto e botão.' },
  ];
  return (
    <fieldset>
      <legend className="mb-1.5 text-[13px] font-semibold text-white/80">Onde aparece</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label key={option.value} className="cursor-pointer">
            <input type="radio" name="banner-placement" value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className="peer sr-only" />
            <span className={cx('block h-full rounded-xl border border-white/[0.12] bg-white/[0.03] px-3.5 py-2.5 transition-colors hover:border-white/25 peer-checked:border-[#2563FF] peer-checked:bg-[#145CFF]/10 peer-focus-visible:ring-2 peer-focus-visible:ring-[#5B8CFF]')}>
              <span className="block text-sm font-semibold text-white">{option.label}</span>
              <span className="mt-0.5 block text-xs text-white/50">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function BannersPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [banners, setBanners] = useState<Banner[] | null>(null);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ banners: Banner[] }>('/api/admin/banners');
      setError(false);
      setBanners(data.banners);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Cada lugar tem a sua própria ordem.
  const cover = useMemo(() => (banners ?? []).filter((b) => b.placement === 'cover').sort(byPosition), [banners]);
  const menu = useMemo(() => (banners ?? []).filter((b) => b.placement !== 'cover').sort(byPosition), [banners]);
  const coverLive = cover.filter((b) => b.active).length;

  const openNew = (placement: BannerPlacement) => {
    setFormError('');
    setDraft(toDraft(placement));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const isCover = draft.placement === 'cover';
    const link = draft.link.trim();
    const hasImage = Boolean(draft.desktop.url || draft.desktop.file || draft.mobile.url || draft.mobile.file);
    if (isCover && !hasImage) {
      setFormError('Coloque uma imagem para a capa (de celular, de computador ou as duas).');
      return;
    }
    if (!isCover && !hasImage && !draft.title.trim()) {
      setFormError('Coloque uma imagem ou pelo menos um título.');
      return;
    }
    if (link && !/^\/|^https:\/\//.test(link)) {
      setFormError('O link precisa começar com / (página do site) ou https://');
      return;
    }
    if (!isCover && draft.button_text.trim() && !link) {
      setFormError('Um botão precisa de um link.');
      return;
    }
    setFormError('');
    setSaving(true);
    const uploaded: string[] = [];
    try {
      const desktop = await commitImage(draft.desktop, 'banners', 1600);
      if (desktop.uploaded) uploaded.push(desktop.url!);
      // Na capa a imagem de celular ocupa a largura toda de telas de até 3× de densidade (1170 px); no carrossel do cardápio, 1000 px bastam.
      const mobile = await commitImage(draft.mobile, 'banners', isCover ? 1200 : 1000);
      if (mobile.uploaded) uploaded.push(mobile.url!);
      const row = {
        placement: draft.placement,
        // Na capa o título é só a descrição da imagem (leitores de tela).
        title: draft.title.trim() || null,
        link: link || null,
        active: draft.active,
        image_desktop_url: desktop.url,
        image_mobile_url: mobile.url,
        // A capa é só imagem: subtítulo e botão não se aplicam a ela e ficam como estão.
        ...(isCover ? {} : { subtitle: draft.subtitle.trim() || null, button_text: draft.button_text.trim() || null }),
      };
      // O servidor apaga do Blob as imagens antigas que ficaram sem uso.
      if (draft.id) await api.patch(`/api/admin/banners/${draft.id}`, row);
      else await api.post('/api/admin/banners', row);
      toast.success(draft.id ? 'Banner salvo.' : 'Banner criado.', !row.active ? 'Está inativo.' : isCover ? 'Já aparece no topo da página Bebidas.' : 'Já aparece na página Bebidas.');
      setDraft(null);
      void load();
    } catch (err) {
      await discardImages(uploaded);
      setFormError(friendlyError(err, err instanceof Error ? err.message : 'Não foi possível salvar o banner.'));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (b: Banner, active: boolean) => {
    setBanners((list) => list?.map((x) => (x.id === b.id ? { ...x, active } : x)) ?? null);
    try {
      await api.patch(`/api/admin/banners/${b.id}`, { active });
      toast.success(active ? 'Banner ativado.' : 'Banner desativado.');
    } catch {
      setBanners((list) => list?.map((x) => (x.id === b.id ? b : x)) ?? null);
      toast.error('Não foi possível atualizar o banner.');
    }
  };

  const move = async (group: Banner[], index: number, delta: -1 | 1) => {
    const j = index + delta;
    if (j < 0 || j >= group.length) return;
    const next = [...group];
    [next[index], next[j]] = [next[j], next[index]];
    const order = new Map(next.map((b, i) => [b.id, i]));
    setBanners((list) => list?.map((b) => (order.has(b.id) ? { ...b, position: order.get(b.id)! } : b)) ?? null);
    try {
      await api.put('/api/admin/banners/order', { ids: next.map((b) => b.id) });
    } catch {
      toast.error('Não foi possível reordenar.');
      void load();
    }
  };

  const remove = async (b: Banner) => {
    const ok = await confirm({ title: 'Excluir este banner?', description: b.title ? `“${b.title}” sai do site.` : 'O banner sai do site.', confirmLabel: 'Excluir banner' });
    if (!ok) return;
    try {
      await api.delete(`/api/admin/banners/${b.id}`);
      toast.success('Banner excluído.');
      void load();
    } catch {
      toast.error('Não foi possível excluir o banner.');
    }
  };

  const actionsFor = (group: Banner[]) => (b: Banner, index: number): CardActions & { banner: Banner } => ({
    banner: b,
    index,
    count: group.length,
    onMove: (delta) => void move(group, index, delta),
    onToggle: (active) => void toggle(b, active),
    onEdit: () => (setFormError(''), setDraft(toDraft(b.placement, b))),
    onRemove: () => void remove(b),
  });

  const editingCover = draft?.placement === 'cover';

  return (
    <>
      <PageHeader title="Banners" description="Escolha o que aparece no topo da página Bebidas: a capa (no lugar dos gelos) e o carrossel do cardápio." />

      {error && !banners ? (
        <Card>
          <ErrorState message="Não foi possível carregar os banners." onRetry={() => void load()} />
        </Card>
      ) : !banners ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-56 rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-10">
          <section aria-labelledby="banners-capa">
            <SectionHead
              id="banners-capa"
              title="Capa da página Bebidas"
              description="A imagem do topo da página, no lugar dos gelos. Com mais de uma ativa, elas se alternam sozinhas."
              status={
                coverLive > 0 ? (
                  <Badge tone="green">No site agora: {coverLive === 1 ? '1 banner na capa' : `${coverLive} banners na capa`}</Badge>
                ) : (
                  <Badge>No site agora: a capa azul com os gelos</Badge>
                )
              }
              action={
                <Button icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => openNew('cover')}>
                  Adicionar banner de capa
                </Button>
              }
            />
            {cover.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<ImageIcon className="h-6 w-6" aria-hidden="true" />}
                  title="Nenhum banner de capa"
                  description="Enquanto não houver um banner ativo aqui, a página Bebidas mostra a capa azul com os gelos."
                  action={<Button onClick={() => openNew('cover')}>Criar banner de capa</Button>}
                />
              </Card>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {cover.map((b, i) => (
                  <CoverCard key={b.id} {...actionsFor(cover)(b, i)} />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="banners-cardapio">
            <SectionHead
              id="banners-cardapio"
              title="Carrossel do cardápio"
              description="Aparecem logo abaixo do título “Bebidas”, em carrossel, na ordem abaixo. Aceitam título, subtítulo e botão."
              action={
                <Button variant={cover.length ? 'secondary' : 'primary'} icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => openNew('menu')}>
                  Novo banner do cardápio
                </Button>
              }
            />
            {menu.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<ImageIcon className="h-6 w-6" aria-hidden="true" />}
                  title="Nenhum banner no cardápio"
                  description="Divulgue promoções e combos logo abaixo do título do cardápio."
                  action={<Button onClick={() => openNew('menu')}>Criar banner</Button>}
                />
              </Card>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {menu.map((b, i) => (
                  <MenuCard key={b.id} {...actionsFor(menu)(b, i)} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <Modal
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        size="lg"
        title={`${draft?.id ? 'Editar' : 'Novo'} banner${editingCover ? ' de capa' : ''}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDraft(null)}>
              Cancelar
            </Button>
            <Button type="submit" form="banner-form" loading={saving}>
              Salvar banner
            </Button>
          </>
        }
      >
        {draft && (
          <form id="banner-form" onSubmit={save} noValidate className="space-y-4">
            <PlacementPicker value={draft.placement} onChange={(placement) => setDraft({ ...draft, placement })} />
            {editingCover ? (
              <>
                <CoverPreview mobile={draft.mobile} desktop={draft.desktop} label={draft.title.trim()} />
                <div className="grid gap-4 sm:grid-cols-[1fr_1.4fr]">
                  <ImageInput
                    label="Imagem no celular"
                    value={draft.mobile}
                    onChange={(v) => setDraft({ ...draft, mobile: v })}
                    aspect="aspect-[390/176]"
                    fit="cover"
                    hint="Ideal: 1200 × 540 px. Aparece em telas pequenas."
                  />
                  <ImageInput
                    label="Imagem no computador (opcional)"
                    value={draft.desktop}
                    onChange={(v) => setDraft({ ...draft, desktop: v })}
                    aspect="aspect-[704/208]"
                    fit="cover"
                    hint="Ideal: 1400 × 420 px. Sem ela, usa a do celular."
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Descrição da imagem" count={draft.title.length} max={60} hint="Lida por leitores de tela. Não aparece sobre o banner.">
                    {(p) => <input {...p} value={draft.title} maxLength={60} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={INPUT} placeholder="Ex.: Cerveja gelada em dobro" />}
                  </Field>
                  <Field label="Link (opcional)" hint="Para onde o cliente vai ao tocar no banner: /#contato ou https://...">
                    {(p) => <input {...p} value={draft.link} maxLength={500} onChange={(e) => setDraft({ ...draft, link: e.target.value })} className={INPUT} />}
                  </Field>
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-[1.6fr_1fr]">
                  <ImageInput label="Imagem desktop" value={draft.desktop} onChange={(v) => setDraft({ ...draft, desktop: v })} aspect="aspect-[21/8]" fit="cover" hint="1400×530 px." />
                  <ImageInput label="Imagem celular (opcional)" value={draft.mobile} onChange={(v) => setDraft({ ...draft, mobile: v })} aspect="aspect-[4/3]" fit="cover" hint="800×600 px. Sem ela, usa a do desktop." />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Título" count={draft.title.length} max={60}>
                    {(p) => <input {...p} value={draft.title} maxLength={60} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={INPUT} />}
                  </Field>
                  <Field label="Subtítulo" count={draft.subtitle.length} max={120}>
                    {(p) => <input {...p} value={draft.subtitle} maxLength={120} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} className={INPUT} />}
                  </Field>
                  <Field label="Texto do botão" count={draft.button_text.length} max={24} hint="Opcional.">
                    {(p) => <input {...p} value={draft.button_text} maxLength={24} onChange={(e) => setDraft({ ...draft, button_text: e.target.value })} className={INPUT} placeholder="Ex.: Aproveitar" />}
                  </Field>
                  <Field label="Link" hint="/bebidas, /#contato ou https://...">
                    {(p) => <input {...p} value={draft.link} maxLength={500} onChange={(e) => setDraft({ ...draft, link: e.target.value })} className={INPUT} />}
                  </Field>
                </div>
              </>
            )}
            <Switch checked={draft.active} onChange={(v) => setDraft({ ...draft, active: v })} label="Ativo" description="Inativo, o banner fica guardado mas não aparece no site." />
            {formError && (
              <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                {formError}
              </p>
            )}
          </form>
        )}
      </Modal>
    </>
  );
}
