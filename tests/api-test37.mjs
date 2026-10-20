// Avisos da operação por e-mail para os donos (estoque baixo/esgotado e rotina automática com problema), usando o serviço de e-mails de sempre (caixa simulada do servidor de teste).
//  • estoque: produto ativo com estoque controlado, acima de 0 e até o limite = baixo; 0 = esgotado; produto sem controle e produto inativo não entram;
//  • um e-mail por dono, só quando a LISTA muda (a quantidade que cai de 3 para 2 não gera outro), no máximo um por dia, e tudo normal zera a lembrança;
//  • o interruptor do painel (Estoque → "Avisar por e-mail") desliga o aviso de estoque;
//  • rotina automática que falhou ou parou de rodar vira aviso na próxima atividade do site (não depende de a própria rotina estar viva);
//  • nada de dado de cliente no e-mail; só dono recebe; atendente não.
// usage: bash tests/fresh.sh && node tests/api-test37.mjs      (BASE e TEST_DB escolhem o servidor e o banco; reinicia o servidor de teste uma vez)
import { execFileSync, execSync } from 'node:child_process';
import { Client, check, mailsTo, section, summary } from './lib.mjs';

const root = new URL('..', import.meta.url).pathname;
const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const serve = (env = {}) => execSync(`bash ${process.env.SERVE_SCRIPT ?? `${root}tests/serve.sh`}`, { env: { ...process.env, ...env }, stdio: 'ignore' });
const CRON = { authorization: 'Bearer segredo-do-cron-so-de-teste-0123456789' };
const OWNER = 'dono@copocheio.local';
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const owner = new Client(undefined, '198.51.100.130');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true, low_stock_default: 5, low_stock_email: true });
const staff = new Client(undefined, '198.51.100.131');
await owner.post('/api/admin/admins', { name: 'Atendente Ops', email: 'atendente37@copocheio.local', password: 'senha-forte-456', role: 'admin' });
const anon = new Client(undefined, '198.51.100.132');
const cat = (await owner.post('/api/admin/categories', { name: 'Operação' })).data.category;
const mk = async (name, extra) => (await owner.post('/api/admin/products', { name, price: 10, category_id: cat.id, confirm_duplicate: true, alcoholic: false, ...extra })).data.product;
const baixo = await mk('Produto Baixo Ops', { stock: 3 });
await mk('Produto Cheio Ops', { stock: 50 });
const esgotado = await mk('Produto Esgotado Ops', { stock: 0 });
await mk('Produto Sem Controle Ops', {});
const inativo = await mk('Produto Inativo Ops', { stock: 1 });
await owner.patch(`/api/admin/products/${inativo.id}`, { active: false });
const setStock = (id, n) => psql(`update products set stock = ${n} where id = '${id}'`);
const sweep = () => anon.get('/api/cron/sweep', { headers: CRON });
const inbox = async () => (await mailsTo(OWNER)).filter((m) => /^Aviso: /.test(m.subject ?? ''));
const opsRows = () => Number(psql("select count(*) from email_messages where kind = 'ops_alert'"));
const waitFor = async (fn, ms = 6000) => {
  for (let i = 0; i < ms / 100; i += 1) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};

// ------------------------------------------------------------------------------------------------
section('1. Estoque baixo e esgotado: um e-mail para o dono, com a lista certa');
{
  const run = await sweep();
  check('a rotina responde 200 e enfileira o aviso de um dono', run.status === 200 && run.data.ops_alerts_queued === 1, run.data);
  await waitFor(async () => (await inbox()).length >= 1);
  const [mail] = await inbox();
  check('o dono recebe o aviso, com o assunto da situação', Boolean(mail) && /1 produto com estoque baixo e 1 produto esgotado/.test(mail.subject), mail?.subject);
  const body = `${mail?.text ?? ''}`;
  check('o e-mail lista o produto baixo (com a quantidade) e o esgotado', /Produto Baixo Ops/.test(body) && /3 un\./.test(body) && /Produto Esgotado Ops/.test(body), body.slice(0, 400));
  check('...e NÃO lista produto cheio, sem controle de estoque nem inativo', !/Produto Cheio Ops|Produto Sem Controle Ops|Produto Inativo Ops/.test(body));
  check('só o dono recebe (o atendente não)', (await mailsTo('atendente37@copocheio.local')).filter((m) => /^Aviso: /.test(m.subject ?? '')).length === 0);
  check('o registro de e-mails tem o tipo certo, para a equipe, sem corpo', JSON.parse(psql("select row_to_json(m) from email_messages m where kind = 'ops_alert' order by created_at desc limit 1")).audience === 'staff');
  check('a lembrança guardada é só um resumo embaralhado (nada de nome de produto)', /^[0-9a-f]{40}$/.test(psql("select detail from job_runs where name = 'ops_alert'")));
}

// ------------------------------------------------------------------------------------------------
section('2. Sem mudança na lista, sem novo e-mail');
{
  const before = (await inbox()).length;
  const again = await sweep();
  check('rodar de novo não enfileira nada', again.status === 200 && again.data.ops_alerts_queued === 0, again.data);
  setStock(baixo.id, 2);
  const lower = await sweep();
  check('a quantidade que cai de 3 para 2 (mesmo produto) não gera outro e-mail', lower.data.ops_alerts_queued === 0);
  await sleep(300);
  check('a caixa do dono continua com o mesmo número de avisos', (await inbox()).length === before);
}

// ------------------------------------------------------------------------------------------------
section('3. Tudo normal zera a lembrança; o problema que volta avisa de novo (no dia seguinte)');
{
  setStock(baixo.id, 50);
  setStock(esgotado.id, 20);
  const ok = await sweep();
  check('estoque normalizado: nada a avisar e a lembrança é zerada', ok.data.ops_alerts_queued === 0 && psql("select coalesce(detail, '') from job_runs where name = 'ops_alert'") === '');
  setStock(baixo.id, 1);
  const same = await sweep();
  check('o problema voltou no MESMO dia: o limite de um e-mail por dia segura (sem ruído)', same.data.ops_alerts_queued === 0 && opsRows() === 1, same.data);
  psql("update email_messages set dedupe_key = 'ops:velho:' || id::text where kind = 'ops_alert'");
  const next = await sweep();
  check('no dia seguinte (a chave do dia mudou) o aviso sai de novo, agora só com o produto baixo', next.data.ops_alerts_queued === 1, next.data);
  await waitFor(async () => (await inbox()).length >= 2);
  const last = (await inbox()).at(-1);
  check('...e o assunto é só de estoque baixo', /^Aviso: 1 produto com estoque baixo –/.test(last?.subject ?? ''), last?.subject);
}

// ------------------------------------------------------------------------------------------------
section('4. O interruptor do painel desliga o aviso de estoque');
{
  const off = await owner.patch('/api/admin/store', { low_stock_email: false });
  check('o owner desliga pelo painel (200)', off.status === 200 && off.data.store.low_stock_email === false, off.data);
  check('valor que não é verdadeiro/falso → 400', (await owner.patch('/api/admin/store', { low_stock_email: 'sim' })).status === 400);
  check('sem login não muda (401)', (await anon.patch('/api/admin/store', { low_stock_email: true })).status === 401);
  psql("update email_messages set dedupe_key = 'ops:velho:' || id::text where kind = 'ops_alert'");
  setStock(esgotado.id, 0);
  const run = await sweep();
  check('com o aviso desligado, estoque baixo e esgotado não geram e-mail', run.data.ops_alerts_queued === 0 && opsRows() === 2, run.data);
  await owner.patch('/api/admin/store', { low_stock_email: true });
  check('religar volta a valer (a lista de agora é nova)', (await owner.get('/api/admin/settings')).data.store.low_stock_email === true);
  psql("delete from job_runs where name = 'ops_alert'");
  setStock(baixo.id, 50);
  setStock(esgotado.id, 20);
}

// ------------------------------------------------------------------------------------------------
section('5. Rotina automática com problema: o aviso vem da próxima atividade do site');
{
  const before = opsRows();
  psql("update job_runs set ok = false, detail = 'banco fora do ar', last_run_at = now() where name = 'sweep'");
  serve({}); // o servidor volta do zero: a primeira atividade avalia os avisos
  const buyer = new Client(undefined, '203.0.113.150');
  const order = await buyer.post('/api/orders', { customer_name: 'Cliente Ops', customer_phone: '34955550101', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: baixo.id, quantity: 1 }] });
  check('(preparação) um pedido de verdade mexe no site', order.status === 201, order.data);
  const got = await waitFor(async () => opsRows() > before, 8000);
  check('a rotina falhou: o dono é avisado sem depender de a própria rotina rodar', got, opsRows());
  await waitFor(async () => (await inbox()).some((m) => /rotina automática com problema/.test(m.subject ?? '')));
  const mail = (await inbox()).find((m) => /rotina automática com problema/.test(m.subject ?? ''));
  check('o e-mail diz que a rotina falhou e o motivo', Boolean(mail) && /falhou na última execução/.test(mail.text) && /banco fora do ar/.test(mail.text), mail?.text?.slice(0, 300));
  check('nenhum dado do cliente do pedido vai no aviso', !/Cliente Ops|34955550101/.test(mail?.text ?? ''));
  const panel = (await owner.get('/api/admin/health')).data;
  check('o painel (Estado do sistema) mostra a mesma falha', panel.jobs.sweep.ok === false, panel.jobs);
  const fixed = await sweep();
  check('a rotina volta a rodar: o estado se normaliza (200)', fixed.status === 200 && (await owner.get('/api/admin/health')).data.jobs.sweep.ok === true);
}

serve({});
summary();
