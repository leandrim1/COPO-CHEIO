// Endereços extras na conta (0031), limite de estoque baixo configurável (0032) e termos e políticas editáveis (0033: cinco páginas, a quinta é "Contato e responsável").
//  • endereços: só o dono da conta lê/muda os seus (o de outra pessoa dá 404), no máximo 4 extras (a trava é do banco, mesmo com abas simultâneas), validações, apagar a conta apaga os extras;
//  • estoque baixo: padrão da loja e limite por produto, aviso no painel inicial (baixo e esgotado);
//  • termos e políticas: o público lê, só o owner edita; texto só (HTML nunca), editar tira a marca de "revisado", tudo no registro de atividades.
// usage: bash tests/fresh.sh && node tests/api-test33.mjs      (BASE e TEST_DB escolhem o servidor e o banco)
import { execFileSync } from 'node:child_process';
import { Client, check, registerVerified, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));

const owner = new Client(undefined, '198.51.100.60');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const staff = new Client(undefined, '198.51.100.61');
await owner.post('/api/admin/admins', { name: 'Atendente', email: 'atendente33@copocheio.local', password: 'senha-forte-456', role: 'admin' });
await staff.login('atendente33@copocheio.local', 'senha-forte-456');
const anon = new Client(undefined, '198.51.100.62');

// ------------------------------------------------------------------------------------------------
section('1. Endereços extras: só o dono da conta');
const ana = new Client(undefined, '203.0.113.60');
const bia = new Client(undefined, '203.0.113.61');
await registerVerified(ana, { name: 'Ana Endereços', email: 'ana.enderecos@exemplo.com', phone: '34981110001', password: 'senha-forte-123' });
await registerVerified(bia, { name: 'Bia Endereços', email: 'bia.enderecos@exemplo.com', phone: '34981110002', password: 'senha-forte-123' });
const addr = (extra = {}) => ({ label: 'Trabalho', cep: '38400-000', address: 'Avenida Teste', address_number: '100', neighborhood: 'Centro', complement: 'Sala 2', reference: 'Perto da praça', ...extra });
let first;
{
  check('sem login: 401 em todas as rotas', (await anon.get('/api/account/addresses')).status === 401 && (await anon.post('/api/account/addresses', addr())).status === 401);
  check('conta nova: lista vazia', (await ana.get('/api/account/addresses')).data.addresses.length === 0);
  const made = await ana.post('/api/account/addresses', addr());
  first = made.data.address;
  check('cria o endereço: 201, CEP só com números', made.status === 201 && first.label === 'Trabalho' && first.cep === '38400000' && first.address_number === '100', made.data);
  const bad = async (name, body) => check(`recusa: ${name}`, (await ana.post('/api/account/addresses', addr(body))).status === 400, body);
  await bad('sem apelido', { label: '' });
  await bad('apelido longo demais', { label: 'x'.repeat(31) });
  await bad('sem rua', { address: '' });
  await bad('sem número', { address_number: '' });
  await bad('sem bairro', { neighborhood: '' });
  await bad('CEP com 5 números', { cep: '38400' });
  await bad('complemento longo demais', { complement: 'c'.repeat(61) });
  await bad('referência longa demais', { reference: 'r'.repeat(121) });
  check('a lista da Ana tem 1 endereço', (await ana.get('/api/account/addresses')).data.addresses.length === 1);
  check('a Bia NÃO vê o endereço da Ana', (await bia.get('/api/account/addresses')).data.addresses.length === 0);
  check('a Bia não consegue editar o endereço da Ana (404, nada muda)', (await bia.patch(`/api/account/addresses/${first.id}`, { label: 'Invadido' })).status === 404 && psql(`select label from customer_addresses where id = ${lit(first.id)}`) === 'Trabalho');
  check('a Bia não consegue apagar o endereço da Ana (404, continua lá)', (await bia.del(`/api/account/addresses/${first.id}`)).status === 404 && psql(`select count(*) from customer_addresses where id = ${lit(first.id)}`) === '1');
  const edit = await ana.patch(`/api/account/addresses/${first.id}`, { label: 'Escritório', address_number: '200' });
  check('a Ana edita o seu: 200', edit.status === 200 && edit.data.address.label === 'Escritório' && edit.data.address.address_number === '200', edit.data);
  check('editar sem nenhum campo: 400', (await ana.patch(`/api/account/addresses/${first.id}`, {})).status === 400);
  check('id que não é UUID: 404', (await ana.patch('/api/account/addresses/abc', { label: 'x' })).status === 404);
}

section('2. Endereços extras: no máximo 4 (trava do banco, mesmo com abas simultâneas)');
{
  for (let i = 2; i <= 4; i++) check(`extra ${i} de 4`, (await ana.post('/api/account/addresses', addr({ label: `Casa ${i}` }))).status === 201);
  const fifth = await ana.post('/api/account/addresses', addr({ label: 'Quinto' }));
  check('o quinto é recusado com explicação', fifth.status === 400 && /4 endereços extras/.test(fifth.data.error), fifth.data);
  check('apagar um libera a vaga', (await ana.del(`/api/account/addresses/${first.id}`)).status === 200 && (await ana.post('/api/account/addresses', addr({ label: 'Quinto' }))).status === 201);

  const race = new Client(undefined, '203.0.113.62');
  await registerVerified(race, { name: 'Caio Corrida', email: 'caio.corrida@exemplo.com', phone: '34981110003', password: 'senha-forte-123' });
  const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => race.post('/api/account/addresses', addr({ label: `Corrida ${i}` }))));
  check('8 abas salvando ao mesmo tempo: no máximo 4 entram', runs.filter((r) => r.status === 201).length === 4 && psql(`select count(*) from customer_addresses a join customers c on c.id = a.customer_id where c.email = 'caio.corrida@exemplo.com'`) === '4', runs.map((r) => r.status));
}

section('3. Apagar a conta apaga os endereços extras');
{
  const dele = new Client(undefined, '203.0.113.63');
  await registerVerified(dele, { name: 'Davi Apagar', email: 'davi.apagar@exemplo.com', phone: '34981110004', password: 'senha-forte-123' });
  await dele.post('/api/account/addresses', addr({ label: 'Para apagar' }));
  check('um endereço extra existe', psql("select count(*) from customer_addresses a join customers c on c.id = a.customer_id where c.email = 'davi.apagar@exemplo.com'") === '1');
  const del = await dele.del('/api/account', { password: 'senha-forte-123' });
  check('excluir a conta: 200', del.status === 200, del.data);
  check('...e os endereços extras foram junto', psql("select count(*) from customer_addresses where label = 'Para apagar'") === '0');
}

// ------------------------------------------------------------------------------------------------
section('4. Estoque baixo: padrão da loja e limite por produto');
const cat = (await owner.post('/api/admin/categories', { name: 'Estoque Alerta' })).data.category;
const mk = async (name, stock, extra = {}) => (await owner.post('/api/admin/products', { name, price: 10, category_id: cat.id, stock, alcoholic: false, confirm_duplicate: true, ...extra })).data.product;
{
  const settings = (await owner.get('/api/admin/settings')).data.store;
  check('o padrão da loja é 5 (o mesmo valor de antes)', settings.low_stock_default === 5, settings.low_stock_default);
  const a = await mk('Estoque 3', 3);
  const b = await mk('Estoque 8', 8);
  const c = await mk('Estoque 0', 0);
  const d = await mk('Sem controle', null);
  const dash = async () => (await owner.get('/api/admin/dashboard')).data.low_stock;
  check('painel inicial: 1 baixo (3 ≤ 5) e 1 esgotado (0); 8 está fora; sem controle não conta', JSON.stringify(await dash()) === '{"low":1,"out":1}', await dash());
  const staffDash = (await staff.get('/api/admin/dashboard')).data.low_stock;
  check('qualquer administrador vê o aviso', staffDash?.low === 1 && staffDash?.out === 1);

  const bad = async (name, body) => check(`recusa: ${name}`, (await owner.patch('/api/admin/store', body)).status === 400, body);
  await bad('padrão negativo', { low_stock_default: -1 });
  await bad('padrão maior que 1000', { low_stock_default: 1001 });
  await bad('padrão não inteiro', { low_stock_default: 2.5 });
  const set10 = await owner.patch('/api/admin/store', { low_stock_default: 10 });
  check('muda o padrão da loja para 10', set10.status === 200 && set10.data.store.low_stock_default === 10, set10.data);
  check('agora o de 8 também é "baixo" (2 baixos, 1 esgotado)', JSON.stringify(await dash()) === '{"low":2,"out":1}', await dash());
  const own = await owner.patch(`/api/admin/products/${b.id}`, { low_stock_threshold: 2 });
  check('limite próprio do produto (avisar só com até 2): 200', own.status === 200 && own.data.product.low_stock_threshold === 2, own.data);
  check('...e o de 8 deixa de ser baixo (agora só o de 3)', JSON.stringify(await dash()) === '{"low":1,"out":1}', await dash());
  check('limite próprio inválido é recusado', (await owner.patch(`/api/admin/products/${b.id}`, { low_stock_threshold: -3 })).status === 400 && (await owner.patch(`/api/admin/products/${b.id}`, { low_stock_threshold: 'muito' })).status === 400);
  const back = await owner.patch(`/api/admin/products/${b.id}`, { low_stock_threshold: null });
  check('limite vazio volta ao padrão da loja', back.status === 200 && back.data.product.low_stock_threshold === null && JSON.stringify(await dash()) === '{"low":2,"out":1}');
  await owner.patch(`/api/admin/products/${a.id}`, { active: false });
  check('produto desativado (fora do site) não entra no aviso', JSON.stringify(await dash()) === '{"low":1,"out":1}', await dash());
  check('a lista de produtos do painel traz o limite de cada um', (await owner.get('/api/admin/products')).data.products.every((p) => 'low_stock_threshold' in p));
  check('o site (público) não recebe o limite de estoque', JSON.stringify((await anon.get('/api/products')).data).indexOf('low_stock') === -1 && JSON.stringify((await anon.get('/api/site')).data).indexOf('low_stock') === -1);
  void c; void d;
}

// ------------------------------------------------------------------------------------------------
section('5. Termos e políticas editáveis');
{
  for (const slug of ['termos', 'trocas-e-cancelamentos', 'entrega', 'pagamento-e-reembolso', 'contato-e-responsavel']) {
    const r = await anon.get(`/api/legal/${slug}`);
    check(`público lê /api/legal/${slug}: título e texto`, r.status === 200 && r.data.page.title.length > 3 && r.data.page.body.length > 100 && r.data.page.reviewed_at === undefined, r.status);
  }
  check('página que não existe: 404', (await anon.get('/api/legal/segredo')).status === 404);
  check('tentativa de sair da pasta (..%2F): nunca dá 200', (await anon.get('/api/legal/..%2F..%2Fetc')).status >= 400);
  check('o texto padrão não cita lei nem inventa prazo/valor (revisão é da loja)', !/lei\s*(n[ºo°.]\s*)?\d|art\.|artigo \d|\b\d+\s*dias úteis|R\$\s*\d/i.test(JSON.stringify((await anon.get('/api/legal/trocas-e-cancelamentos')).data)));
  check('o texto padrão fala da conferência de documento e não guarda cópia', /documento oficial com foto/.test((await anon.get('/api/legal/termos')).data.page.body) && /Não guardamos cópia/.test((await anon.get('/api/legal/termos')).data.page.body));

  check('o painel: atendente (admin) NÃO lista nem edita (só o owner)', (await staff.get('/api/admin/legal')).status === 403 && (await staff.put('/api/admin/legal/termos', { title: 'X', body: 'y'.repeat(30) })).status === 403);
  const list = (await owner.get('/api/admin/legal')).data.pages;
  check('owner lista as 5, todas ainda sem revisão', list.length === 5 && list.every((p) => p.reviewed_at === null), list.map((p) => p.slug));

  const bad = async (name, body) => check(`recusa: ${name}`, (await owner.put('/api/admin/legal/termos', body)).status === 400, body);
  await bad('título curto', { title: 'ab', body: 'x'.repeat(40) });
  await bad('texto curto', { title: 'Termos', body: 'curto' });
  await bad('texto gigante', { title: 'Termos', body: 'x'.repeat(20001) });
  await bad('texto que não é texto', { title: 'Termos', body: { html: '<b>oi</b>' } });
  check('slug desconhecido: 404', (await owner.put('/api/admin/legal/outra', { title: 'Termos', body: 'x'.repeat(40) })).status === 404);

  const edited = await owner.put('/api/admin/legal/termos', { title: 'Termos de uso da loja', body: '## Regras\n- Primeira regra\n- Segunda regra\n\nParágrafo com <script>alert(1)</script> e \u0007sino.' });
  check('owner edita: 200, o caractere de controle some e o HTML fica como texto', edited.status === 200 && edited.data.page.title === 'Termos de uso da loja' && !edited.data.page.body.includes('\u0007') && edited.data.page.body.includes('<script>alert(1)</script>'), edited.data);
  check('NUL no texto é recusado (400), nunca chega ao banco', (await owner.put('/api/admin/legal/termos', { title: 'Termos', body: `texto com nulo \u0000 dentro ${'x'.repeat(30)}` })).status === 400);
  const pub = await anon.get('/api/legal/termos');
  check('o público já lê o texto novo', pub.data.page.title === 'Termos de uso da loja' && pub.data.page.body.startsWith('## Regras'));

  const bad2 = await owner.post('/api/admin/legal/termos/review', { reviewed_by: '' });
  check('anotar revisão sem nome: 400', bad2.status === 400);
  const rev = await owner.post('/api/admin/legal/termos/review', { reviewed_by: 'Dra. Teste' });
  check('anotar a revisão: guarda quem e quando', rev.status === 200 && rev.data.page.reviewed_by === 'Dra. Teste' && rev.data.page.reviewed_at, rev.data);
  check('o público NÃO vê a marca de revisão', (await anon.get('/api/legal/termos')).data.page.reviewed_by === undefined);
  const same = await owner.put('/api/admin/legal/termos', { title: 'Termos de uso da loja', body: edited.data.page.body });
  check('salvar o MESMO texto não tira a revisão', same.data.page.reviewed_by === 'Dra. Teste');
  const changed = await owner.put('/api/admin/legal/termos', { title: 'Termos de uso da loja', body: `${edited.data.page.body}\n\nMais uma linha.` });
  check('mudar o texto tira a marca de revisado (quem revisou, revisou o texto antigo)', changed.data.page.reviewed_at === null && changed.data.page.reviewed_by === null, changed.data.page);
  check('o registro de atividades guarda a edição e a revisão', /Editou a página/.test(psql("select string_agg(summary, ' | ') from audit_log where action = 'legal.update'")) && psql("select count(*) from audit_log where action = 'legal.review'") === '1');
}

summary();
