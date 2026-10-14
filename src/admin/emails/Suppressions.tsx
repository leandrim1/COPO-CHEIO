import { Ban, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, friendlyError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { EmailSuppression } from '../../lib/types';
import { useAdmin } from '../AdminApp';
import { Badge, Button, Card, EmptyState, ErrorState, INPUT, Skeleton, cx, useConfirm, useToast } from '../ui';
import { SUPPRESSION_REASON } from './labels';

export default function SuppressionsTab() {
  const { user } = useAdmin();
  const toast = useToast();
  const confirm = useConfirm();
  const owner = user.role === 'owner';
  const [rows, setRows] = useState<EmailSuppression[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(false);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ suppressions: EmailSuppression[]; has_more: boolean }>('/api/admin/emails/suppressions?limit=100');
      setRows(data.suppressions);
      setMore(data.has_more);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      toast.error('Confira o e-mail.');
      return;
    }
    setBusy('add');
    try {
      await api.post('/api/admin/emails/suppressions', { email: email.trim(), note: note.trim() || undefined });
      toast.success('Endereço colocado na lista: não receberá mais nenhum e-mail do sistema.');
      setEmail('');
      setNote('');
      await load();
    } catch (err) {
      toast.error('Não foi possível adicionar.', friendlyError(err, ''));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: EmailSuppression) => {
    const ok = await confirm({
      title: `Liberar ${s.email}?`,
      description: 'O endereço volta a receber e-mails (códigos, avisos de pedido). Faça isso só se tiver certeza de que a caixa existe de novo, ou se o dono do endereço pediu.',
      confirmLabel: 'Liberar endereço',
    });
    if (!ok) return;
    setBusy(`del:${s.email}`);
    try {
      await api.delete(`/api/admin/emails/suppressions/${encodeURIComponent(s.email)}`);
      toast.success('Endereço liberado.');
      await load();
    } catch (err) {
      toast.error('Não foi possível liberar.', friendlyError(err, ''));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <Card title="Lista de supressão" description="Endereços que não recebem mais nada: caixa inexistente, reclamação de spam, devoluções temporárias repetidas ou bloqueio manual. O sistema coloca endereços aqui sozinho, para não insistir e não prejudicar a reputação do remetente.">
        {owner ? (
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-white/80">Colocar um endereço na lista</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={INPUT} placeholder="pessoa@exemplo.com" autoComplete="off" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-white/80">Observação (opcional)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={INPUT} placeholder="Ex.: pediu para não receber" />
            </label>
            <Button type="submit" icon={<Plus className="h-4 w-4" aria-hidden="true" />} loading={busy === 'add'}>
              Adicionar
            </Button>
          </form>
        ) : (
          <p className="text-xs text-white/55">Só o owner coloca ou libera endereços. Você pode consultar a lista.</p>
        )}
      </Card>

      {error && !rows ? (
        <Card><ErrorState message="Não foi possível carregar a lista." onRetry={() => void load()} /></Card>
      ) : !rows ? (
        <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-16 rounded-2xl" />)}</div>
      ) : rows.length === 0 ? (
        <Card><EmptyState icon={<Ban className="h-6 w-6" aria-hidden="true" />} title="Nenhum endereço na lista" description="Quando um servidor de e-mail recusar um endereço de vez, ele aparece aqui." /></Card>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((s) => (
            <li key={s.email} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-[#0C1018] p-4">
              <div className="min-w-0">
                <p className="break-all font-semibold text-white">{s.email}</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/60">
                  <Badge tone={s.reason === 'complaint' ? 'red' : s.reason === 'repeated_soft' ? 'amber' : 'gray'}>{SUPPRESSION_REASON[s.reason] ?? s.reason}</Badge>
                  <span>{formatDateTime(s.created_at)}</span>
                  <span>· {s.source === 'webhook' ? 'aviso do provedor' : s.source === 'admin' ? 'painel' : 'recusa do servidor de e-mail'}</span>
                  {s.expires_at && <span>· libera sozinho em {formatDateTime(s.expires_at)}</span>}
                </p>
                {s.detail && <p className="mt-1 text-xs text-white/50">{s.detail}</p>}
              </div>
              {owner && (
                <Button size="sm" variant="danger-ghost" icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />} loading={busy === `del:${s.email}`} onClick={() => void remove(s)}>
                  Liberar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {more && <p className={cx('text-center text-xs text-white/50')}>Mostrando os 100 mais recentes.</p>}
    </div>
  );
}
