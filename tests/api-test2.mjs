import { Client, check, section, summary } from './lib.mjs';

const anon = new Client();
const owner = new Client();
await owner.login();

// ------------------------------------------------------------------------------------------------
section('Configurações da loja, site, Hero, pagamento, bairros e banners');
let zoneA, zoneB;
{
  const s = await owner.get('/api/admin/settings');
  check('settings completos', s.status === 200 && s.data.store && s.data.site && s.data.hero && s.data.payments.length === 3 && Array.isArray(s.data.zones), Object.keys(s.data));

  const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
  const st = await owner.patch('/api/admin/store', {
    store_name: 'Copo Cheio Teste',
    whatsapp: '(34) 99999-1234',
    instagram: 'https://www.instagram.com/@copocheio.teste/',
    address: 'Rua das Bebidas, 100',
    cep: '38400-000',
    city: 'Uberlândia',
    state: 'mg',
    delivery_fee: '7,50',
    min_order: 20,
    delivery_time: '40 a 60 min',
    opening_hours: allDays,
  });
  const d = st.data.store;
  check('store: whatsapp só dígitos', d?.whatsapp === '34999991234', st.data);
  check('store: instagram normalizado', d?.instagram === 'copocheio.teste', d?.instagram);
  check('store: cep e UF normalizados', d?.cep === '38400000' && d?.state === 'MG');
  check('store: taxa e mínimo numéricos', d?.delivery_fee === 7.5 && d?.min_order === 20);
  check('site público reflete a loja', (await anon.get('/api/site')).data.store.store_name === 'Copo Cheio Teste');
  check('WhatsApp curto → 400', (await owner.patch('/api/admin/store', { whatsapp: '123' })).status === 400);
  check('UF inválida → 400', (await owner.patch('/api/admin/store', { state: 'MGG' })).status === 400);
  check('horário inválido → 400', (await owner.patch('/api/admin/store', { opening_hours: { mon: { open: true, start: '25:00', end: '10:00' } } })).status === 400);
  check('nome da loja vazio → 400', (await owner.patch('/api/admin/store', { store_name: ' ' })).status === 400);
  const both = await owner.patch('/api/admin/store', { delivery_enabled: false, pickup_enabled: false });
  check('desligar entrega E retirada → 400 com mensagem', both.status === 400 && /entrega ou retirada/.test(both.data.error), both.data);
  check('campo desconhecido é ignorado (id não muda)', (await owner.patch('/api/admin/store', { id: 2, password_hash: 'x', store_name: 'Copo Cheio Teste' })).status === 200);

  const site = await owner.patch('/api/admin/site', { seo_title: 'Copo Cheio – Teste', bebidas_title: 'Bebidas geladas pra você', bebidas_highlight: 'geladas', featured_limit: 2 });
  check('site: textos salvos', site.data.site?.seo_title === 'Copo Cheio – Teste' && site.data.site.featured_limit === 2, site.data);
  check('destaque fora do título → 400', (await owner.patch('/api/admin/site', { bebidas_title: 'Bebidas geladas pra você', bebidas_highlight: 'quentes' })).status === 400);
  check('limite de favoritos 9 → 400', (await owner.patch('/api/admin/site', { featured_limit: 9 })).status === 400);
  check('SEO title longo → 400', (await owner.patch('/api/admin/site', { seo_title: 'x'.repeat(71) })).status === 400);

  const hero = await owner.patch('/api/admin/hero', { title: 'Gelada em minutos, sempre.', title_highlight: 'Gelada', badge_text: 'GELADA • RÁPIDA', show_badge: false, show_secondary_button: false });
  check('hero salvo', hero.data.hero?.title === 'Gelada em minutos, sempre.' && hero.data.hero.show_badge === false, hero.data);
  check('hero público reflete', (await anon.get('/api/site')).data.hero.title === 'Gelada em minutos, sempre.');
  check('hero: destaque inexistente → 400', (await owner.patch('/api/admin/hero', { title: 'Outro título aqui', title_highlight: 'xyz' })).status === 400);
  const imgs = await owner.patch('/api/admin/hero', { images: ['https://teststore.public.blob.vercel-storage.com/hero/a.webp'] });
  check('hero: imagens (jsonb)', Array.isArray(imgs.data.hero?.images) && imgs.data.hero.images.length === 1, imgs.data);
  check('hero: 7 imagens → 400', (await owner.patch('/api/admin/hero', { images: Array(7).fill('https://x.com/a.png') })).status === 400);
  check('hero: imagem http → 400', (await owner.patch('/api/admin/hero', { images: ['http://x.com/a.png'] })).status === 400);
  await owner.patch('/api/admin/hero', { images: [], title: 'Sua bebida gelada chega até você.', title_highlight: 'bebida gelada', badge_text: 'GELADA • RÁPIDA • NA SUA CASA', show_badge: true, show_secondary_button: true });

  // pagamento
  const pix = await owner.patch('/api/admin/payments/pix', { details: 'chave@pix.com' });
  check('chave PIX salva', pix.data.payment?.details === 'chave@pix.com');
  check('site público recebe a chave PIX', (await anon.get('/api/site')).data.payments.find((p) => p.code === 'pix').details === 'chave@pix.com');
  await owner.patch('/api/admin/payments/cash', { enabled: false });
  await owner.patch('/api/admin/payments/card', { enabled: false });
  const last = await owner.patch('/api/admin/payments/pix', { enabled: false });
  check('não deixa desligar a última forma de pagamento', last.status === 400 && /pelo menos uma/.test(last.data.error), last.data);
  check('site só lista pagamentos ativos', (await anon.get('/api/site')).data.payments.map((p) => p.code).join() === 'pix');
  await owner.patch('/api/admin/payments/cash', { enabled: true });
  await owner.patch('/api/admin/payments/card', { enabled: true });
  check('pagamento inexistente → 404', (await owner.patch('/api/admin/payments/bitcoin', { enabled: true })).status === 404);

  // bairros
  const za = await owner.post('/api/admin/zones', { name: 'Centro', fee: 4 });
  const zb = await owner.post('/api/admin/zones', { name: 'Jardim Europa', fee: 9.5 });
  zoneA = za.data.zone;
  zoneB = zb.data.zone;
  check('bairros criados', za.status === 201 && zb.status === 201 && zb.data.zone.fee === 9.5);
  check('bairro repetido → 409', (await owner.post('/api/admin/zones', { name: 'centro', fee: 1 })).status === 409);
  check('bairros no site público', (await anon.get('/api/site')).data.zones.length === 2);
  check('editar bairro', (await owner.patch(`/api/admin/zones/${zoneA.id}`, { fee: 5 })).data.zone.fee === 5);

  // banners
  const b1 = await owner.post('/api/admin/banners', { title: 'Promo da semana', subtitle: 'Cerveja em dobro', link: '/bebidas', button_text: 'Ver', image_desktop_url: 'https://teststore.public.blob.vercel-storage.com/banners/x.webp' });
  const b2 = await owner.post('/api/admin/banners', { title: 'Segundo banner' });
  check('banners criados', b1.status === 201 && b2.status === 201 && b2.data.banner.position === 1, b2.data);
  check('banner sem conteúdo → erro', (await owner.post('/api/admin/banners', { subtitle: 'só subtítulo' })).status === 400);
  check('banner com link javascript: → 400', (await owner.post('/api/admin/banners', { title: 'x', link: 'javascript:alert(1)' })).status === 400);
  check('banner com link // (open redirect) → 400', (await owner.post('/api/admin/banners', { title: 'x', link: '//evil.com' })).status === 400);
  check('banners no site (ativos)', (await anon.get('/api/site')).data.banners.length === 2);
  await owner.put('/api/admin/banners/order', { ids: [b2.data.banner.id, b1.data.banner.id] });
  check('reordenar banners', (await anon.get('/api/site')).data.banners[0].title === 'Segundo banner');
  await owner.patch(`/api/admin/banners/${b2.data.banner.id}`, { active: false });
  check('banner inativo some do site', (await anon.get('/api/site')).data.banners.length === 1);
  check('admin ainda vê o inativo', (await owner.get('/api/admin/banners')).data.banners.length === 2);
  await owner.del(`/api/admin/banners/${b2.data.banner.id}`);
  await owner.del(`/api/admin/banners/${b1.data.banner.id}`);
  check('banners removidos', (await owner.get('/api/admin/banners')).data.banners.length === 0);
}

// ------------------------------------------------------------------------------------------------
section('Pedidos: o servidor decide preço, estoque, taxa e regras');
const cat = (await owner.post('/api/admin/categories', { name: 'Pedidos teste' })).data.category;
const mk = async (name, price, extra = {}) => (await owner.post('/api/admin/products', { name, price, category_id: cat.id, ...extra })).data.product;
const agua = await mk('Água 500ml', 3, { stock: 5 });
const vinho = await mk('Vinho Tinto', 50, { promo_price: 40 });
const caro = await mk('Whisky', 100);
const off = await mk('Produto inativo', 5, { active: false });
const esg = await mk('Produto esgotado', 5, { sold_out: true });
const order = (items, extra = {}) => ({
  customer_name: 'Maria da Silva',
  customer_phone: '(34) 98888-7777',
  delivery_type: 'delivery',
  address: 'Rua A',
  address_number: '10',
  neighborhood: 'Centro',
  payment_method: 'pix',
  items,
  ...extra,
});
let first;
{
  const r = await anon.post('/api/orders', order([{ product_id: vinho.id, quantity: 2 }, { product_id: agua.id, quantity: 1, price: 0.01, unit_price: 0.01 }], { total: 1, subtotal: 1, delivery_fee: 0 }));
  check('pedido criado (201)', r.status === 201, r.data);
  first = { ...r.data.order, token: r.data.token };
  check('número do pedido ≥ 1001', first?.order_number >= 1001, first?.order_number);
  check('preço vem do banco (promo 40×2 + 3), ignora o que o navegador mandou', first?.subtotal === 83, first);
  check('taxa por bairro (Centro = 5)', first?.delivery_fee === 5 && first?.total === 88, first);
  check('itens com preço e nome gravados', first?.items.length === 2 && first.items.find((i) => i.product_name === 'Vinho Tinto')?.unit_price === 40);
  check('status inicial new + histórico do cliente', first?.order_status === 'new' && first.history[0]?.status === 'new');
  check('pedido público não expõe telefone/e-mail/id/código', !('customer_phone' in first) && !('id' in first) && !('customer_email' in first) && !('token' in r.data.order), Object.keys(first));
  check('estoque descontado (5 → 4)', (await owner.get(`/api/admin/products/${agua.id}`)).data.product.stock === 4);
  const g = await anon.get(`/api/tracking/${first.token}`);
  check('cliente consulta pelo código secreto', g.status === 200 && g.data.order.order_number === first.order_number);
  check('código desconhecido → 404', (await anon.get('/api/tracking/00000000-0000-4000-8000-000000000000')).status === 404);
  check('código malformado → 404', (await anon.get('/api/tracking/1001')).status === 404);

  const bad = async (name, payload, re) => {
    const r2 = await anon.post('/api/orders', payload);
    check(`recusa: ${name}`, r2.status === 400 && (!re || re.test(r2.data.error)), r2.data);
  };
  await bad('carrinho vazio', order([]), /vazio/);
  await bad('produto inativo', order([{ product_id: off.id, quantity: 1 }]), /não está mais disponível/);
  await bad('produto esgotado', order([{ product_id: esg.id, quantity: 1 }]), /esgotado/);
  await bad('mais que o estoque', order([{ product_id: agua.id, quantity: 9 }]), /Temos só/);
  await bad('produto inexistente', order([{ product_id: '11111111-1111-4111-8111-111111111111', quantity: 1 }]), /não está mais disponível/);
  await bad('quantidade 0', order([{ product_id: vinho.id, quantity: 0 }]));
  await bad('quantidade negativa', order([{ product_id: vinho.id, quantity: -3 }]));
  await bad('id inválido', order([{ product_id: 'x', quantity: 1 }]));
  await bad('sem nome', order([{ product_id: vinho.id, quantity: 1 }], { customer_name: '' }), /nome/);
  await bad('telefone inválido', order([{ product_id: vinho.id, quantity: 1 }], { customer_phone: '123' }), /telefone/);
  await bad('e-mail inválido', order([{ product_id: vinho.id, quantity: 1 }], { customer_email: 'nao-e-email' }), /e-mail/);
  await bad('entrega sem endereço', order([{ product_id: vinho.id, quantity: 1 }], { address: '' }), /rua, número e bairro/i);
  await bad('bairro fora da lista', order([{ product_id: vinho.id, quantity: 1 }], { neighborhood: 'Lugar Nenhum' }), /Ainda não entregamos/);
  await bad('pagamento inexistente', order([{ product_id: vinho.id, quantity: 1 }], { payment_method: 'bitcoin' }), /pagamento/);
  await bad('tipo de entrega inválido', order([{ product_id: vinho.id, quantity: 1 }], { delivery_type: 'drone' }), /entrega ou retirada/);
  await bad('pedido mínimo (20) não atingido', order([{ product_id: agua.id, quantity: 1 }]), /pedido mínimo/i);
  await bad('troco menor que o total', order([{ product_id: vinho.id, quantity: 1 }], { payment_method: 'cash', change_for: '10' }), /troco/i);
  const ok = await anon.post('/api/orders', order([{ product_id: vinho.id, quantity: 1 }], { payment_method: 'cash', change_for: '100,00', delivery_type: 'pickup', notes: 'Sem gelo' }));
  check('retirada sem taxa + dinheiro com troco', ok.status === 201 && ok.data.order.delivery_fee === 0 && ok.data.order.change_for === 100 && ok.data.order.total === 40 && ok.data.order.address === null, ok.data);

  // lojas fechada / pausada
  await owner.patch('/api/admin/store', { orders_paused: true });
  const paused = await anon.post('/api/orders', order([{ product_id: vinho.id, quantity: 1 }]));
  check('loja pausada → recusa', paused.status === 400 && /não está recebendo pedidos/.test(paused.data.error), paused.data);
  await owner.patch('/api/admin/store', { orders_paused: false });
  const closed = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: false, start: '09:00', end: '23:00' }]));
  const hours = (await owner.get('/api/admin/settings')).data.store.opening_hours;
  await owner.patch('/api/admin/store', { opening_hours: closed });
  const shut = await anon.post('/api/orders', order([{ product_id: vinho.id, quantity: 1 }]));
  check('loja fechada → recusa', shut.status === 400 && /fechados/.test(shut.data.error), shut.data);
  await owner.patch('/api/admin/store', { opening_hours: hours });

  // sem bairros ativos → taxa única
  await owner.patch(`/api/admin/zones/${zoneA.id}`, { active: false });
  await owner.patch(`/api/admin/zones/${zoneB.id}`, { active: false });
  const flat = await anon.post('/api/orders', order([{ product_id: vinho.id, quantity: 1 }], { neighborhood: 'Qualquer' }));
  check('sem bairros ativos → taxa única de 7,50', flat.status === 201 && flat.data.order.delivery_fee === 7.5, flat.data);
  await owner.del(`/api/admin/zones/${zoneA.id}`);
  await owner.del(`/api/admin/zones/${zoneB.id}`);
}

// ------------------------------------------------------------------------------------------------
section('Painel de pedidos: lista, busca, status, histórico e cancelamento');
{
  const list = await owner.get('/api/admin/orders');
  check('lista de pedidos', list.status === 200 && list.data.orders.length >= 3 && list.data.counts.new >= 3, list.data.counts);
  const o = list.data.orders.find((x) => x.order_number === first.order_number);
  check('admin vê telefone, endereço, itens', o.customer_phone === '34988887777' && o.address === 'Rua A' && o.total === 88);
  check('busca por número', (await owner.get(`/api/admin/orders?q=%23${first.order_number}`)).data.orders.map((x) => x.order_number).join() === String(first.order_number));
  check('busca por telefone', (await owner.get('/api/admin/orders?q=98888')).data.orders.length >= 3);
  check('busca por nome', (await owner.get('/api/admin/orders?q=maria')).data.orders.length >= 3);
  check('busca sem resultado', (await owner.get('/api/admin/orders?q=zzzzzz')).data.orders.length === 0);
  const inj = await owner.get(`/api/admin/orders?q=${encodeURIComponent("'; drop table orders; --")}`);
  check('busca com SQL injection é inofensiva', inj.status === 200 && (await owner.get('/api/admin/orders')).status === 200);
  check('% e _ na busca são literais', (await owner.get('/api/admin/orders?q=%25')).data.orders.length === 0);
  check('filtro por status', (await owner.get('/api/admin/orders?status=delivered')).data.orders.length === 0);
  check('status inválido no filtro → 400', (await owner.get('/api/admin/orders?status=xx')).status === 400);
  check('paginação', (await owner.get('/api/admin/orders?limit=1')).data.has_more === true);

  const detail = await owner.get(`/api/admin/orders/${first.order_number}`);
  check('detalhe: pedido, itens e histórico', detail.status === 200 && detail.data.items.length === 2 && detail.data.history.length === 1 && detail.data.history[0].changed_by_name === 'Cliente (site)', detail.data.history);
  check('detalhe de pedido inexistente → 404', (await owner.get('/api/admin/orders/999999')).status === 404);

  const id = detail.data.order.id;
  const st = await owner.patch(`/api/admin/orders/${id}`, { status: 'confirmed' });
  check('confirmar', st.data.order?.order_status === 'confirmed', st.data);
  await owner.patch(`/api/admin/orders/${id}`, { status: 'preparing' });
  await owner.patch(`/api/admin/orders/${id}`, { status: 'out_for_delivery' });
  const hist = (await owner.get(`/api/admin/orders/${first.order_number}`)).data.history;
  check('histórico: de → para com o nome do admin', hist.length === 4 && hist[1].from_status === 'new' && hist[1].to_status === 'confirmed' && hist[1].changed_by_name === 'Dono Teste', hist);
  check('o cliente vê o andamento', (await anon.get(`/api/tracking/${first.token}`)).data.order.history.length === 4);
  check('status inválido → 400', (await owner.patch(`/api/admin/orders/${id}`, { status: 'sumiu' })).status === 400);
  check('patch vazio → 400', (await owner.patch(`/api/admin/orders/${id}`, {})).status === 400);
  check('pedido inexistente → erro', [400, 404].includes((await owner.patch('/api/admin/orders/11111111-1111-4111-8111-111111111111', { status: 'confirmed' })).status));
  const pay = await owner.patch(`/api/admin/orders/${id}`, { payment_status: 'paid' });
  check('pagamento: pago', pay.data.order?.payment_status === 'paid');
  const same = await owner.patch(`/api/admin/orders/${id}`, { status: 'out_for_delivery' });
  check('repetir o mesmo status não duplica histórico', same.status === 200 && (await owner.get(`/api/admin/orders/${first.order_number}`)).data.history.length === 4);
  check('itens e total não mudam pelo painel', (await owner.patch(`/api/admin/orders/${id}`, { status: 'delivered', total: 1, items: [] })).data.order.total === 88);

  // cancelar devolve estoque; cancelado não reabre
  const before = (await owner.get(`/api/admin/products/${agua.id}`)).data.product.stock;
  const o2 = (await anon.post('/api/orders', order([{ product_id: agua.id, quantity: 3 }, { product_id: vinho.id, quantity: 1 }]))).data.order;
  check('pedido consome estoque', (await owner.get(`/api/admin/products/${agua.id}`)).data.product.stock === before - 3);
  const id2 = (await owner.get(`/api/admin/orders/${o2.order_number}`)).data.order.id;
  await owner.patch(`/api/admin/orders/${id2}`, { status: 'cancelled' });
  check('cancelar devolve o estoque', (await owner.get(`/api/admin/products/${agua.id}`)).data.product.stock === before);
  const reopen = await owner.patch(`/api/admin/orders/${id2}`, { status: 'confirmed' });
  check('cancelado não reabre', reopen.status === 400 && /cancelado/.test(reopen.data.error), reopen.data);
  check('estoque não é devolvido duas vezes', (await owner.patch(`/api/admin/orders/${id2}`, { status: 'cancelled' })).status === 200 && (await owner.get(`/api/admin/products/${agua.id}`)).data.product.stock === before);

  // "ao vivo"
  const base = await owner.get('/api/admin/live');
  check('live sem after: só o ponto de partida', base.data.new_orders.length === 0 && base.data.latest >= first.order_number && base.data.pending >= 1, base.data);
  const o3 = (await anon.post('/api/orders', order([{ product_id: vinho.id, quantity: 1 }]))).data.order;
  const live = await owner.get(`/api/admin/live?after=${base.data.latest}`);
  check('live avisa do pedido novo', live.data.new_orders.length === 1 && live.data.new_orders[0].order_number === o3.order_number && live.data.new_orders[0].total === 47.5 && live.data.new_orders[0].customer_name === 'Maria da Silva', live.data);
  check('live: rev muda quando algo muda', live.data.rev !== base.data.rev);
  const live2 = await owner.get(`/api/admin/live?after=${live.data.latest}`);
  check('live: sem novidade não repete', live2.data.new_orders.length === 0);
}

// ------------------------------------------------------------------------------------------------
section('Dashboard');
{
  const d = await owner.get('/api/admin/dashboard?days=7');
  check('dashboard 200', d.status === 200, d.status);
  const c = d.data.cards;
  check('cards: pedidos de hoje e faturamento', c.today_orders >= 4 && c.revenue_today > 0 && c.pending >= 1, c);
  check('cards: entregues hoje contam o pedido entregue', c.delivered_today === 1, c);
  check('faturamento exclui cancelados', c.revenue_today === c.revenue_week && c.revenue_week === c.revenue_month, c);
  check('série dos últimos 7 dias', d.data.series.length === 7 && d.data.series.at(-1).orders >= 4, d.data.series.length);
  check('mais vendidos', d.data.top_products[0].name === 'Vinho Tinto' && d.data.top_products[0].quantity >= 4, d.data.top_products);
  check('pedidos recentes', d.data.recent.length >= 4 && d.data.recent[0].created_at >= d.data.recent[1].created_at);
  check('range: ticket médio', d.data.range.orders >= 4 && d.data.range.average_ticket > 0, d.data.range);
  check('dia: 24 barras por hora', (await owner.get('/api/admin/dashboard?days=1')).data.series.length === 24);
  check('30 dias: 30 barras', (await owner.get('/api/admin/dashboard?days=30')).data.series.length === 30);
  check('days inválido cai para 7', (await owner.get('/api/admin/dashboard?days=999')).data.series.length === 7);
}

// ------------------------------------------------------------------------------------------------
section('Concorrência: 12 compradores disputam 5 unidades');
{
  const last = await mk('Última Garrafa', 10, { stock: 5 });
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      new Client().post('/api/orders', order([{ product_id: last.id, quantity: 1 }], { customer_phone: `3497000${String(i).padStart(4, '0')}`, delivery_type: 'pickup' })),
    ),
  );
  const okN = results.filter((r) => r.status === 201).length;
  const p = (await owner.get(`/api/admin/products/${last.id}`)).data.product;
  check('exatamente 5 pedidos aceitos', okN === 5, results.map((r) => r.status).join());
  check('estoque termina em 0 e produto ESGOTADO', p.stock === 0 && p.sold_out === true, p);
  check('os outros 7 receberam mensagem clara', results.filter((r) => r.status !== 201).every((r) => r.status === 400 && /esgotado|Temos só/.test(r.data.error)), results.map((r) => r.data.error));
}

// ------------------------------------------------------------------------------------------------
section('Limites de pedido repetido');
{
  const phone = '(34) 91111-2222';
  const mkOrder = () => new Client().post('/api/orders', order([{ product_id: vinho.id, quantity: 1 }], { customer_phone: phone, delivery_type: 'pickup' }));
  const rs = [];
  for (let i = 0; i < 6; i++) rs.push(await mkOrder());
  check('6º pedido do mesmo telefone em 10 min é recusado', rs.slice(0, 5).every((r) => r.status === 201) && rs[5].status === 400 && /Muitos pedidos/.test(rs[5].data.error), rs.map((r) => r.status));
}

summary();
