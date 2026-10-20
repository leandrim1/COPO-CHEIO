import { Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, friendlyError } from '../lib/api';
import type { PublicOrder } from '../lib/types';
import { FIELD } from './ui';

// "Como foi seu pedido?": aparece só depois da entrega, uma vez por pedido. A avaliação vai para a loja (que decide se publica) e não leva nome nem telefone.

type Review = { rating: number; comment: string | null; status: 'pending' | 'published' | 'hidden' };

export function ReviewCard({ order, token, mine }: { order: PublicOrder; token?: string; mine: boolean }) {
  const base = token ? `/api/tracking/${encodeURIComponent(token)}/review` : mine ? `/api/account/orders/${order.order_number}/review` : null;
  const [review, setReview] = useState<Review | null | undefined>(undefined);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const delivered = order.order_status === 'delivered';

  useEffect(() => {
    if (!base || !delivered) return;
    let alive = true;
    api.get<{ review: Review | null }>(base).then(
      (data) => alive && setReview(data.review),
      () => alive && setReview(null),
    );
    return () => {
      alive = false;
    };
  }, [base, delivered]);

  if (!base || !delivered || review === undefined) return null;

  const send = async () => {
    if (rating < 1) return setError('Toque nas estrelas para dar uma nota.');
    setBusy(true);
    setError('');
    try {
      const data = await api.post<{ review: Review }>(base, { rating, ...(comment.trim() ? { comment: comment.trim() } : {}) });
      setReview(data.review);
    } catch (e) {
      setError(friendlyError(e, 'Não foi possível enviar a avaliação agora.'));
    } finally {
      setBusy(false);
    }
  };

  const shown = hover || rating;
  return (
    <section aria-labelledby="avaliar" className="rounded-[1.75rem] border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
      <h2 id="avaliar" className="text-base font-black text-white">
        Como foi seu pedido?
      </h2>
      {review ? (
        <div data-review-done role="status" className="mt-2 text-sm text-white/75">
          <p className="flex items-center gap-1" aria-label={`Sua nota: ${review.rating} de 5`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Star key={n} className={`h-5 w-5 ${n <= review.rating ? 'fill-amber-300 text-amber-300' : 'text-white/25'}`} aria-hidden="true" />
            ))}
          </p>
          <p className="mt-2">Obrigado pela avaliação! Ela ajuda a loja a melhorar.</p>
          {review.comment && <p className="mt-1 text-white/60">“{review.comment}”</p>}
        </div>
      ) : (
        <div data-review-form className="mt-2">
          <div role="radiogroup" aria-label="Sua nota de 1 a 5" className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                aria-label={`${n} ${n === 1 ? 'estrela' : 'estrelas'}`}
                data-star={n}
                onClick={() => (setRating(n), setError(''))}
                onMouseEnter={() => setHover(n)}
                onMouseLeave={() => setHover(0)}
                className="grid h-11 w-11 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <Star className={`h-7 w-7 ${n <= shown ? 'fill-amber-300 text-amber-300' : 'text-white/30'}`} aria-hidden="true" />
              </button>
            ))}
          </div>
          <label htmlFor="avaliacao-comentario" className="mt-3 block text-[13px] font-semibold text-white/80">
            Quer contar mais? (opcional)
          </label>
          <textarea
            id="avaliacao-comentario"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={500}
            rows={3}
            data-review-comment
            placeholder="Não escreva dados pessoais (telefone, endereço...)."
            className={`${FIELD} mt-1.5 resize-none`}
          />
          {error && (
            <p role="alert" className="mt-2 text-sm font-semibold text-rose-300">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy}
            data-review-send
            className="mt-3 inline-flex min-h-11 items-center justify-center rounded-full bg-[#145CFF] px-6 text-sm font-bold text-white transition-colors hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-60"
          >
            {busy ? 'Enviando…' : 'Enviar avaliação'}
          </button>
        </div>
      )}
    </section>
  );
}
