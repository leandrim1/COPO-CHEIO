// CEP (rota /api/cep/:cep, que consulta o serviço público de CEP pelo servidor da loja) e exportação em CSV (pedidos, clientes, estoque) com proteção contra fórmulas.
//  • CEP: só números, limite por rede, cache, serviço fora do ar / resposta quebrada / CEP inexistente não derrubam o checkout, texto do serviço é higienizado,
//    bairro do CEP é ligado ao bairro atendido da loja (sem acento/maiúsculas), nada de dado pessoal sai para o serviço;
//  • CSV: só o owner exporta pedidos e clientes (dados pessoais); estoque qualquer administrador; período obrigatório e limitado; cada exportação vai para o registro de
//    atividades; BOM, ";" e CRLF; texto digitado que começa com = + - @ vira texto (apóstrofo); nunca vai para cache.
// usage: bash tests/fresh.sh && node tests/api-test31.mjs      (BASE e TEST_DB escolhem o servidor e o banco)
import { execFileSync } from 'node:child_process';
import { Client, check, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4180';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
// O corpo SEM o BOM (fetch/TextDecoder tiram o BOM sozinhos) e se os bytes começavam com o BOM de UTF-8 (EF BB BF).
async function csvOf(client, path) {
  const res = await fetch(BASE + path, { headers: { 'x-real-ip': client.ip, cookie: client.cookie } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).replace(/^\ufeff/, '') };
}
const fakeMode = (mode) => fetch(`${BASE}/__viacep/mode`, { method: 'POST', body: JSON.stringify({ mode }) }).then((r) => r.json());
const fakeCalls = () => fetch(`${BASE}/__viacep/calls`).then((r) => r.json()).then((d) => d.calls);

const owner = new Client(undefined, '198.51.100.40');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const staff = new Client(undefined, '198.51.100.41');
await owner.post('/api/admin/admins', { name: 'Atendente', email: 'atendente31@copocheio.local', password: 'senha-forte-456', role: 'admin' });
await staff.login('atendente31@copocheio.local', 'senha-forte-456');
const anon = new Client(undefined, '198.51.100.42');

// ------------------------------------------------------------------------------------------------
section('1. CEP: a loja consulta o serviço; o navegador só fala com a loja');
{
  const ok = await anon.get('/api/cep/38400-000');
  check('CEP válido (com hífen): 200 com rua, bairro, cidade e estado', ok.status === 200 && ok.data.address.street === 'Avenida Teste' && ok.data.address.neighborhood === 'Centro' && ok.data.address.city === 'Uberlândia' && ok.data.address.state === 'MG', ok.data);
  check('sem bairros cadastrados: zones_configured = false e zone = null (vale a taxa única)', ok.data.zones_configured === false && ok.data.zone === null);
  const before = await fakeCalls();
  await anon.get('/api/cep/38400000');
  await anon.get('/api/cep/38400000');
  check('a mesma consulta repetida usa o cache (o serviço não é chamado de novo)', (await fakeCalls()) === before, [before, await fakeCalls()]);

  for (const bad of ['123', 'abcdefgh', '1234567890', '38400-00']) check(`CEP inválido (${bad}): 400, sem chamar o serviço`, (await anon.get(`/api/cep/${bad}`)).status === 400);
  const notFound = await anon.get('/api/cep/99999999');
  check('CEP que não existe: 404 com mensagem clara', notFound.status === 404 && notFound.data.code === 'cep_not_found' && /preencha o endereço à mão/i.test(notFound.data.error), notFound.data);

  const evil = await anon.get('/api/cep/38400222');
  check('texto do serviço é higienizado e limitado (nada de HTML/controle)', evil.status === 200 && !/[<>\u0000-\u001f]/.test(JSON.stringify(evil.data.address).replace(/\\u[0-9a-f]{4}/g, '')) && evil.data.address.street.length <= 120, evil.data);
}

// ------------------------------------------------------------------------------------------------
section('2. CEP: bairro do CEP ligado ao bairro atendido da loja');
{
  const zone = (await owner.post('/api/admin/zones', { name: 'Sao Sebastiao', fee: 7 })).data.zone;
  const hit = await anon.get('/api/cep/38400111');
  check('"São Sebastião" do CEP = "Sao Sebastiao" da loja (sem acento e sem diferença de maiúsculas): devolve o bairro cadastrado e a taxa', hit.status === 200 && hit.data.zone?.name === 'Sao Sebastiao' && hit.data.zone.fee === 7 && hit.data.zones_configured === true, hit.data);
  const miss = await anon.get('/api/cep/38400222');
  check('bairro que a loja não atende: zone = null com zones_configured = true (o site avisa e pede para escolher da lista)', miss.status === 200 && miss.data.zone === null && miss.data.zones_configured === true, miss.data);
  await owner.patch(`/api/admin/zones/${zone.id}`, { active: false });
  const off = await anon.get('/api/cep/38400111?x=1');
  check('bairro desativado não conta como atendido', off.data.zone === null && off.data.zones_configured === false, off.data);
  await owner.del(`/api/admin/zones/${zone.id}`);
}

// ------------------------------------------------------------------------------------------------
section('3. CEP: serviço fora do ar nunca quebra o checkout; limite por rede');
{
  await fakeMode('down');
  const down = await anon.get('/api/cep/38400333');
  check('serviço fora do ar: 502 com a mensagem "preencha à mão" (e o pedido segue possível)', down.status === 502 && down.data.code === 'cep_unavailable' && /preencha o endereço à mão/i.test(down.data.error), down.data);
  await fakeMode('badjson');
  const bad = await anon.get('/api/cep/38400444');
  check('resposta que não é JSON: 502 também', bad.status === 502 && bad.data.code === 'cep_unavailable', bad.data);
  await fakeMode('hang');
  const t0 = Date.now();
  const hang = await anon.get('/api/cep/38400555');
  check('serviço que não responde: desiste em poucos segundos (502)', hang.status === 502 && Date.now() - t0 < 8000, [hang.status, Date.now() - t0]);
  await fakeMode('ok');
  const back = await anon.get('/api/cep/38400333');
  check('serviço de volta: a falha não ficou guardada no cache', back.status === 404 || back.status === 200, back.status);

  const limited = new Client(undefined, '198.51.100.77');
  const codes = [];
  for (let i = 0; i < 70; i++) codes.push((await limited.get(`/api/cep/384${String(10000 + i)}`)).status);
  check('muitas consultas na mesma rede: 429 depois de 60', codes.slice(0, 60).every((c) => c !== 429) && codes.slice(60).some((c) => c === 429), codes.filter((c) => c === 429).length);
}

// ------------------------------------------------------------------------------------------------
section('4. CSV: dados de teste (inclui nomes que tentam virar fórmula)');
const cat = (await owner.post('/api/admin/categories', { name: 'Exportação' })).data.category;
const mk = async (name, price, extra = {}) => (await owner.post('/api/admin/products', { name, price, category_id: cat.id, stock: 30, confirm_duplicate: true, ...extra })).data.product;
const beer = await mk('Cerveja Export', 10);
const evilProduct = await mk('=HYPERLINK("http://x","clique")', 12, { alcoholic: false });
let n = 0;
const place = (extra) => new Client(undefined, `203.0.113.${150 + n++}`).post('/api/orders', {
  customer_phone: `3495${String(3000000 + n).slice(-7)}`, delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: beer.id, quantity: 2 }], ...extra,
});
const o1 = await place({ customer_name: '=cmd|\' /C calc\'!A0', customer_email: 'exportacao1@exemplo.com', notes: 'sem fórmula aqui' });
const o2 = await place({ customer_name: '+55 Maria; "Zé"', items: [{ product_id: evilProduct.id, quantity: 1 }] });
const o3 = await place({ customer_name: '@Joana da Silva', customer_email: 'exportacao3@exemplo.com' });
check('três pedidos de teste criados', [o1, o2, o3].every((o) => o.status === 201), [o1.status, o2.status, o3.status]);
await owner.patch(`/api/admin/orders/${psql(`select id from orders where order_number = ${o3.data.order.order_number}`)}`, { status: 'cancelled' });
const today = new Date().toISOString().slice(0, 10);

section('5. CSV: quem pode exportar, período, formato e registro');
{
  const url = `/api/admin/export/orders.csv?from=${today}&to=${today}`;
  check('sem login: 401', (await anon.get(url)).status === 401);
  check('atendente (admin) NÃO exporta pedidos (têm dados pessoais): 403', (await staff.get(url)).status === 403);
  check('atendente NÃO exporta clientes: 403', (await staff.get('/api/admin/export/customers.csv')).status === 403);
  check('sem período: 400', (await owner.get('/api/admin/export/orders.csv')).status === 400);
  check('data fora do formato: 400', (await owner.get('/api/admin/export/orders.csv?from=hoje&to=amanha')).status === 400);
  check('fim antes do início: 400', (await owner.get(`/api/admin/export/orders.csv?from=${today}&to=2020-01-01`)).status === 400);
  check('período maior que o limite: 400', (await owner.get('/api/admin/export/orders.csv?from=2000-01-01&to=2030-01-01')).status === 400);
  check('situação inválida: 400', (await owner.get(`${url}&status=banana`)).status === 400);

  const res = await csvOf(owner, url);
  check('owner exporta: 200 text/csv, baixar como arquivo, sem cache', res.status === 200 && /^text\/csv/.test(res.headers.get('content-type')) && /attachment; filename="pedidos-\d{4}-\d{2}-\d{2}_a_\d{4}-\d{2}-\d{2}\.csv"/.test(res.headers.get('content-disposition')) && res.headers.get('cache-control') === 'no-store', [res.status, Object.fromEntries(res.headers)]);
  const body = res.text;
  check('começa com BOM de UTF-8 (acentos certos no Excel) e usa ";" e CRLF', res.bom && body.split('\r\n')[0].includes(';') && !body.includes('\n\n'), body.slice(0, 120));
  const lines = body.split('\r\n').filter(Boolean);
  check('cabeçalho + 3 pedidos', lines.length === 4 && lines[0].startsWith('Pedido;Data;Situação;'), lines);
  check('fórmula no nome do cliente vira texto (apóstrofo na frente): =cmd..., +55..., @Joana', lines.some((l) => l.includes(";'=cmd|")) && lines.some((l) => l.includes(`;"'+55 Maria; ""Zé"""`)) && lines.some((l) => l.includes(";'@Joana da Silva;")), lines);
  check('fórmula no nome do PRODUTO (coluna Itens) também', lines.some((l) => l.includes("1x '=HYPERLINK")) || lines.some((l) => l.includes(`1x ''=HYPERLINK`)) || lines.some((l) => /1x [^;]*HYPERLINK/.test(l) && !/;1x =HYPERLINK/.test(l)), lines.find((l) => /HYPERLINK/.test(l)));
  check('nenhuma célula do arquivo começa com = + - @ sem o apóstrofo', lines.slice(1).every((l) => l.split(';').every((c) => !/^"?[=+\-@]/.test(c) || /^"?'/.test(c) === true || /^-?\d+(,\d+)?$/.test(c))), lines.slice(1));
  check('valores em reais com vírgula (20,00) e situação em português', lines.some((l) => /;20,00;/.test(l)) && lines.some((l) => /;Cancelado;/.test(l)) && lines.some((l) => /;Novo;/.test(l)));
  const cancelledOnly = (await csvOf(owner, `${url}&status=cancelled`)).text.split('\r\n').filter(Boolean);
  check('filtro por situação: só os cancelados', cancelledOnly.length === 2 && /Cancelado/.test(cancelledOnly[1]), cancelledOnly);
  const empty = (await csvOf(owner, '/api/admin/export/orders.csv?from=2020-01-01&to=2020-01-02')).text.split('\r\n').filter(Boolean);
  check('período sem pedidos: só o cabeçalho', empty.length === 1);

  const logged = psql("select count(*) from audit_log where action = 'export.orders'");
  check('cada exportação de pedidos fica no registro de atividades (quem, filtros e quantidade)', Number(logged) >= 3 && /pedido\(s\) em CSV/.test(psql("select summary from audit_log where action = 'export.orders' order by created_at desc limit 1")), logged);
  check('o registro avisa que tem dados pessoais e não guarda o conteúdo do arquivo', /dados pessoais/.test(psql("select summary from audit_log where action = 'export.orders' limit 1")) && !/exportacao1@exemplo\.com/.test(psql("select string_agg(summary || coalesce(details::text, ''), ' ') from audit_log where action like 'export.%'")));

  const cust = await csvOf(owner, '/api/admin/export/customers.csv');
  check('clientes: owner exporta com cabeçalho em português', cust.status === 200 && cust.bom && cust.text.startsWith('Nome;E-mail;Telefone;'), cust.text.slice(0, 80));
  check('...e fica registrado', psql("select count(*) from audit_log where action = 'export.customers'") === '1');

  const stock = await csvOf(staff, '/api/admin/export/stock.csv');
  check('estoque: qualquer administrador exporta (sem dado pessoal)', stock.status === 200 && stock.text.includes('Cerveja Export') && !/exportacao/i.test(stock.text));
  check('...fórmula no nome do produto neutralizada também no estoque', /;?'=HYPERLINK/.test(stock.text) || /"'=HYPERLINK/.test(stock.text), stock.text.slice(0, 400));

  const rl = new Client(undefined, '198.51.100.88');
  await owner.post('/api/admin/admins', { name: 'Outro Dono', email: 'dono2-31@copocheio.local', password: 'senha-forte-789', role: 'owner' });
  await rl.login('dono2-31@copocheio.local', 'senha-forte-789');
  const codes = [];
  for (let i = 0; i < 25; i++) codes.push((await csvOf(rl, '/api/admin/export/stock.csv')).status);
  check('exportar sem parar é barrado (429) depois de 20 por hora', codes.slice(0, 20).every((c) => c === 200) && codes.slice(20).some((c) => c === 429), codes);
}

summary();
