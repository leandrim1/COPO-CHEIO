import { ExternalLink, Mail, RotateCcw, Search, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, friendlyError } from '../../lib/api';
import { formatDateTime, timeAgo } from '../../lib/format';
import type { EmailEvent, EmailKindInfo, EmailMessageRow, EmailStatus } from '../../lib/types';
import { useAdmin } from '../AdminApp';
import { Badge, Button, Card, EmptyState, ErrorState, INPUT, Modal, Skeleton, cx, useConfirm, useToast } from '../ui';
import { ERROR_KIND, EVENT_SOURCE, EVENT_TYPE, STATUS_INFO, STATUS_ORDER } from './labels';

const PAGE = 30;

type Filters = { status: string; kind: string; category: string; from: string; to: string; q: string };
const EMPTY: Filters = { status: '', kind: '', category: '', from: '', to: '', q: '' };

function queryOf(filters: Filters, offset: number) {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value.trim()) p.set(key, value.trim());
  p.set('limit', String(PAGE));
  if (offset) p.set('offset', String(offset));
  return p.toString();
}

function StatusBadge({ status }: { status: EmailStatus }) {
  const info = STATUS_INFO[status];
  return (
    <span title={info.help}>
      <Badge tone={info.tone}>{info.label}</Badge>
    </span>
  );
}

// Uma frase sobre o que aconteceu com a mensagem (falha, bloqueio, próxima tentativa).
function problemText(m: EmailMessageRow): string | null {
  if (m.status === 'blocked' || m.status === 'cancelled') return m.block_label;
  if (m.error_kind && (m.status === 'failed' || m.status === 'queued')) {
    const label = ERROR_KIND[m.error_kind] ?? 'Falha ao enviar';
    return `${label}${m.error_code ? ` (${m.error_code})` : ''}`;
  }
  return null;
}

function Row({ m, onOpen }: { m: EmailMessageRow; onOpen: () => void }) {
  const problem = problemText(m);
  return (
    <li>
      <button type="button" onClick={onOpen} className="w-full rounded-2xl border border-white/[0.08] bg-[#0C1018] p-4 text-left transition-colors hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="font-bold text-white">{m.kind_label}</span>
          <StatusBadge status={m.status} />
          {m.category === 'promotional' && <Badge tone="violet">Promoção</Badge>}
          {m.audience === 'staff' && <Badge tone="gray">Equipe</Badge>}
          <span className="ml-auto text-xs text-white/55" title={formatDateTime(m.created_at)}>
            {timeAgo(m.created_at)}
          </span>
        </div>
        <p className="mt-1 truncate text-sm text-white/70">
          {m.recipient_email ?? <span className="italic text-white/50">endereço removido (pedido do titular)</span>}
          {m.order_number !== null && <span className="text-white/50"> · pedido #{m.order_number}</span>}
        </p>
        {m.subject && <p className="mt-0.5 truncate text-xs text-white/55">“{m.subject}”</p>}
        {problem && <p className={cx('mt-1.5 text-xs font-medium', m.status === 'failed' ? 'text-rose-300' : 'text-amber-200')}>{problem}</p>}
        {m.status === 'queued' && m.next_attempt_at && (
          <p className="mt-1 text-xs text-white/55">
            Tentativa {Math.max(m.attempts, 0)} de {m.max_attempts} · próxima {new Date(m.next_attempt_at).getTime() <= Date.now() ? 'agora' : `em ${formatDateTime(m.next_attempt_at)}`}
          </p>
        )}
      </button>
    </li>
  );
}

function Detail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { user } = useAdmin();
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<{ message: EmailMessageRow; events: EmailEvent[] } | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/admin/emails/messages/${id}`));
      setError(false);
    } catch {
      setError(true);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (what: 'retry' | 'cancel') => {
    if (what === 'cancel') {
      const ok = await confirm({ title: 'Cancelar o envio desta mensagem?', description: 'Ela não será enviada. Não dá para desfazer.', confirmLabel: 'Cancelar envio' });
      if (!ok) return;
    }
    setBusy(what);
    try {
      await api.post(`/api/admin/emails/messages/${id}/${what}`, {});
      toast.success(what === 'retry' ? 'Mensagem de volta para a fila.' : 'Envio cancelado.');
      onChanged();
      await load();
    } catch (err) {
      toast.error(what === 'retry' ? 'Não foi possível reenviar.' : 'Não foi possível cancelar.', friendlyError(err, ''));
    } finally {
      setBusy(null);
    }
  };

  const m = data?.message;
  return (
    <Modal open onClose={onClose} title={m ? m.kind_label : 'Mensagem'} description={m ? `${formatDateTime(m.created_at)}` : undefined} size="lg">
      {error && !data ? (
        <ErrorState message="Não foi possível carregar a mensagem." onRetry={() => void load()} />
      ) : !m ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={m.status} />
            {m.category === 'promotional' ? <Badge tone="violet">Promoção</Badge> : <Badge tone="gray">Transacional</Badge>}
            <span className="text-sm text-white/65">{STATUS_INFO[m.status].help}</span>
          </div>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-white/50">Para</dt><dd className="break-all text-white/90">{m.recipient_email ?? 'endereço removido'}</dd></div>
            <div><dt className="text-xs text-white/50">Assunto</dt><dd className="text-white/90">{m.subject ?? '—'}</dd></div>
            {m.order_number !== null && (
              <div>
                <dt className="text-xs text-white/50">Pedido</dt>
                <dd>
                  <a href={`/admin/pedidos/${m.order_number}`} className="inline-flex items-center gap-1 font-semibold text-[#8FB1FF] hover:text-white">
                    #{m.order_number} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </dd>
              </div>
            )}
            <div><dt className="text-xs text-white/50">Enviado por</dt><dd className="text-white/90">{m.transport === 'resend' ? 'Resend (API)' : m.transport === 'smtp' ? 'SMTP' : '—'}</dd></div>
            <div><dt className="text-xs text-white/50">Tentativas</dt><dd className="text-white/90">{m.attempts} de {m.max_attempts}</dd></div>
            {m.message_id && <div><dt className="text-xs text-white/50">Message-ID (para achar no Gmail/Outlook)</dt><dd className="break-all font-mono text-xs text-white/80">{m.message_id}</dd></div>}
            {m.provider_id && <div><dt className="text-xs text-white/50">Id no provedor</dt><dd className="break-all font-mono text-xs text-white/80">{m.provider_id}</dd></div>}
          </dl>
          {problemText(m) && (
            <p className={cx('rounded-xl p-3 text-sm', m.status === 'failed' ? 'bg-rose-500/10 text-rose-200' : 'bg-amber-400/10 text-amber-100')}>
              {problemText(m)}
              {m.error_detail && <span className="mt-1 block text-xs opacity-80">Resposta do servidor: {m.error_detail}</span>}
            </p>
          )}
          <section>
            <h3 className="mb-2 text-sm font-bold text-white/85">Linha do tempo</h3>
            {data!.events.length === 0 ? (
              <p className="text-sm text-white/55">Nenhum evento registrado.</p>
            ) : (
              <ol className="space-y-2.5 border-l border-white/10 pl-4">
                {data!.events.map((e) => (
                  <li key={e.id} className="relative text-sm">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-[#2563FF]" aria-hidden="true" />
                    <p className="font-semibold text-white/90">{EVENT_TYPE[e.type] ?? e.type}</p>
                    <p className="text-xs text-white/55">
                      {formatDateTime(e.occurred_at)} · {EVENT_SOURCE[e.provider] ?? e.provider}
                      {typeof e.detail?.attempt === 'number' ? ` · tentativa ${e.detail.attempt}` : ''}
                      {typeof e.detail?.code === 'string' ? ` · ${e.detail.code}` : ''}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
          {user.role === 'owner' && (m.can_retry && m.status === 'failed' || m.status === 'queued' || m.status === 'failed') && (
            <div className="flex flex-wrap gap-2 border-t border-white/[0.06] pt-4">
              {m.can_retry && m.status === 'failed' && (
                <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />} loading={busy === 'retry'} onClick={() => void act('retry')}>
                  Reenviar
                </Button>
              )}
              <Button size="sm" variant="danger-ghost" icon={<XCircle className="h-3.5 w-3.5" aria-hidden="true" />} loading={busy === 'cancel'} onClick={() => void act('cancel')}>
                Cancelar envio
              </Button>
            </div>
          )}
          <p className="text-[11px] text-white/45">O sistema não guarda o texto do e-mail, nem códigos, nem links de senha: só os dados acima.</p>
        </div>
      )}
    </Modal>
  );
}

export default function MessagesTab({ kinds, initial }: { kinds: EmailKindInfo[]; initial?: Partial<Filters> }) {
  const [filters, setFilters] = useState<Filters>({ ...EMPTY, ...initial });
  const [draft, setDraft] = useState(filters.q);
  const [rows, setRows] = useState<EmailMessageRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setFilters((f) => (f.q === draft ? f : { ...f, q: draft })), 350);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ messages: EmailMessageRow[]; has_more: boolean }>(`/api/admin/emails/messages?${queryOf(filters, 0)}`);
      setRows(data.messages);
      setMore(data.has_more);
      setError(false);
    } catch {
      setError(true);
    }
  }, [filters]);
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const data = await api.get<{ messages: EmailMessageRow[]; has_more: boolean }>(`/api/admin/emails/messages?${queryOf(filters, rows?.length ?? 0)}`);
      setRows((current) => [...(current ?? []), ...data.messages]);
      setMore(data.has_more);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const set = (key: keyof Filters) => (e: { target: { value: string } }) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const active = Object.entries(filters).some(([, v]) => v.trim());

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-2xl border border-white/[0.08] bg-[#0C1018] p-4 sm:grid-cols-2 lg:grid-cols-6">
        <label className="relative block sm:col-span-2">
          <span className="sr-only">Buscar por e-mail ou número do pedido</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/55" aria-hidden="true" />
          <input type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="E-mail ou nº do pedido" className={cx(INPUT, 'pl-9')} />
        </label>
        <label className="block">
          <span className="sr-only">Estado</span>
          <select value={filters.status} onChange={set('status')} className={INPUT}>
            <option value="">Todos os estados</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_INFO[s].label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="sr-only">Tipo de e-mail</span>
          <select value={filters.kind} onChange={set('kind')} className={INPUT}>
            <option value="">Todos os tipos</option>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="sr-only">Categoria</span>
          <select value={filters.category} onChange={set('category')} className={INPUT}>
            <option value="">Conta/pedido e promoções</option>
            <option value="transactional">Só conta e pedido</option>
            <option value="promotional">Só promoções</option>
          </select>
        </label>
        <div className="flex gap-2">
          <label className="block flex-1">
            <span className="sr-only">De</span>
            <input type="date" value={filters.from} onChange={set('from')} className={INPUT} aria-label="De (data)" />
          </label>
          <label className="block flex-1">
            <span className="sr-only">Até</span>
            <input type="date" value={filters.to} onChange={set('to')} className={INPUT} aria-label="Até (data)" />
          </label>
        </div>
        {active && (
          <div className="sm:col-span-2 lg:col-span-6">
            <Button size="sm" variant="ghost" onClick={() => { setFilters(EMPTY); setDraft(''); }}>
              Limpar filtros
            </Button>
          </div>
        )}
      </div>

      {error && !rows ? (
        <Card>
          <ErrorState message="Não foi possível carregar as mensagens." onRetry={() => void load()} />
        </Card>
      ) : !rows ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Mail className="h-6 w-6" aria-hidden="true" />} title={active ? 'Nenhuma mensagem com esses filtros' : 'Nenhuma mensagem ainda'} description={active ? 'Tente tirar algum filtro.' : 'Cada e-mail que o sistema enviar (ou barrar) aparece aqui.'} />
        </Card>
      ) : (
        <>
          <ul className="space-y-2.5">
            {rows.map((m) => (
              <Row key={m.id} m={m} onOpen={() => setOpenId(m.id)} />
            ))}
          </ul>
          {more && (
            <div className="flex justify-center">
              <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
                Carregar mais
              </Button>
            </div>
          )}
        </>
      )}
      {openId && <Detail id={openId} onClose={() => setOpenId(null)} onChanged={() => void load()} />}
    </div>
  );
}
