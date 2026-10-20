import { Check, Copy, LoaderCircle, Star } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, friendlyError } from '../lib/api';
import { money } from '../lib/format';
import { ErrorLine, Panel } from './accountUi';
import { BLUE_BUTTON } from './ui';

// "Meus pontos": só aparece se a loja ligou o programa. As regras (quanto vale cada real, quantos pontos para trocar, o valor e a validade do cupom) vêm do servidor, que
// é quem credita, estorna e troca. A troca gera um cupom PESSOAL: só esta conta usa, no campo de cupom do checkout.

type Movement = { kind: 'earn' | 'reverse' | 'redeem' | 'adjust'; points: number; note: string | null; created_at: string };
type Info = {
  enabled: boolean;
  balance?: number;
  rules?: { points_per_real: number | null; redeem_points: number | null; reward_value: number | null; coupon_days: number | null };
  movements?: Movement[];
  coupons?: { code: string; value: string | number; ends_at: string | null }[];
};

const KIND_LABEL: Record<Movement['kind'], string> = { earn: 'Pontos ganhos', reverse: 'Estorno', redeem: 'Troca por cupom', adjust: 'Acerto da loja' };
const date = (iso: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(iso));
const pts = (n: number) => `${n > 0 ? '+' : ''}${n.toLocaleString('pt-BR')}`;

export function LoyaltyPanel() {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState<{ code: string; value: number; expires_at: string } | null>(null);
  const [copied, setCopied] = useState('');
  const [all, setAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api.get<Info>('/api/account/loyalty'));
    } catch {
      setInfo({ enabled: false });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!info?.enabled || !info.rules) return null;
  const { rules, balance = 0, movements = [], coupons = [] } = info;
  const need = rules.redeem_points ?? 0;
  const can = need > 0 && balance >= need;

  const redeem = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await api.post<{ coupon: { code: string; value: number; expires_at: string } }>('/api/account/loyalty/redeem', {});
      setFresh(data.coupon);
      await load();
    } catch (e) {
      setError(friendlyError(e, 'Não foi possível trocar os pontos agora.'));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      window.setTimeout(() => setCopied(''), 2000);
    } catch {
      /* sem permissão de área de transferência: o código está na tela */
    }
  };

  const shown = all ? movements : movements.slice(0, 5);
  return (
    <div data-loyalty>
      <Panel id="pontos" title="Meus pontos" subtitle={`${rules.points_per_real} ponto${rules.points_per_real === 1 ? '' : 's'} a cada R$ 1,00 em produtos (sem a entrega), quando o pedido é entregue. ${need} pontos viram um cupom de ${money(rules.reward_value ?? 0)}, válido por ${rules.coupon_days} dias.`}>
        <p className="flex items-center gap-2 text-3xl font-black text-white" aria-live="polite">
          <Star className="h-7 w-7 fill-amber-300 text-amber-300" aria-hidden="true" />
          <span data-loyalty-balance>{balance.toLocaleString('pt-BR')}</span>
          <span className="text-base font-semibold text-white/60">{balance === 1 || balance === -1 ? 'ponto' : 'pontos'}</span>
        </p>
        {balance < 0 && <p className="mt-2 text-sm text-amber-200/90">O saldo ficou negativo porque um pedido foi devolvido depois de os pontos serem trocados. Ele volta a crescer com os próximos pedidos.</p>}
        {!can && balance >= 0 && need > 0 && <p className="mt-2 text-sm text-white/60">Faltam {(need - balance).toLocaleString('pt-BR')} pontos para a próxima troca.</p>}
        <button type="button" onClick={() => void redeem()} disabled={!can || busy} data-loyalty-redeem className={`${BLUE_BUTTON} mt-4 w-full disabled:cursor-not-allowed disabled:opacity-50`}>
          {busy ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> : null}
          Trocar {need} pontos por {money(rules.reward_value ?? 0)}
        </button>
        {error && (
          <div className="mt-3">
            <ErrorLine>{error}</ErrorLine>
          </div>
        )}
        {fresh && (
          <p role="status" data-loyalty-new className="mt-4 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-3.5 py-3 text-sm text-emerald-100">
            Seu cupom de {money(fresh.value)}: <strong className="font-mono text-base text-white">{fresh.code}</strong>. Use no campo de cupom ao finalizar o pedido, com esta conta (vale até {date(fresh.expires_at)}).
          </p>
        )}
        {coupons.length > 0 && (
          <div className="mt-5">
            <h3 className="text-sm font-bold text-white">Seus cupons de troca</h3>
            <ul className="mt-2 space-y-2" data-loyalty-coupons>
              {coupons.map((c) => (
                <li key={c.code} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono font-bold text-white">{c.code}</span>
                    <span className="block text-xs text-white/60">
                      {money(Number(c.value))}
                      {c.ends_at ? ` · até ${date(c.ends_at)}` : ''}
                    </span>
                  </span>
                  <button type="button" onClick={() => void copy(c.code)} className="tap inline-flex h-9 items-center gap-1.5 rounded-full border border-white/20 px-3 text-xs font-semibold text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" aria-label={`Copiar o cupom ${c.code}`}>
                    {copied === c.code ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                    {copied === c.code ? 'Copiado' : 'Copiar'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {movements.length > 0 && (
          <div className="mt-5">
            <h3 className="text-sm font-bold text-white">Extrato</h3>
            <ul className="mt-2 divide-y divide-white/10 text-sm" data-loyalty-movements>
              {shown.map((m, i) => (
                <li key={`${m.created_at}-${i}`} className="flex items-baseline gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-white/85">{KIND_LABEL[m.kind]}</span>
                    {m.note && <span className="block truncate text-xs text-white/55">{m.note}</span>}
                  </span>
                  <span className="text-xs text-white/50">{date(m.created_at)}</span>
                  <span className={`w-16 text-right font-bold tabular-nums ${m.points > 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{pts(m.points)}</span>
                </li>
              ))}
            </ul>
            {movements.length > 5 && (
              <button type="button" onClick={() => setAll((v) => !v)} className="mt-2 text-sm font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
                {all ? 'Ver menos' : 'Ver tudo'}
              </button>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
