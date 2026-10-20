// Avisos da operação por e-mail para os donos: (1) produtos com estoque baixo ou esgotado e (2) a rotina automática (cron) que falhou ou parou de rodar.
//
// Regras para não virar ruído:
//  • só avisa quando a situação MUDA (a lista de produtos ou o estado da rotina), no máximo UM e-mail por dono por dia;
//  • quando tudo volta ao normal, a lembrança é zerada: se o problema voltar, o aviso sai de novo;
//  • o aviso de estoque tem um interruptor (Estoque → "Avisar por e-mail"; liga/desliga store_settings.low_stock_email); o da rotina automática não;
//  • usa o serviço de e-mails de sempre (fila, nova tentativa, registro, tetos): se o envio de e-mail não estiver configurado, nada sai e nada quebra.
// Depois do envio, a lembrança do último estado avisado fica em job_runs (nome "ops_alert", só um resumo embaralhado do estado, sem nome de produto).
import { one, query } from './db.js';
import { deliver, processQueue } from './email/service.js';
import { readOpsState, stateKey } from './opsState.js';

async function remembered(): Promise<string> {
  return (await one<{ detail: string | null }>("select detail from job_runs where name = 'ops_alert'"))?.detail ?? '';
}
async function remember(key: string): Promise<void> {
  await query(
    `insert into job_runs (name, last_run_at, ok, detail) values ('ops_alert', now(), true, $1)
     on conflict (name) do update set last_run_at = now(), ok = true, detail = excluded.detail`,
    [key],
  );
}

let lastRun = 0;
// Avalia e, se a situação mudou, avisa os donos. `force`: ignora o intervalo mínimo de 10 minutos entre avaliações nesta instância. Devolve quantos e-mails entraram na fila.
export async function runOpsAlerts(req: Request, opts: { force?: boolean } = {}): Promise<number> {
  if (!opts.force && Date.now() - lastRun < 10 * 60_000) return 0;
  lastRun = Date.now();
  const state = await readOpsState();
  const key = stateKey(state);
  const before = await remembered();
  if (key === before) return 0;
  // Tudo normal de novo: zera a lembrança (um problema que voltar deve avisar de novo).
  if (key === '') {
    await remember('');
    return 0;
  }
  const owners = await query<{ email: string; name: string }>("select email, name from admins where role = 'owner' and active");
  // Dois processos avaliando ao mesmo tempo geram a MESMA chave: só um e-mail por dono por dia.
  const day = Math.floor(Date.now() / 86_400_000);
  let queued = 0;
  for (const owner of owners) {
    const result = await deliver({ kind: 'ops_alert', to: owner.email, spec: { name: owner.name }, req, attempt: 'later', dedupeKey: `ops:${owner.email.toLowerCase()}:${day}` });
    if (result.status === 'queued') queued += 1;
  }
  if (queued) {
    await remember(key);
    // Quem chama costuma estar DENTRO do processamento da fila (depois que ela rodou), e um novo disparo ali não faria outra rodada: envia agora, direto.
    await processQueue({ req, limit: 5, budgetMs: 4000 }).catch(() => undefined);
  }
  return queued;
}
