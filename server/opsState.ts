// O que o aviso da operação (estoque e rotina automática) olha: só leitura do banco, sem e-mail (quem envia é server/opsAlerts.ts; quem monta o texto na hora do envio é server/email/render.ts).
import { createHash } from 'node:crypto';
import { one, query } from './db.js';

export type OpsState = {
  low: { name: string; stock: number; limit: number }[];
  out: { name: string }[];
  // A rotina automática (cron) falhou na última vez, ou já faz mais de 30 horas que não roda (o cron da Vercel é diário). Só existe se ela já rodou alguma vez.
  job: { problem: 'failed' | 'stale'; lastRunAt: string; detail: string | null } | null;
};

const STALE_HOURS = 30;
const LIMIT = 200;

export async function readOpsState(): Promise<OpsState> {
  const cfg = await one<{ low_stock_email: boolean }>('select low_stock_email from store_settings where id = 1');
  let low: OpsState['low'] = [];
  let out: OpsState['out'] = [];
  if (cfg?.low_stock_email) {
    // Mesma definição do painel inicial: produto ativo com estoque controlado; baixo = acima de 0 e até o limite (do produto ou o padrão da loja).
    const rows = await query<{ name: string; stock: number; lim: number }>(
      `select p.name, p.stock, coalesce(p.low_stock_threshold, s.low_stock_default) as lim
         from products p cross join store_settings s
        where p.active and p.stock is not null and s.id = 1 and (p.stock <= 0 or p.stock <= coalesce(p.low_stock_threshold, s.low_stock_default))
        order by p.stock, p.name limit ${LIMIT}`,
    );
    low = rows.filter((r) => r.stock > 0).map((r) => ({ name: r.name, stock: Number(r.stock), limit: Number(r.lim) }));
    out = rows.filter((r) => r.stock <= 0).map((r) => ({ name: r.name }));
  }
  const sweep = await one<{ last_run_at: string; ok: boolean; detail: string | null; hours: number }>("select last_run_at, ok, detail, extract(epoch from now() - last_run_at) / 3600 as hours from job_runs where name = 'sweep'");
  let job: OpsState['job'] = null;
  if (sweep && !sweep.ok) job = { problem: 'failed', lastRunAt: new Date(sweep.last_run_at).toISOString(), detail: sweep.detail };
  else if (sweep && Number(sweep.hours) > STALE_HOURS) job = { problem: 'stale', lastRunAt: new Date(sweep.last_run_at).toISOString(), detail: null };
  return { low, out, job };
}

export const isEmptyState = (s: OpsState): boolean => s.low.length === 0 && s.out.length === 0 && s.job === null;

// Resumo do estado (para saber se mudou desde o último aviso): nomes dos produtos e o tipo de problema da rotina; a quantidade exata não conta, para o estoque que cai de 4 para 3 não gerar outro e-mail.
export function stateKey(s: OpsState): string {
  if (isEmptyState(s)) return '';
  const names = (list: { name: string }[]) => list.map((p) => p.name).sort().join('\u0001');
  return createHash('sha1').update(`low:${names(s.low)}|out:${names(s.out)}|job:${s.job?.problem ?? ''}`).digest('hex');
}
