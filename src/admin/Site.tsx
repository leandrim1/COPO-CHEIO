import { ArrowLeft, ArrowRight, ExternalLink, ImagePlus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { DEFAULT_HERO } from '../lib/defaults';
import { friendlyError } from '../lib/supabase';
import type { HeroSettings, SiteSettings, StoreSettings } from '../lib/types';
import { ACCEPTED_IMAGES, admin, checkImageFile, commitImage, emptyImage, pathFromUrl, removeImages, uploadImage } from './client';
import type { ImageValue } from './client';
import { Button, Card, ErrorState, Field, INPUT, IconButton, ImageInput, PageHeader, Spinner, Switch, cx, useToast } from './ui';

type Data = { store: StoreSettings; site: SiteSettings; hero: HeroSettings };

// Campo de texto com contador e limite (o mesmo limite do banco: o layout nunca quebra).
function Text({
  label,
  value,
  onChange,
  max,
  hint,
  error,
  multiline,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  hint?: ReactNode;
  error?: string;
  multiline?: boolean;
  className?: string;
}) {
  return (
    <Field label={label} count={value.length} max={max} hint={hint} error={error} className={className}>
      {(p) =>
        multiline ? (
          <textarea {...p} value={value} maxLength={max} rows={2} onChange={(e) => onChange(e.target.value)} className={cx(INPUT, 'resize-none')} />
        ) : (
          <input {...p} value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} className={INPUT} />
        )
      }
    </Field>
  );
}

const highlightError = (title: string, highlight: string) =>
  highlight.trim() && !title.includes(highlight.trim()) ? 'Esse trecho precisa estar escrito igual no título.' : undefined;

function SaveBar({ saving, dirty }: { saving: boolean; dirty: boolean }) {
  return (
    <div className="mt-5 flex items-center justify-end gap-3 border-t border-white/[0.06] pt-4">
      {dirty && <span className="text-xs text-amber-200/80">Alterações não salvas</span>}
      <Button type="submit" loading={saving} disabled={!dirty}>
        Salvar
      </Button>
    </div>
  );
}

function useDraft<T>(initial: T) {
  const [draft, setDraft] = useState(initial);
  const [base, setBase] = useState(initial);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(base), [draft, base]);
  return {
    draft,
    set: <K extends keyof T>(key: K, value: T[K]) => setDraft((d) => ({ ...d, [key]: value })),
    dirty,
    commit: (next: T) => {
      setDraft(next);
      setBase(next);
    },
  };
}

// ---- Identidade ----------------------------------------------------------------------------------

function IdentitySection({ data }: { data: Data }) {
  const toast = useToast();
  const { draft, set, dirty, commit } = useDraft({ name: data.store.store_name, tagline: data.store.tagline });
  const [savedLogo, setSavedLogo] = useState(emptyImage(data.site.logo_url, data.site.logo_path));
  const [logo, setLogo] = useState<ImageValue>(savedLogo);
  const [saving, setSaving] = useState(false);
  const logoChanged = Boolean(logo.file) || logo.url !== savedLogo.url;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (draft.name.trim().length < 2) {
      toast.error('Informe o nome da empresa.');
      return;
    }
    setSaving(true);
    try {
      const image = await commitImage(logo, 'brand', 600);
      const [a, b] = await Promise.all([
        admin.from('store_settings').update({ store_name: draft.name.trim(), tagline: draft.tagline.trim() }).eq('id', 1),
        admin.from('site_settings').update({ logo_url: image.url, logo_path: image.url ? image.path : null }).eq('id', 1),
      ]);
      if (a.error || b.error) {
        if (image.uploaded) await removeImages([image.path]);
        throw a.error ?? b.error;
      }
      if (savedLogo.path && savedLogo.path !== image.path) await removeImages([savedLogo.path]);
      commit({ name: draft.name.trim(), tagline: draft.tagline.trim() });
      setSavedLogo(emptyImage(image.url, image.path));
      setLogo(emptyImage(image.url, image.path));
      toast.success('Identidade salva.', 'O site já mostra a mudança.');
    } catch (err) {
      toast.error('Não foi possível salvar.', friendlyError(err, err instanceof Error ? err.message : ''));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Identidade" description="Logo e nome que aparecem no menu, no rodapé e na página Bebidas.">
      <form onSubmit={submit} noValidate>
        <div className="grid gap-5 sm:grid-cols-[10rem_1fr]">
          <ImageInput label="Logo" value={logo} onChange={setLogo} hint="Quadrada (redonda no site)." />
          <div className="space-y-4">
            <Text label="Nome da empresa" value={draft.name} onChange={(v) => set('name', v)} max={30} hint="A última palavra fica azul: COPO CHEIO." />
            <Text label="Slogan curto" value={draft.tagline} onChange={(v) => set('tagline', v)} max={30} hint="Aparece embaixo do nome (ex.: Disk Bebidas)." />
          </div>
        </div>
        <SaveBar saving={saving} dirty={dirty || logoChanged} />
      </form>
    </Card>
  );
}

// ---- Hero ---------------------------------------------------------------------------------------

type HeroImage = { url: string; file?: File; key: string };

function HeroSection({ data }: { data: Data }) {
  const toast = useToast();
  const h = data.hero;
  const { draft, set, dirty, commit } = useDraft({
    title: h.title,
    title_highlight: h.title_highlight ?? '',
    subtitle: h.subtitle ?? '',
    badge_text: h.badge_text,
    show_badge: h.show_badge,
    primary_button_text: h.primary_button_text,
    secondary_button_text: h.secondary_button_text,
    show_secondary_button: h.show_secondary_button,
  });
  const [savedImages, setSavedImages] = useState(h.images);
  const [images, setImages] = useState<HeroImage[]>(() => h.images.map((url) => ({ url, key: url })));
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const imagesDirty = images.some((i) => i.file) || images.map((i) => i.url).join('|') !== savedImages.join('|');
  const hlError = highlightError(draft.title, draft.title_highlight);

  useEffect(() => () => images.forEach((i) => i.file && URL.revokeObjectURL(i.url)), [images]);

  const addFiles = (files: FileList | null) => {
    const list = Array.from(files ?? []);
    for (const file of list) {
      const problem = checkImageFile(file);
      if (problem) {
        toast.error(problem);
        return;
      }
    }
    setImages((current) => [...current, ...list.map((file) => ({ url: URL.createObjectURL(file), file, key: `${file.name}-${Math.random()}` }))].slice(0, 6));
  };
  const move = (i: number, delta: number) =>
    setImages((list) => {
      const next = [...list];
      const j = i + delta;
      if (j < 0 || j >= next.length) return list;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (hlError || draft.title.trim().length < 4 || !draft.primary_button_text.trim() || !draft.secondary_button_text.trim() || !draft.badge_text.trim()) {
      toast.error('Confira os campos do Hero.', hlError ?? 'Título, badge e botões não podem ficar vazios.');
      return;
    }
    setSaving(true);
    const uploaded: string[] = [];
    try {
      const urls: string[] = [];
      for (const image of images) {
        if (image.file) {
          const result = await uploadImage(image.file, 'hero', 1400);
          uploaded.push(result.path);
          urls.push(result.url);
        } else urls.push(image.url);
      }
      const row = {
        ...draft,
        title: draft.title.trim(),
        title_highlight: draft.title_highlight.trim() || null,
        subtitle: draft.subtitle.trim() || null,
        images: urls,
      };
      const { error } = await admin.from('hero_settings').update(row).eq('id', 1);
      if (error) throw error;
      await removeImages(savedImages.filter((url) => !urls.includes(url)).map(pathFromUrl));
      commit(draft);
      setSavedImages(urls);
      setImages(urls.map((url) => ({ url, key: url })));
      toast.success('Hero salvo.', 'O site já mostra os novos textos.');
    } catch (err) {
      await removeImages(uploaded);
      toast.error('Não foi possível salvar o Hero.', friendlyError(err, err instanceof Error ? err.message : ''));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    (Object.keys(DEFAULT_HERO) as (keyof HeroSettings)[]).forEach((key) => {
      if (key in draft) set(key as keyof typeof draft, (DEFAULT_HERO[key] ?? '') as never);
    });
  };

  return (
    <Card
      title="Hero"
      description="A primeira tela do site. Só os textos e imagens mudam: o layout continua o mesmo."
      actions={
        <Button size="sm" variant="ghost" onClick={reset}>
          Textos originais
        </Button>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Text label="Título" value={draft.title} onChange={(v) => set('title', v)} max={60} className="sm:col-span-2" />
          <Text label="Trecho do título em azul" value={draft.title_highlight} onChange={(v) => set('title_highlight', v)} max={30} error={hlError} hint="Copie exatamente uma parte do título." />
          <Text label="Subtítulo" value={draft.subtitle} onChange={(v) => set('subtitle', v)} max={140} multiline />
          <div className="space-y-2">
            <Text label="Texto do badge" value={draft.badge_text} onChange={(v) => set('badge_text', v)} max={32} />
            <Switch checked={draft.show_badge} onChange={(v) => set('show_badge', v)} label="Mostrar badge" />
          </div>
          <Text label="Botão principal" value={draft.primary_button_text} onChange={(v) => set('primary_button_text', v)} max={20} hint="Abre o cardápio (ou o pedido em andamento)." />
          <div className="space-y-2">
            <Text label="Botão secundário" value={draft.secondary_button_text} onChange={(v) => set('secondary_button_text', v)} max={20} />
            <Switch checked={draft.show_secondary_button} onChange={(v) => set('show_secondary_button', v)} label="Mostrar botão secundário" />
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-white/80">Imagens da bebida (carrossel)</p>
          <p className="mb-3 text-xs text-white/45">
            Até 6, quadradas e com fundo transparente, com o copo centralizado. Sem imagens aqui, o site usa as bebidas originais.
          </p>
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {images.map((image, i) => (
              <li key={image.key} className="relative">
                <div className="aspect-square overflow-hidden rounded-xl bg-[radial-gradient(circle_at_50%_55%,rgba(37,99,255,0.35),rgba(255,255,255,0.03)_70%)] ring-1 ring-white/10">
                  <img src={image.url} alt={`Imagem ${i + 1} do Hero`} className="h-full w-full object-contain p-1" />
                </div>
                <div className="mt-1 flex justify-center">
                  <IconButton label="Mover para a esquerda" className="h-7 w-7" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  </IconButton>
                  <IconButton label="Remover imagem" className="h-7 w-7 hover:text-rose-300" onClick={() => setImages((list) => list.filter((_, j) => j !== i))}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </IconButton>
                  <IconButton label="Mover para a direita" className="h-7 w-7" disabled={i === images.length - 1} onClick={() => move(i, 1)}>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </IconButton>
                </div>
              </li>
            ))}
            {images.length < 6 && (
              <li>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/15 text-white/45 hover:border-[#2563FF] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]"
                >
                  <ImagePlus className="h-6 w-6" aria-hidden="true" />
                  <span className="text-[11px] font-semibold">Adicionar</span>
                </button>
              </li>
            )}
          </ul>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_IMAGES}
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-label="Adicionar imagens do Hero"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        <SaveBar saving={saving} dirty={dirty || imagesDirty} />
      </form>
    </Card>
  );
}

// ---- Seções de texto (Bebidas, Contato, Chamada final, SEO) -------------------------------------

function SiteTextsSection({ data }: { data: Data }) {
  const toast = useToast();
  const s = data.site;
  const { draft, set, dirty, commit } = useDraft({
    bebidas_title: s.bebidas_title,
    bebidas_highlight: s.bebidas_highlight ?? '',
    bebidas_subtitle: s.bebidas_subtitle ?? '',
    featured_title: s.featured_title,
    featured_limit: s.featured_limit,
    contato_title: s.contato_title,
    contato_highlight: s.contato_highlight ?? '',
    contato_subtitle: s.contato_subtitle ?? '',
    cta_title: s.cta_title,
    cta_highlight: s.cta_highlight ?? '',
    cta_subtitle: s.cta_subtitle ?? '',
    cta_button: s.cta_button,
  });
  const [saving, setSaving] = useState(false);
  const errors = {
    bebidas: highlightError(draft.bebidas_title, draft.bebidas_highlight),
    contato: highlightError(draft.contato_title, draft.contato_highlight),
    cta: highlightError(draft.cta_title, draft.cta_highlight),
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (errors.bebidas || errors.contato || errors.cta) {
      toast.error('Confira os trechos em azul.', 'Eles precisam estar escritos igual no título.');
      return;
    }
    if ([draft.bebidas_title, draft.featured_title, draft.contato_title, draft.cta_title, draft.cta_button].some((v) => v.trim().length < 2)) {
      toast.error('Os títulos e o botão não podem ficar vazios.');
      return;
    }
    setSaving(true);
    const clean = (v: string) => v.trim() || null;
    const row = {
      bebidas_title: draft.bebidas_title.trim(),
      bebidas_highlight: clean(draft.bebidas_highlight),
      bebidas_subtitle: clean(draft.bebidas_subtitle),
      featured_title: draft.featured_title.trim(),
      featured_limit: Math.min(8, Math.max(0, Math.trunc(Number(draft.featured_limit) || 0))),
      contato_title: draft.contato_title.trim(),
      contato_highlight: clean(draft.contato_highlight),
      contato_subtitle: clean(draft.contato_subtitle),
      cta_title: draft.cta_title.trim(),
      cta_highlight: clean(draft.cta_highlight),
      cta_subtitle: clean(draft.cta_subtitle),
      cta_button: draft.cta_button.trim(),
    };
    const { error } = await admin.from('site_settings').update(row).eq('id', 1);
    setSaving(false);
    if (error) {
      toast.error('Não foi possível salvar os textos.', friendlyError(error, ''));
      return;
    }
    commit(draft);
    toast.success('Textos salvos.', 'O site já mostra a mudança.');
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Card title="Seção Bebidas" description="Página do cardápio (/bebidas).">
        <div className="grid gap-4 sm:grid-cols-2">
          <Text label="Título" value={draft.bebidas_title} onChange={(v) => set('bebidas_title', v)} max={70} className="sm:col-span-2" />
          <Text label="Trecho em azul" value={draft.bebidas_highlight} onChange={(v) => set('bebidas_highlight', v)} max={40} error={errors.bebidas} />
          <Text label="Subtítulo" value={draft.bebidas_subtitle} onChange={(v) => set('bebidas_subtitle', v)} max={160} multiline />
          <Text label="Título dos destaques" value={draft.featured_title} onChange={(v) => set('featured_title', v)} max={40} hint="Ex.: Os favoritos da galera / Mais pedidos" />
          <Field label="Quantidade de destaques" hint="De 0 a 8 produtos marcados como destaque.">
            {(p) => <input {...p} type="number" min={0} max={8} value={draft.featured_limit} onChange={(e) => set('featured_limit', Number(e.target.value))} className={INPUT} />}
          </Field>
        </div>
      </Card>
      <Card title="Seção Contato" description="WhatsApp, Instagram, endereço e horário ficam em Configurações → Loja.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Text label="Título" value={draft.contato_title} onChange={(v) => set('contato_title', v)} max={60} />
          <Text label="Trecho em azul" value={draft.contato_highlight} onChange={(v) => set('contato_highlight', v)} max={40} error={errors.contato} />
          <Text label="Subtítulo" value={draft.contato_subtitle} onChange={(v) => set('contato_subtitle', v)} max={160} multiline className="sm:col-span-2" />
        </div>
      </Card>
      <Card title="Chamada final" description="O bloco “Deu sede?” antes do rodapé.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Text label="Título" value={draft.cta_title} onChange={(v) => set('cta_title', v)} max={30} />
          <Text label="Trecho em azul" value={draft.cta_highlight} onChange={(v) => set('cta_highlight', v)} max={20} error={errors.cta} />
          <Text label="Subtítulo" value={draft.cta_subtitle} onChange={(v) => set('cta_subtitle', v)} max={100} />
          <Text label="Texto do botão" value={draft.cta_button} onChange={(v) => set('cta_button', v)} max={24} />
        </div>
        <SaveBar saving={saving} dirty={dirty} />
      </Card>
    </form>
  );
}

function SeoSection({ data }: { data: Data }) {
  const toast = useToast();
  const s = data.site;
  const { draft, set, dirty, commit } = useDraft({ seo_title: s.seo_title, seo_description: s.seo_description ?? '' });
  const [saved, setSaved] = useState({ og: emptyImage(s.og_image_url, s.og_image_path), favicon: emptyImage(s.favicon_url, s.favicon_path) });
  const [og, setOg] = useState<ImageValue>(saved.og);
  const [favicon, setFavicon] = useState<ImageValue>(saved.favicon);
  const [saving, setSaving] = useState(false);
  const imagesDirty = Boolean(og.file || favicon.file) || og.url !== saved.og.url || favicon.url !== saved.favicon.url;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (draft.seo_title.trim().length < 4) {
      toast.error('Informe o título do site (pelo menos 4 letras).');
      return;
    }
    setSaving(true);
    const uploaded: string[] = [];
    try {
      const ogImage = await commitImage(og, 'seo', 1200);
      if (ogImage.uploaded) uploaded.push(ogImage.path!);
      const icon = await commitImage(favicon, 'seo', 512);
      if (icon.uploaded) uploaded.push(icon.path!);
      const { error } = await admin
        .from('site_settings')
        .update({
          seo_title: draft.seo_title.trim(),
          seo_description: draft.seo_description.trim() || null,
          og_image_url: ogImage.url,
          og_image_path: ogImage.url ? ogImage.path : null,
          favicon_url: icon.url,
          favicon_path: icon.url ? icon.path : null,
        })
        .eq('id', 1);
      if (error) throw error;
      await removeImages([saved.og.path !== ogImage.path ? saved.og.path : null, saved.favicon.path !== icon.path ? saved.favicon.path : null]);
      commit(draft);
      const next = { og: emptyImage(ogImage.url, ogImage.path), favicon: emptyImage(icon.url, icon.path) };
      setSaved(next);
      setOg(next.og);
      setFavicon(next.favicon);
      toast.success('SEO salvo.');
    } catch (err) {
      await removeImages(uploaded);
      toast.error('Não foi possível salvar o SEO.', friendlyError(err, err instanceof Error ? err.message : ''));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="SEO e compartilhamento" description="Título da aba, descrição no Google e imagem ao compartilhar o link.">
      <form onSubmit={submit} noValidate>
        <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
          <div className="space-y-4">
            <Text label="Título SEO" value={draft.seo_title} onChange={(v) => set('seo_title', v)} max={70} />
            <Text label="Descrição SEO" value={draft.seo_description} onChange={(v) => set('seo_description', v)} max={170} multiline />
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
              <p className="text-xs text-white/40">Prévia no Google</p>
              <p className="mt-1 truncate text-[15px] text-[#8AB4F8]">{draft.seo_title || 'Título do site'}</p>
              <p className="line-clamp-2 text-xs text-white/60">{draft.seo_description || 'Descrição do site.'}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 lg:w-80">
            <ImageInput label="Imagem de compartilhamento" value={og} onChange={setOg} aspect="aspect-[1200/630]" fit="cover" hint="1200×630 px." />
            <ImageInput label="Favicon" value={favicon} onChange={setFavicon} hint="Quadrado, 512×512 px." />
          </div>
        </div>
        <SaveBar saving={saving} dirty={dirty || imagesDirty} />
      </form>
    </Card>
  );
}

export default function SitePage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void (async () => {
      const [store, site, hero] = await Promise.all([
        admin.from('store_settings').select('*').eq('id', 1).single(),
        admin.from('site_settings').select('*').eq('id', 1).single(),
        admin.from('hero_settings').select('*').eq('id', 1).single(),
      ]);
      if (store.error || site.error || hero.error) {
        setError(true);
        return;
      }
      setData({ store: store.data as StoreSettings, site: site.data as SiteSettings, hero: hero.data as HeroSettings });
    })();
  }, [version]);

  if (error) return <ErrorState message="Não foi possível carregar o conteúdo do site." onRetry={() => (setError(false), setVersion((v) => v + 1))} />;
  if (!data) return <Spinner label="Carregando o conteúdo do site" />;

  return (
    <>
      <PageHeader
        title="Site"
        description="Textos e imagens do site. Cada bloco tem o seu botão Salvar."
        actions={
          <a href="/" target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-2 rounded-xl border border-white/[0.12] px-4 text-sm font-semibold text-white/80 hover:bg-white/[0.06] hover:text-white">
            <ExternalLink className="h-4 w-4" aria-hidden="true" /> Ver site
          </a>
        }
      />
      <div className="space-y-4">
        <IdentitySection data={data} />
        <HeroSection data={data} />
        <SiteTextsSection data={data} />
        <SeoSection data={data} />
      </div>
    </>
  );
}
