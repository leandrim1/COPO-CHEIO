// Programa de pontos (fidelidade), migration 0035. Nasce desligado e sem valores; as regras são do dono.
//  • desligado: nada é creditado; só o owner mexe nas regras (admin e anônimo não); ligar exige as quatro regras (o banco também confere);
//  • crédito: pedido de CONTA entregue, sobre os itens depois do desconto (sem entrega nem taxas), uma vez por pedido; visitante não ganha pontos;
//  • estorno: pagamento devolvido depois de creditado desfaz o crédito (uma vez); o saldo pode ficar negativo e a troca só volta a valer quando ele cobre de novo;
//  • troca: gera um cupom PESSOAL de valor fixo, atômico (cliques simultâneos não gastam o mesmo ponto duas vezes); só a conta dona usa; cancelado libera o cupom;
//  • extrato só de acréscimo (o banco recusa alterar), acerto manual só do owner, com motivo, sem saldo negativo, registrado nas atividades;
//  • apagar a conta apaga os pontos e os cupons pessoais.
// usage: bash tests/fresh.sh && node tests/api-test38.mjs      (BASE e TEST_DB escolhem o servidor e o banco)
import { execFileSync } from 'node:child_process';
import { Client, check, registerVerified, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));

const owner = new Client(undefined, '198.51.100.140');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const staff = new Client(undefined, '198.51.100.141');
await owner.post('/api/admin/admins', { name: 'Atendente Pontos', email: 'atendente38@copocheio.local', password: 'senha-forte-456', role: 'admin' });
await staff.login('atendente38@copocheio.local', 'senha-forte-456');
const anon = new Client(undefined, '198.51.100.142');
const cat = (await owner.post('/api/admin/categories', { name: 'Pontos' })).data.category;
const item = (await owner.post('/api/admin/products', { name: 'Produto Pontos', price: 50, category_id: cat.id, stock: 1000, alcoholic: false, confirm_duplicate: true })).data.product;
const idOf = (n) => psql(`select id from orders where order_number = ${n}`);
const deliver = async (n) => {
  for (const s of ['confirmed', 'preparing', 'out_for_delivery', 'delivered']) await owner.patch(`/api/admin/orders/${idOf(n)}`, { status: s });
};
let ip = 20;
let phone = 0;
const buyer = () => new Client(undefined, `203.0.113.${ip++}`);
const order = (client, qty, extra = {}) => client.post('/api/orders', { customer_name: 'Comprador Pontos', customer_phone: `3497${String(2000000 + ++phone).slice(-7)}`, delivery_type: 'pickup', payment_method: 'cash', items: [{ product_id: item.id, quantity: qty }], ...extra });
const ledger = (customerId) => psql(`select coalesce(string_agg(kind || ':' || points, ',' order by created_at, id), '') from loyalty_ledger where customer_id = '${customerId}'`);
const customerId = (email) => psql(`select id from customers where email = '${email}'`);
const RULES = { loyalty_points_per_real: 1, loyalty_redeem_points: 100, loyalty_reward_value: 5, loyalty_coupon_days: 30 };

const ana = new Client(undefined, '203.0.113.200');
await registerVerified(ana, { name: 'Ana Pontos', email: 'ana.pontos@exemplo.com', phone: '34981130001', password: 'senha-forte-123' });
const bia = new Client(undefined, '203.0.113.201');
await registerVerified(bia, { name: 'Bia Pontos', email: 'bia.pontos@exemplo.com', phone: '34981130002', password: 'senha-forte-123' });
const anaId = customerId('ana.pontos@exemplo.com');
const biaId = customerId('bia.pontos@exemplo.com');

// ------------------------------------------------------------------------------------------------
section('1. Desligado e sem valores: nada é creditado; só o owner mexe');
{
  const st = await owner.get('/api/admin/loyalty');
  check('o owner vê o programa desligado e sem nenhuma regra inventada', st.status === 200 && st.data.settings.enabled === false && st.data.settings.points_per_real === null && st.data.settings.redeem_points === null && st.data.settings.reward_value === null && st.data.settings.coupon_days === null, st.data);
  check('atendente (admin) não vê nem muda (403)', (await staff.get('/api/admin/loyalty')).status === 403 && (await staff.put('/api/admin/loyalty/settings', { loyalty_enabled: true })).status === 403);
  check('sem login: 401', (await anon.get('/api/admin/loyalty')).status === 401 && (await anon.post('/api/admin/loyalty/adjust', {})).status === 401);
  check('a conta vê "desligado" (e nenhum dado)', JSON.stringify((await ana.get('/api/account/loyalty')).data) === '{"enabled":false}');
  check('sem conta não vê (401)', (await anon.get('/api/account/loyalty')).status === 401 && (await anon.post('/api/account/loyalty/redeem', {})).status === 401);
  const o = await order(ana, 3);
  await deliver(o.data.order.order_number);
  check('pedido entregue com o programa desligado: nenhum ponto', ledger(anaId) === '', ledger(anaId));
  check('trocar com o programa desligado: 409', (await ana.post('/api/account/loyalty/redeem', {})).status === 409);
}

// ------------------------------------------------------------------------------------------------
section('2. Regras: validação, e ligar exige as quatro');
{
  const put = (body) => owner.put('/api/admin/loyalty/settings', body);
  check('ligar sem regras: 400 dizendo o que falta', (await put({ loyalty_enabled: true })).status === 400 && /preencha/.test((await put({ loyalty_enabled: true })).data.error));
  for (const [name, body] of [['pontos por real zero', { loyalty_points_per_real: 0 }], ['pontos por real negativo', { loyalty_points_per_real: -1 }], ['pontos por real texto', { loyalty_points_per_real: 'muito' }], ['pontos para trocar zero', { loyalty_redeem_points: 0 }], ['pontos para trocar fracionado', { loyalty_redeem_points: 10.5 }], ['recompensa zero', { loyalty_reward_value: 0 }], ['validade 400 dias', { loyalty_coupon_days: 400 }], ['ligado não booleano', { loyalty_enabled: 'sim' }]]) {
    check(`recusa: ${name}`, (await put(body)).status === 400, body);
  }
  const set = await put({ ...RULES });
  check('salvar as regras sem ligar: 200 e continua desligado', set.status === 200 && set.data.settings.enabled === false && set.data.settings.redeem_points === 100 && set.data.settings.reward_value === 5, set.data);
  const on = await put({ loyalty_enabled: true });
  check('agora liga: 200', on.status === 200 && on.data.settings.enabled === true, on.data);
  check('tirar uma regra com o programa ligado: o banco recusa', (await put({ loyalty_redeem_points: null })).status === 400 && psql('select loyalty_redeem_points from store_settings') === '100');
  check('o registro de atividades guarda a mudança', Number(psql("select count(*) from audit_log where action = 'loyalty.settings'")) >= 2);
}

// ------------------------------------------------------------------------------------------------
section('3. Crédito: só pedido de conta entregue, sobre os itens depois do desconto');
let firstOrder;
{
  const o1 = await order(ana, 3); // 3 × 50 = 150, retirada
  firstOrder = o1.data.order.order_number;
  check('antes de entregar não há pontos', ledger(anaId) === '');
  await deliver(firstOrder);
  check('entregue: 150 pontos (R$ 150,00 × 1), uma vez', ledger(anaId) === 'earn:150', ledger(anaId));
  await owner.patch(`/api/admin/orders/${idOf(firstOrder)}`, { status: 'delivered' }).catch(() => undefined);
  check('repetir "entregue" não credita de novo', ledger(anaId) === 'earn:150');
  const acct = await ana.get('/api/account/loyalty');
  check('a conta vê saldo, regras e extrato', acct.data.enabled === true && acct.data.balance === 150 && acct.data.rules.redeem_points === 100 && acct.data.movements.length === 1 && acct.data.movements[0].note === `Pedido #${firstOrder}`, acct.data);
  check('a resposta nunca é guardada em cache', /no-store/.test(acct.headers.get('cache-control')));

  const cup = (await owner.post('/api/admin/coupons', { code: 'MENOS20', kind: 'fixed', value: 20 })).data.coupon;
  const o2 = await order(ana, 3, { coupon_code: 'MENOS20' }); // 150 − 20 = 130
  check('(preparação) pedido com cupom de R$ 20', o2.status === 201 && Number(o2.data.order.discount) === 20, o2.data);
  await deliver(o2.data.order.order_number);
  check('com cupom de R$ 20: 130 pontos (o desconto não gera ponto)', ledger(anaId) === 'earn:150,earn:130', ledger(anaId));

  const o3 = await order(ana, 1, { delivery_type: 'delivery', address: 'Rua P', address_number: '1', neighborhood: 'Centro' }); // 50 + R$ 5 de entrega
  await deliver(o3.data.order.order_number);
  check('pedido de entrega: só os itens contam (50 pontos), a taxa de entrega não', ledger(anaId) === 'earn:150,earn:130,earn:50', ledger(anaId));

  const guest = buyer();
  const og = await order(guest, 3);
  await deliver(og.data.order.order_number);
  check('visitante (sem conta) não ganha pontos', Number(psql(`select count(*) from loyalty_ledger l join orders o on o.id = l.order_id where o.order_number = ${og.data.order.order_number}`)) === 0);
  await owner.del(`/api/admin/coupons/${cup.id}`);
}

// ------------------------------------------------------------------------------------------------
section('4. Estorno: pagamento devolvido depois de creditado');
{
  const ob = await order(bia, 4); // 200 pontos
  const n = ob.data.order.order_number;
  await deliver(n);
  check('Bia ganhou 200 pontos', ledger(biaId) === 'earn:200', ledger(biaId));
  await owner.patch(`/api/admin/orders/${idOf(n)}`, { payment_status: 'paid' });
  await owner.patch(`/api/admin/orders/${idOf(n)}`, { payment_status: 'refunded' });
  check('pagamento devolvido: o crédito é estornado (−200), uma vez', ledger(biaId) === 'earn:200,reverse:-200', ledger(biaId));
  await owner.patch(`/api/admin/orders/${idOf(n)}`, { payment_status: 'refunded' }).catch(() => undefined);
  check('repetir não estorna de novo', ledger(biaId) === 'earn:200,reverse:-200');
  check('saldo da Bia volta a 0', (await bia.get('/api/account/loyalty')).data.balance === 0);
}

// ------------------------------------------------------------------------------------------------
section('5. Troca por cupom pessoal');
let code;
{
  check('Bia (saldo 0) não troca: 409 "ainda não tem pontos suficientes"', (await bia.post('/api/account/loyalty/redeem', {})).status === 409);
  const before = (await ana.get('/api/account/loyalty')).data.balance;
  check('(preparação) Ana tem 330 pontos', before === 330, before);
  // Dois cliques ao mesmo tempo: o saldo só cobre trocas; a trava da conta serializa. 330 pontos = até 3 trocas de 100; disparamos 6.
  const results = await Promise.all(Array.from({ length: 6 }, () => ana.post('/api/account/loyalty/redeem', {})));
  const okCount = results.filter((r) => r.status === 201).length;
  check('6 trocas simultâneas: exatamente 3 passam (o saldo cobre 3) e as outras são recusadas', okCount === 3 && results.filter((r) => r.status === 409).length === 3, results.map((r) => r.status));
  check('o saldo ficou em 30 (nenhum ponto gasto duas vezes)', (await ana.get('/api/account/loyalty')).data.balance === 30);
  check('o extrato tem 3 débitos de 100', (ledger(anaId).match(/redeem:-100/g) ?? []).length === 3);
  const got = results.find((r) => r.status === 201).data;
  code = got.coupon.code;
  check('o cupom: código PTS…, R$ 5,00, vale 30 dias', /^PTS[0-9A-F]{8}$/.test(code) && got.coupon.value === 5 && Math.abs(new Date(got.coupon.expires_at) - Date.now() - 30 * 86400_000) < 60_000, got);
  const mine = (await ana.get('/api/account/loyalty')).data.coupons;
  check('a conta vê os cupons de troca ainda não usados', mine.length === 3 && mine.some((c) => c.code === code));
  check('no banco o cupom é de valor fixo, 1 uso, ligado à conta da Ana', psql(`select kind || ':' || value || ':' || usage_limit || ':' || (customer_id = '${anaId}')::text from coupons where code = '${code}'`) === 'fixed:5.00:1:true');
}

// ------------------------------------------------------------------------------------------------
section('6. O cupom pessoal só vale para a dona');
{
  const preview = (client) => client.post('/api/coupons/validate', { code, items: [{ product_id: item.id, quantity: 1 }], delivery_type: 'pickup' });
  const ownerView = await preview(ana);
  check('para a Ana a prévia aceita: R$ 5,00 de desconto', ownerView.status === 200 && ownerView.data.coupon.discount === 5, ownerView.data);
  const other = await preview(bia);
  const guest = await preview(buyer());
  check('para outra conta e para visitante: a mesma mensagem de cupom inválido', other.status >= 400 && guest.status >= 400 && other.data.error === guest.data.error && /inválido ou expirado/.test(other.data.error), [other.data, guest.data]);
  const forged = await order(bia, 1, { coupon_code: code });
  check('pedido da Bia com o código: recusado (o banco confere)', forged.status >= 400, forged.data);
  const used = await order(ana, 1, { coupon_code: code });
  check('pedido da Ana com o cupom: desconto de R$ 5,00', used.status === 201 && Number(used.data.order.discount) === 5, used.data);
  const again = await order(ana, 1, { coupon_code: code });
  check('segundo uso do mesmo cupom: recusado ("já foi todo usado")', again.status >= 400, again.data);
  await anaOrderCancel(used.data.order.order_number);
  check('pedido cancelado libera o cupom (o ponto já foi gasto e o cupom volta a valer)', (await order(ana, 1, { coupon_code: code })).status === 201);
  async function anaOrderCancel(n) {
    await owner.patch(`/api/admin/orders/${idOf(n)}`, { status: 'cancelled' });
  }
}

// ------------------------------------------------------------------------------------------------
section('7. Extrato só de acréscimo; acerto manual do owner');
{
  check('o banco recusa alterar uma linha do extrato', (() => {
    try {
      psql(`update loyalty_ledger set points = points + 1 where customer_id = '${anaId}'`);
      return false;
    } catch {
      return true;
    }
  })());
  const adj = (client, body) => client.post('/api/admin/loyalty/adjust', body);
  check('atendente não faz acerto (403)', (await adj(staff, { email: 'ana.pontos@exemplo.com', points: 10, note: 'teste' })).status === 403);
  for (const [name, body] of [['sem e-mail', { points: 10, note: 'motivo ok' }], ['pontos zero', { email: 'ana.pontos@exemplo.com', points: 0, note: 'motivo ok' }], ['pontos fracionados', { email: 'ana.pontos@exemplo.com', points: 1.5, note: 'motivo ok' }], ['sem motivo', { email: 'ana.pontos@exemplo.com', points: 10, note: '' }], ['conta que não existe', { email: 'ninguem@exemplo.com', points: 10, note: 'motivo ok' }]]) {
    check(`recusa: ${name}`, (await adj(owner, body)).status >= 400, body);
  }
  const plus = await adj(owner, { email: 'Ana.Pontos@Exemplo.com', points: 70, note: 'cortesia do dono' });
  check('crédito manual: 201 e saldo atualizado (30 + 70 = 100)', plus.status === 201 && plus.data.balance === 100, plus.data);
  const minus = await adj(owner, { email: 'ana.pontos@exemplo.com', points: -500, note: 'correção' });
  check('débito maior que o saldo: 409 (o saldo não fica negativo por acerto)', minus.status === 409, minus.data);
  check('o acerto e o motivo ficam no extrato e nas atividades', /adjust:70/.test(ledger(anaId)) && Number(psql("select count(*) from audit_log where action = 'loyalty.adjust'")) === 1);
  const panel = await owner.get('/api/admin/loyalty');
  check('o painel mostra o total em circulação e o extrato recente', panel.status === 200 && panel.data.totals.outstanding === 100 && panel.data.movements.length > 5 && panel.data.movements.some((m) => m.customer_email === 'ana.pontos@exemplo.com'), panel.data.totals);
}

// ------------------------------------------------------------------------------------------------
section('8. Saldo negativo por estorno depois da troca; apagar a conta apaga tudo');
{
  const ob = await order(bia, 3); // 150 pontos
  await deliver(ob.data.order.order_number);
  check('(preparação) Bia com 150 pontos', (await bia.get('/api/account/loyalty')).data.balance === 150);
  check('Bia troca 100 pontos (sobram 50)', (await bia.post('/api/account/loyalty/redeem', {})).status === 201);
  await owner.patch(`/api/admin/orders/${idOf(ob.data.order.order_number)}`, { payment_status: 'paid' });
  await owner.patch(`/api/admin/orders/${idOf(ob.data.order.order_number)}`, { payment_status: 'refunded' });
  const bal = (await bia.get('/api/account/loyalty')).data.balance;
  check('estorno de 150 depois de gastar 100: saldo −100 (honesto, não esconde)', bal === -100, bal);
  check('com saldo negativo não troca', (await bia.post('/api/account/loyalty/redeem', {})).status === 409);
  const gone = await bia.del('/api/account', { password: 'senha-forte-123' });
  check('a Bia apaga a conta (200)', gone.status === 200, gone.data);
  check('pontos e cupons pessoais dela foram embora junto', psql(`select (select count(*) from loyalty_ledger where customer_id = '${biaId}') + (select count(*) from coupons where customer_id = '${biaId}')`) === '0');
}

summary();
