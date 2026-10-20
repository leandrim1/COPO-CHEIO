import { Scale, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, friendlyError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Badge, Button, Card, ErrorState, Field, INPUT, Spinner, useToast } from './ui';

// Termos e políticas editáveis (só o owner). O texto padrão descreve o que o sistema faz e não cita leis nem prazos: quem decide o que vale juridicamente é a loja, com
// o seu advogado. Marcar "revisado" é só uma anotação (quem e quando); mexer no texto tira essa marca.

type Page = { slug: string; title: string; body: string; reviewed_at: string | null; reviewed_by: string | null; updated_at: string };

const PATH: Record<string, string> = { termos: '/termos', 'trocas-e-cancelamentos': '/trocas-e-cancelamentos', entrega: '/entrega', 'pagamento-e-reembolso': '/pagamento-e-reembolso', 'contato-e-responsavel': '/contato-e-responsavel' };

function Editor({ page, onSaved }: { page: Page; onSaved: (p: Page) => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(page.title);
  const [body, setBody] = useState(page.body);
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState<'save' | 'review' | null>(null);
  const [error, setError] = useState('');
  const dirty = title !== page.title || body !== page.body;

  const save = async () => {
    setError('');
    setBusy('save');
    try {
      const { page: saved } = await api.put<{ page: Page }>(`/api/admin/legal/${page.slug}`, { title, body });
      onSaved(saved);
      toast.success('Texto salvo.', saved.reviewed_at ? undefined : 'Marcado como “ainda não revisado”.');
    } catch (e) {
      setError(friendlyError(e, 'Não foi possível salvar o texto.'));
    } finally {
      setBusy(null);
    }
  };

  const review = async () => {
    setError('');
    setBusy('review');
    try {
      const { page: saved } = await api.post<{ page: Page }>(`/api/admin/legal/${page.slug}/review`, { reviewed_by: who });
      onSaved(saved);
      setWho('');
      toast.success('Anotado como revisado.');
    } catch (e) {
      setError(friendlyError(e, 'Não foi possível anotar a revisão.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={page.title}
      description={
        <>
          Página pública: <a href={PATH[page.slug]} target="_blank" rel="noopener noreferrer" className="text-[#8FB1FF] underline-offset-4 hover:underline">{PATH[page.slug]}</a>
        </>
      }
      actions={page.reviewed_at ? <Badge tone="green">Revisado por {page.reviewed_by} em {formatDateTime(page.reviewed_at)}</Badge> : <Badge tone="amber">Ainda não revisado juridicamente</Badge>}
    >
      <div data-legal-editor={page.slug} className="space-y-4">
        <Field label="Título" count={title.length} max={80}>
          {(p) => <input {...p} className={INPUT} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="Texto" hint="“## Título” abre uma seção, “- item” faz uma lista, o resto são parágrafos (linha em branco separa). Só texto: HTML não funciona." count={body.length} max={20000}>
          {(p) => <textarea {...p} className={`${INPUT} min-h-64 font-mono text-[13px] leading-relaxed`} rows={14} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} data-legal-body />}
        </Field>
        {error && (
          <p role="alert" className="text-sm font-medium text-rose-300">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Revisado por (nome)">
              {(p) => <input {...p} className={`${INPUT} w-56`} maxLength={120} value={who} onChange={(e) => setWho(e.target.value)} placeholder="Ex.: Dra. Maria" disabled={dirty} />}
            </Field>
            <Button variant="secondary" loading={busy === 'review'} disabled={dirty || who.trim().length < 2} onClick={() => void review()} icon={<Scale className="h-4 w-4" aria-hidden="true" />}>
              Anotar como revisado
            </Button>
          </div>
          <Button loading={busy === 'save'} disabled={!dirty} onClick={() => void save()} data-legal-save>
            Salvar texto
          </Button>
        </div>
        {dirty && <p className="text-xs text-white/55">Salve o texto antes de anotar a revisão. Mudar o texto tira a marca de “revisado”.</p>}
      </div>
    </Card>
  );
}

export function LegalPagesCard() {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try {
      setPages((await api.get<{ pages: Page[] }>('/api/admin/legal')).pages);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !pages) return <Card><ErrorState message="Não foi possível carregar os textos." onRetry={() => void load()} /></Card>;
  if (!pages) return <Spinner />;
  const pending = pages.filter((p) => !p.reviewed_at).length;
  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          Estes textos descrevem o que o site faz hoje, mas <strong>não são parecer jurídico</strong>. Peça para um advogado revisar antes de depender deles
          {pending ? ` (${pending} de ${pages.length} ainda sem revisão)` : ''}. Veja também <code>docs/JURIDICO-PENDENCIAS.md</code>.
        </span>
      </p>
      {pages.map((page) => (
        <Editor key={page.slug} page={page} onSaved={(next) => setPages((list) => list?.map((x) => (x.slug === next.slug ? next : x)) ?? null)} />
      ))}
    </div>
  );
}
