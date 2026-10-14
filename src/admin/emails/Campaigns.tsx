import { Megaphone, Pencil, Play, Plus, Send, Trash2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, friendlyError } from '../../lib/api';
import { formatDateTime, timeAgo } from '../../lib/format';
import type { EmailCampaign } from '../../lib/types';
import { useAdmin } from '../AdminApp';
import { Badge, Button, Card, EmptyState, ErrorState, Field, INPUT, Modal, Skeleton, cx, useConfirm, useToast } from '../ui';
import { CAMPAIGN_STATUS } from './labels';

type Draft = { name: string; subject: string; preheader: string; title: string; body: string; cta_label: string; cta_url: string };
const EMPTY: Draft = { name: '', subject: '', preheader: '', title: '', body: '', cta_label: '', cta_url: '' };
type ListResponse = { campaigns: EmailCampaign[]; audience: number; promo_daily_limit: number; free_sender: boolean };

const n = (value: number) => value.toLocaleString('pt-BR');

// Dicas de conteúdo (as mesmas regras que o servidor exige, mais o que ajuda a não cair no spam).
function hints(d: Draft): string[] {
  const out: string[] = [];
  const letters = d.subject.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 8 && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length > 0.7) out.push('Assunto todo em maiúsculas cai no spam: escreva normalmente.');
  if (/^\s*(re|res|fw|fwd|enc)\s*:/i.test(d.subject)) out.push('Não comece o assunto com “Re:” ou “Fwd:”: parece uma resposta que nunca existiu.');
  if (d.subject.length > 70) out.push('Assuntos acima de ~70 caracteres são cortados no celular.');
  if ((d.subject.match(/[!?]/g) ?? []).length > 1) out.push('Evite vários “!” ou “?” no assunto.');
  if (d.cta_url && !/^https:\/\//i.test(d.cta_url)) out.push('O botão só aceita link https://.');
  if (/\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|cutt\.ly)\b/i.test(d.cta_url)) out.push('Não use encurtador de link; use o endereço verdadeiro.');
  if (Boolean(d.cta_label) !== Boolean(d.cta_url)) out.push('Para ter botão, preencha o texto E o endereço.');
  return out;
}

function Editor({ id, onClose, onSaved }: { id: string | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loading, setLoading] = useState(Boolean(id));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!id) return;
    api
      .get<{ campaign: EmailCampaign }>(`/api/admin/emails/campaigns/${id}`)
      .then(({ campaign: c }) => setDraft({ name: c.name, subject: c.subject, preheader: c.preheader ?? '', title: c.title ?? '', body: c.body ?? '', cta_label: c.cta_label ?? '', cta_url: c.cta_url ?? '' }))
      .catch(() => toast.error('Não foi possível carregar a campanha.'))
      .finally(() => setLoading(false));
  }, [id, toast]);

  const set = (key: keyof Draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  const problems = hints(draft);

  const save = async () => {
    const e: Record<string, string> = {};
    if (draft.name.trim().length < 2) e.name = 'Dê um nome para você reconhecer a campanha.';
    if (draft.subject.trim().length < 2) e.subject = 'Escreva o assunto.';
    if (draft.title.trim().length < 2) e.title = 'Escreva o título que aparece no e-mail.';
    if (draft.body.trim().length < 2) e.body = 'Escreva o texto.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    const body = { ...draft, name: draft.name.trim(), subject: draft.subject.trim(), preheader: draft.preheader.trim() || null, title: draft.title.trim(), cta_label: draft.cta_label.trim() || null, cta_url: draft.cta_url.trim() || null };
    try {
      if (id) await api.patch(`/api/admin/emails/campaigns/${id}`, body);
      else await api.post('/api/admin/emails/campaigns', body);
      toast.success(id ? 'Campanha atualizada.' : 'Rascunho salvo. Envie um teste para você antes de mandar para todos.');
      onSaved();
      onClose();
    } catch (err) {
      toast.error('Não foi possível salvar.', friendlyError(err, ''));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={id ? 'Editar campanha' : 'Nova campanha'}
      description="Promoção por e-mail: só chega a quem aceitou receber e confirmou o e-mail."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={saving} disabled={loading} onClick={() => void save()}>
            Salvar rascunho
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nome (só para você)" error={errors.name} max={80} count={draft.name.length}>
          {(f) => <input {...f} className={INPUT} value={draft.name} onChange={set('name')} placeholder="Ex.: Promo de sexta" />}
        </Field>
        <Field label="Assunto" error={errors.subject} max={150} count={draft.subject.length} hint="É o que a pessoa vê antes de abrir. Seja claro e fale só do que o e-mail traz.">
          {(f) => <input {...f} className={INPUT} value={draft.subject} onChange={set('subject')} placeholder="Ex.: Sexta com cerveja gelada na Copo Cheio" />}
        </Field>
        <Field label="Resumo (opcional)" max={150} count={draft.preheader.length} hint="Texto curto que aparece ao lado do assunto na caixa de entrada.">
          {(f) => <input {...f} className={INPUT} value={draft.preheader} onChange={set('preheader')} />}
        </Field>
        <Field label="Título dentro do e-mail" error={errors.title} max={100} count={draft.title.length}>
          {(f) => <input {...f} className={INPUT} value={draft.title} onChange={set('title')} />}
        </Field>
        <Field label="Texto" error={errors.body} max={4000} count={draft.body.length} hint="Separe os parágrafos com uma linha em branco.">
          {(f) => <textarea {...f} rows={7} className={INPUT} value={draft.body} onChange={set('body')} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Texto do botão (opcional)" max={40} count={draft.cta_label.length}>
            {(f) => <input {...f} className={INPUT} value={draft.cta_label} onChange={set('cta_label')} placeholder="Ver ofertas" />}
          </Field>
          <Field label="Endereço do botão (https)" hint="O link vai direto, sem redirecionador de rastreio.">
            {(f) => <input {...f} className={INPUT} inputMode="url" value={draft.cta_url} onChange={set('cta_url')} placeholder="https://..." />}
          </Field>
        </div>
        {problems.length > 0 && (
          <ul className="space-y-1 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs text-amber-100" role="status">
            {problems.map((p) => (
              <li key={p}>• {p}</li>
            ))}
          </ul>
        )}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-white/50">Prévia simples</p>
          <p className="text-xs text-white/55">{draft.subject || 'Assunto'}</p>
          <h3 className="mt-2 text-lg font-black text-white">{draft.title || 'Título'}</h3>
          {(draft.body || 'Texto da campanha')
            .split(/\n\s*\n/)
            .filter(Boolean)
            .slice(0, 6)
            .map((p, i) => (
              <p key={i} className="mt-2 text-sm text-white/75">
                {p}
              </p>
            ))}
          {draft.cta_label && <span className="mt-3 inline-block rounded-xl bg-[#145CFF] px-4 py-2 text-sm font-bold text-white">{draft.cta_label}</span>}
          <p className="mt-4 border-t border-white/10 pt-2 text-[11px] text-white/45">No fim do e-mail vão automaticamente o link “Cancelar inscrição” e o motivo de a pessoa estar recebendo.</p>
        </div>
      </div>
    </Modal>
  );
}

function SendModal({ campaign, audience, freeSender, promoLimit, onClose, onSent }: { campaign: EmailCampaign; audience: number; freeSender: boolean; promoLimit: number; onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [count, setCount] = useState(audience);
  const [risk, setRisk] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const days = promoLimit > 0 ? Math.ceil(count / promoLimit) : 1;

  const send = async () => {
    setSending(true);
    setNote(null);
    try {
      const r = await api.post<{ queued: number }>(`/api/admin/emails/campaigns/${campaign.id}/send`, { confirm_count: count, ...(freeSender ? { accept_risk: risk } : {}) });
      toast.success(`Campanha na fila para ${n(r.queued)} pessoa(s).`, 'O envio começa agora e continua enquanto esta página estiver aberta.');
      onSent();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'audience_changed') {
        const next = Number(err.data.audience ?? 0);
        setCount(next);
        setNote(`A lista mudou: agora são ${n(next)} destinatário(s). Confira e confirme de novo.`);
      } else toast.error('Não foi possível enviar.', friendlyError(err, ''));
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Enviar “${campaign.name}”`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button icon={<Send className="h-4 w-4" aria-hidden="true" />} loading={sending} disabled={count === 0 || (freeSender && !risk)} onClick={() => void send()}>
            Enviar para {n(count)} pessoa(s)
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-white/80">
        <p>
          Esta campanha vai para <strong className="text-white">{n(count)} pessoa(s)</strong>: clientes com e-mail confirmado que aceitaram receber promoções e não estão na lista de supressão. Quem cancelar a inscrição durante o envio deixa de receber o resto.
        </p>
        {count > 0 && promoLimit > 0 && days > 1 && <p className="rounded-xl bg-white/[0.05] p-3 text-xs">O limite de promoções é de {n(promoLimit)} por dia: o envio leva cerca de {days} dias. O resto espera na fila.</p>}
        {note && (
          <p role="alert" className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100">
            {note}
          </p>
        )}
        {freeSender && (
          <label className="flex items-start gap-2.5 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-xs text-rose-100">
            <input type="checkbox" checked={risk} onChange={(e) => setRisk(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#145CFF]" />
            <span>O remetente é um e-mail gratuito (Gmail, Outlook...). Promoções em massa por ele têm limite baixo e podem bloquear a conta ou cair no spam. Eu entendo o risco e quero enviar mesmo assim.</span>
          </label>
        )}
        <p className="text-xs text-white/55">Antes de enviar para todos, use “Enviar teste” para ver como a mensagem chega na sua caixa de entrada.</p>
      </div>
    </Modal>
  );
}

export default function CampaignsTab() {
  const { user } = useAdmin();
  const toast = useToast();
  const confirm = useConfirm();
  const owner = user.role === 'owner';
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState(false);
  const [editor, setEditor] = useState<{ id: string | null } | null>(null);
  const [sendFor, setSendFor] = useState<EmailCampaign | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const sending = data?.campaigns.some((c) => c.status === 'sending') ?? false;

  const load = useCallback(async () => {
    try {
      setData(await api.get<ListResponse>('/api/admin/emails/campaigns'));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Enquanto há campanha sendo enviada e esta página está aberta, o painel “empurra” a fila (o dono) e atualiza os números.
  const busyRef = useRef(false);
  useEffect(() => {
    if (!sending) return;
    const timer = window.setInterval(async () => {
      if (busyRef.current || document.visibilityState !== 'visible') return;
      busyRef.current = true;
      try {
        if (owner) await api.post('/api/admin/emails/process', {}).catch(() => undefined);
        await load();
      } finally {
        busyRef.current = false;
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [sending, owner, load]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string, fail: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      await load();
    } catch (err) {
      toast.error(fail, friendlyError(err, ''));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (c: EmailCampaign) => {
    if (!(await confirm({ title: `Apagar o rascunho “${c.name}”?`, description: 'Não dá para desfazer.', confirmLabel: 'Apagar' }))) return;
    await run(`del:${c.id}`, () => api.delete(`/api/admin/emails/campaigns/${c.id}`), 'Rascunho apagado.', 'Não foi possível apagar.');
  };
  const cancel = async (c: EmailCampaign) => {
    if (!(await confirm({ title: `Parar o envio de “${c.name}”?`, description: 'O que ainda está na fila não sai. O que já foi enviado, já foi.', confirmLabel: 'Parar envio' }))) return;
    await run(`cancel:${c.id}`, () => api.post(`/api/admin/emails/campaigns/${c.id}/cancel`, {}), 'Envio cancelado.', 'Não foi possível cancelar.');
  };
  const test = (c: EmailCampaign) => run(`test:${c.id}`, () => api.post(`/api/admin/emails/campaigns/${c.id}/test`, {}), `Teste enviado para ${user.email}. Confira a caixa de entrada e o spam.`, 'Não foi possível enviar o teste.');

  if (error && !data) return <Card><ErrorState message="Não foi possível carregar as campanhas." onRetry={() => void load()} /></Card>;
  if (!data) return <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>;

  return (
    <div className="space-y-5">
      <Card
        title="Promoções por e-mail"
        description="Só chegam a quem aceitou receber (caixa desmarcada por padrão no cadastro) e confirmou o e-mail. Todo e-mail leva “Cancelar inscrição” com um clique."
        actions={owner ? <Button size="sm" icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => setEditor({ id: null })}>Nova campanha</Button> : undefined}
      >
        <p className="text-sm text-white/75">
          Hoje a lista tem <strong className="text-white">{n(data.audience)} pessoa(s)</strong> que podem receber. Limite de promoções: {n(data.promo_daily_limit)} por dia.
        </p>
        {data.free_sender && (
          <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs leading-relaxed text-amber-100">
            O remetente é um e-mail gratuito. Para promoções em volume, o ideal é um domínio próprio autenticado e um provedor de e-mail transacional (veja a aba Autenticação). Para enviar mesmo assim será preciso confirmar o risco.
          </p>
        )}
        {!owner && <p className="mt-3 text-xs text-white/55">Só o owner cria, testa e envia campanhas. Você pode acompanhar o andamento aqui.</p>}
      </Card>

      {data.campaigns.length === 0 ? (
        <Card>
          <EmptyState icon={<Megaphone className="h-6 w-6" aria-hidden="true" />} title="Nenhuma campanha ainda" description="Crie um rascunho, envie um teste para você e só então mande para a lista." />
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {data.campaigns.map((c) => {
            const st = CAMPAIGN_STATUS[c.status];
            const total = c.audience_total ?? 0;
            const done = c.sent + c.failed + c.skipped;
            return (
              <li key={c.id} className="rounded-2xl border border-white/[0.08] bg-[#0C1018] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-white">{c.name}</span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  <span className="ml-auto text-xs text-white/55">{c.started_at ? `iniciada ${timeAgo(c.started_at)}` : `criada ${timeAgo(c.created_at)}`}</span>
                </div>
                <p className="mt-1 truncate text-sm text-white/70">“{c.subject}”</p>
                {c.status !== 'draft' && (
                  <div className="mt-3">
                    <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-label="Andamento do envio" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(done, total)}>
                      <div className={cx('h-full rounded-full', c.status === 'cancelled' ? 'bg-white/30' : 'bg-emerald-400/80')} style={{ width: `${total ? Math.min(100, (done / total) * 100) : 0}%` }} />
                    </div>
                    <p className="mt-1.5 text-xs text-white/65">
                      {n(c.sent)} enviada(s) · {n(c.pending)} na fila · {n(c.failed)} falha(s) · {n(c.skipped)} puladas (descadastro, limite por pessoa...) de {n(total)}
                      {c.finished_at ? ` · terminou ${formatDateTime(c.finished_at)}` : ''}
                    </p>
                  </div>
                )}
                {c.status === 'sending' && <p className="mt-2 text-xs text-white/55">O envio continua sozinho enquanto esta página está aberta, a cada pedido e uma vez por dia. Se o limite diário de promoções acabar, o resto espera até o dia seguinte.</p>}
                {owner && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {c.status === 'draft' && (
                      <>
                        <Button size="sm" variant="secondary" icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => setEditor({ id: c.id })}>
                          Editar
                        </Button>
                        <Button size="sm" variant="secondary" loading={busy === `test:${c.id}`} onClick={() => void test(c)}>
                          Enviar teste para mim
                        </Button>
                        <Button size="sm" icon={<Play className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => setSendFor(c)}>
                          Enviar para a lista
                        </Button>
                        <Button size="sm" variant="danger-ghost" icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />} loading={busy === `del:${c.id}`} onClick={() => void remove(c)}>
                          Apagar
                        </Button>
                      </>
                    )}
                    {c.status === 'sending' && (
                      <Button size="sm" variant="danger-ghost" icon={<XCircle className="h-3.5 w-3.5" aria-hidden="true" />} loading={busy === `cancel:${c.id}`} onClick={() => void cancel(c)}>
                        Parar envio
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editor && <Editor id={editor.id} onClose={() => setEditor(null)} onSaved={() => void load()} />}
      {sendFor && <SendModal campaign={sendFor} audience={data.audience} freeSender={data.free_sender} promoLimit={data.promo_daily_limit} onClose={() => setSendFor(null)} onSent={() => void load()} />}
    </div>
  );
}
