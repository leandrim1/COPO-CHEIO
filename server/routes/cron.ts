// Rotina automática (cron): o que não pode depender de alguém estar com o painel aberto. Chamada pela Vercel (cron) ou por um agendador externo gratuito, sempre com
// "Authorization: Bearer <CRON_SECRET>". Sem CRON_SECRET a rota recusa tudo.
//  • encerra o Pix/cartão que venceu (e cancela a cobrança na operadora), devolve o estoque do pedido não pago;
//  • manda o que está na fila de e-mail e limpa dados técnicos vencidos;
//  • registra quando rodou e se deu certo (o painel mostra em "Estado do sistema").
import { timingSafeEqual } from 'node:crypto';
import { processQueue } from '../email/service.js';
import { one, query } from '../db.js';
import { HttpError, json } from '../http.js';
import type { Router } from '../http.js';
import { runOpsAlerts } from '../opsAlerts.js';
import { sweep } from '../payments/service.js';

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function recordJob(name: string, ok: boolean, detail: string): Promise<void> {
  await query(
    `insert into job_runs (name, last_run_at, ok, detail) values ($1, now(), $2, left($3, 300))
     on conflict (name) do update set last_run_at = now(), ok = excluded.ok, detail = excluded.detail`,
    [name, ok, detail],
  ).catch(() => undefined);
}

export function authorizedCron(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? '').trim();
  return Boolean(secret) && same(req.headers.get('authorization') ?? '', `Bearer ${secret}`);
}

export function registerCron(r: Router) {
  r.get('/api/cron/sweep', 'public', async (ctx) => {
    if (!authorizedCron(ctx.req)) throw new HttpError(401, 'Não autorizado.');
    try {
      const swept = await sweep({ lookups: true, force: true, limit: 50 });
      await query('select purge_expired_data()');
      await recordJob('sweep', true, `verificados ${swept.checked}, encerrados ${swept.closed}, cancelados ${swept.cancelled}`);
      // Avisos da operação (estoque baixo, rotina com problema) ANTES da fila: entram nela e saem nesta mesma execução. Uma rotina que falhou é avisada pela
      // próxima atividade do site ou pelo cron de e-mails (esta execução, se tivesse falhado, nem chegaria aqui).
      const ops = await runOpsAlerts(ctx.req, { force: true }).catch(() => 0);
      const queue = await processQueue({ req: ctx.req, limit: 25, budgetMs: 6000 });
      return json({ ok: true, swept, queue, ops_alerts_queued: ops });
    } catch (error) {
      await recordJob('sweep', false, error instanceof Error ? error.message : 'erro');
      throw error;
    }
  });

  // Estado das rotinas (só quem tem o segredo): para um monitor externo checar se a rotina anda rodando.
  r.get('/api/cron/status', 'public', async (ctx) => {
    if (!authorizedCron(ctx.req)) throw new HttpError(401, 'Não autorizado.');
    const row = await one<{ last_run_at: string; ok: boolean; age: number }>("select last_run_at, ok, extract(epoch from now() - last_run_at)::int as age from job_runs where name = 'sweep'");
    return json({ sweep: row ?? null });
  });
}
