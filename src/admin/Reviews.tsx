import { Eye, EyeOff, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, friendlyError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { ReviewRow } from '../lib/types';
import { Badge, Button, Card, EmptyState, ErrorState, IconButton, PageHeader, Skeleton, cx, useConfirm, useToast } from './ui';

// Avaliações dos pedidos entregues. Nascem "aguardando": só aparecem no site depois que a loja publica. O cliente não deixa nome nem telefone na avaliação
// (o painel mostra de qual pedido veio, para a loja poder conversar com a pessoa se quiser).

type Summary = { total: number; pending: number; published: number; average: number | null };
const FILTERS = [
  ['pending', 'Aguardando'],
  ['published', 'Publicadas'],
  ['hidden', 'Escondidas'],
  ['', 'Todas'],
] as const;
const TONE = { pending: 'amber', published: 'green', hidden: 'gray' } as const;
const LABEL = { pending: 'Aguardando', published: 'Publicada', hidden: 'Escondida' } as const;

export function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`Nota ${value} de 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={cx('h-4 w-4', n <= value ? 'fill-amber-300 text-amber-300' : 'text-white/20')} aria-hidden="true" />
      ))}
    </span>
  );
}

export default function ReviewsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<string>('pending');
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ reviews: ReviewRow[]; summary: Summary }>(`/api/admin/reviews${filter ? `?status=${filter}` : ''}`);
      setRows(data.reviews);
      setSummary(data.summary);
      setError(false);
    } catch {
      setError(true);
    }
  }, [filter]);
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  const moderate = async (row: ReviewRow, status: ReviewRow['status']) => {
    try {
      await api.patch(`/api/admin/reviews/${row.id}`, { status });
      toast.success(status === 'published' ? 'Avaliação publicada no site.' : 'Avaliação escondida do site.');
      void load();
    } catch (e) {
      toast.error('Não foi possível atualizar.', friendlyError(e, ''));
    }
  };
  const remove = async (row: ReviewRow) => {
    if (!(await confirm({ title: `Apagar a avaliação do pedido #${row.order_number}?`, description: 'Use para tirar um comentário com dado pessoal. Não dá para desfazer.', confirmLabel: 'Apagar' }))) return;
    try {
      await api.delete(`/api/admin/reviews/${row.id}`);
      toast.success('Avaliação apagada.');
      void load();
    } catch (e) {
      toast.error('Não foi possível apagar.', friendlyError(e, ''));
    }
  };

  return (
    <>
      <PageHeader title="Avaliações" description="O cliente avalia o pedido depois da entrega. Só aparece no site o que você publicar (a nota e o comentário, sem nome nem telefone)." />
      {summary && (
        <p className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-white/70" data-reviews-summary>
          <span>
            Nota média: <strong className="text-white">{summary.average === null ? '—' : String(summary.average).replace('.', ',')}</strong> ({summary.total} avaliações)
          </span>
          <span>{summary.published} publicadas</span>
          {summary.pending > 0 && <Badge tone="amber">{summary.pending} aguardando sua decisão</Badge>}
        </p>
      )}
      <div role="group" aria-label="Filtro" className="mb-4 inline-flex max-w-full flex-wrap rounded-xl border border-white/10 bg-[#0C1018] p-1">
        {FILTERS.map(([value, label]) => (
          <button
            key={value || 'todas'}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={cx('rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors', filter === value ? 'bg-[#145CFF] text-white' : 'text-white/60 hover:text-white')}
          >
            {label}
          </button>
        ))}
      </div>
      {error && !rows ? (
        <Card>
          <ErrorState message="Não foi possível carregar as avaliações." onRetry={() => void load()} />
        </Card>
      ) : !rows ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Star className="h-6 w-6" aria-hidden="true" />} title="Nenhuma avaliação aqui" description="Quando um cliente avaliar um pedido entregue, ela aparece nesta lista." />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-white/[0.06]" aria-label="Avaliações">
            {rows.map((row) => (
              <li key={row.id} data-review={row.status} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="flex flex-wrap items-center gap-2">
                    <Stars value={row.rating} />
                    <Badge tone={TONE[row.status]}>{LABEL[row.status]}</Badge>
                    <span className="text-xs text-white/55">
                      Pedido <a href={`/admin/pedidos/${row.order_number}`} className="font-semibold text-[#8FB1FF] hover:underline">#{row.order_number}</a> · {formatDateTime(row.created_at)}
                    </span>
                  </p>
                  {row.comment ? <p className="mt-1.5 whitespace-pre-line text-sm text-white/85">“{row.comment}”</p> : <p className="mt-1.5 text-sm text-white/45">Sem comentário.</p>}
                </div>
                <div className="flex items-center gap-1">
                  {row.status !== 'published' && (
                    <Button size="sm" variant="secondary" icon={<Eye className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => void moderate(row, 'published')} data-review-publish>
                      Publicar
                    </Button>
                  )}
                  {row.status !== 'hidden' && (
                    <Button size="sm" variant="ghost" icon={<EyeOff className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => void moderate(row, 'hidden')}>
                      Esconder
                    </Button>
                  )}
                  <IconButton label={`Apagar a avaliação do pedido ${row.order_number}`} className="hover:text-rose-300" onClick={() => void remove(row)}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
