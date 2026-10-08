import { ArrowDown, ArrowUp, Image as ImageIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, friendlyError } from '../lib/api';
import type { Banner } from '../lib/types';
import { commitImage, discardImages, emptyImage } from './client';
import type { ImageValue } from './client';
import { Badge, Button, Card, EmptyState, ErrorState, Field, INPUT, IconButton, ImageInput, Modal, PageHeader, Skeleton, Switch, useConfirm, useToast } from './ui';

type Draft = {
  id?: string;
  title: string;
  subtitle: string;
  button_text: string;
  link: string;
  active: boolean;
  desktop: ImageValue;
  mobile: ImageValue;
  original?: Banner;
};

const toDraft = (b?: Banner): Draft => ({
  id: b?.id,
  title: b?.title ?? '',
  subtitle: b?.subtitle ?? '',
  button_text: b?.button_text ?? '',
  link: b?.link ?? '/bebidas',
  active: b?.active ?? true,
  desktop: emptyImage(b?.image_desktop_url ?? null),
  mobile: emptyImage(b?.image_mobile_url ?? null),
  original: b,
});

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

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const link = draft.link.trim();
    if (!draft.desktop.url && !draft.desktop.file && !draft.mobile.url && !draft.mobile.file && !draft.title.trim()) {
      setFormError('Coloque uma imagem ou pelo menos um título.');
      return;
    }
    if (link && !/^\/|^https:\/\//.test(link)) {
      setFormError('O link precisa começar com / (página do site) ou https://');
      return;
    }
    if (draft.button_text.trim() && !link) {
      setFormError('Um botão precisa de um link.');
      return;
    }
    setFormError('');
    setSaving(true);
    const uploaded: string[] = [];
    try {
      const desktop = await commitImage(draft.desktop, 'banners', 1600);
      if (desktop.uploaded) uploaded.push(desktop.url!);
      const mobile = await commitImage(draft.mobile, 'banners', 1000);
      if (mobile.uploaded) uploaded.push(mobile.url!);
      const row = {
        title: draft.title.trim() || null,
        subtitle: draft.subtitle.trim() || null,
        button_text: draft.button_text.trim() || null,
        link: link || null,
        active: draft.active,
        image_desktop_url: desktop.url,
        image_mobile_url: mobile.url,
      };
      // O servidor apaga do Blob as imagens antigas que ficaram sem uso.
      if (draft.id) await api.patch(`/api/admin/banners/${draft.id}`, row);
      else await api.post('/api/admin/banners', row);
      toast.success(draft.id ? 'Banner salvo.' : 'Banner criado.', row.active ? 'Já aparece na página Bebidas.' : 'Está inativo.');
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

  const move = async (index: number, delta: -1 | 1) => {
    if (!banners) return;
    const j = index + delta;
    if (j < 0 || j >= banners.length) return;
    const next = [...banners];
    [next[index], next[j]] = [next[j], next[index]];
    setBanners(next.map((b, i) => ({ ...b, position: i })));
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

  return (
    <>
      <PageHeader
        title="Banners"
        description="Os banners ativos aparecem no topo da página Bebidas, em carrossel, na ordem abaixo."
        actions={
          <Button icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => (setFormError(''), setDraft(toDraft()))}>
            Novo banner
          </Button>
        }
      />

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
      ) : banners.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ImageIcon className="h-6 w-6" aria-hidden="true" />}
            title="Nenhum banner"
            description="Divulgue promoções e combos no topo do cardápio."
            action={<Button onClick={() => setDraft(toDraft())}>Criar banner</Button>}
          />
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {banners.map((b, i) => (
            <li key={b.id} className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0C1018]">
              <div className="relative aspect-[21/8] bg-gradient-to-br from-[#145CFF]/40 via-[#0B1230] to-[#050505]">
                {(b.image_desktop_url ?? b.image_mobile_url) && <img src={(b.image_desktop_url ?? b.image_mobile_url)!} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                {(b.title || b.subtitle) && (
                  <div className="absolute inset-0 flex flex-col justify-center bg-gradient-to-r from-black/75 to-transparent p-4">
                    {b.title && <p className="max-w-[70%] text-lg font-black leading-tight text-white">{b.title}</p>}
                    {b.subtitle && <p className="mt-1 max-w-[70%] text-xs text-white/80">{b.subtitle}</p>}
                  </div>
                )}
                {!b.active && <Badge className="absolute right-3 top-3 bg-black/60">Inativo</Badge>}
              </div>
              <div className="flex items-center gap-1 px-3 py-2.5">
                <IconButton label="Subir" disabled={i === 0} onClick={() => void move(i, -1)}>
                  <ArrowUp className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton label="Descer" disabled={i === banners.length - 1} onClick={() => void move(i, 1)}>
                  <ArrowDown className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <span className="min-w-0 flex-1 truncate px-1 text-xs text-white/45">{b.link ?? 'Sem link'}</span>
                <Switch checked={b.active} onChange={(v) => void toggle(b, v)} />
                <IconButton label="Editar banner" onClick={() => (setFormError(''), setDraft(toDraft(b)))}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton label="Excluir banner" className="hover:text-rose-300" onClick={() => void remove(b)}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        size="lg"
        title={draft?.id ? 'Editar banner' : 'Novo banner'}
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
