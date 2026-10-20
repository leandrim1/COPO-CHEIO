// Agendamento de pedidos, feriados e horários especiais (migration 0030).
//  • desligado por padrão; ligado, o BANCO confere: formato, alinhamento à faixa, antecedência mínima, limite de dias, horário de funcionamento (semana, feriado, horário
//    especial), pedidos pausados e lotação por faixa (corrida entre pedidos simultâneos não estoura);
//  • loja fechada agora ainda recebe pedido agendado para quando abre; dia especial vale para pedido de agora e agendado;
//  • o pedido guarda o horário e o mostra (cliente e painel); pedidos sem agendamento não mudam.
// usage: bash tests/fresh.sh && node tests/api-test32.mjs      (BASE e TEST_DB escolhem o servidor e o banco)
import { execFileSync } from 'node:child_process';
import { Client, check, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const TZ = 'America/Sao_Paulo';
// Uma data/hora LOCAL da loja (dias a partir de hoje + hh:mm) → instante ISO em UTC, calculado pelo banco.
const at = (days, hhmm) => psql(`select to_char((((now() at time zone '${TZ}')::date + ${days})::timestamp + interval '${hhmm}:00') at time zone '${TZ}' at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
const dayOf = (days) => psql(`select ((now() at time zone '${TZ}')::date + ${days})::text`);

const owner = new Client(undefined, '198.51.100.50');
await owner.login();
const staff = new Client(undefined, '198.51.100.51');
await owner.post('/api/admin/admins', { name: 'Atendente', email: 'atendente32@copocheio.local', password: 'senha-forte-456', role: 'admin' });
await staff.login('atendente32@copocheio.local', 'senha-forte-456');
const anon = new Client(undefined, '198.51.100.52');
const store = (change) => owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true, ...change });
await store({});
const cat = (await owner.post('/api/admin/categories', { name: 'Agenda' })).data.category;
const beer = (await owner.post('/api/admin/products', { name: 'Cerveja Agenda', price: 10, category_id: cat.id, stock: 500, alcoholic: false, confirm_duplicate: true })).data.product;
let ip = 20;
const buyer = () => new Client(undefined, `203.0.113.${ip++}`);
let phone = 0;
const order = (extra = {}) => ({ customer_name: 'Cliente Agenda', customer_phone: `3496${String(4000000 + ++phone).slice(-7)}`, delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: beer.id, quantity: 1 }], ...extra });
const place = (extra) => buyer().post('/api/orders', order(extra));
const stockOf = () => Number(psql(`select stock from products where id = ${lit(beer.id)}`));

// ------------------------------------------------------------------------------------------------
section('1. Desligado por padrão: nada muda para quem não usa');
{
  const info = await anon.get('/api/schedule');
  check('GET /api/schedule com o agendamento desligado: enabled = false e sem faixas', info.status === 200 && info.data.enabled === false && info.data.days === undefined, info.data);
  const site = (await anon.get('/api/site')).data.store;
  check('o site sabe que está desligado e não recebe dias especiais', site.scheduling_enabled === false && Array.isArray(site.exceptions) && site.exceptions.length === 0, site);
  check('o site NÃO recebe a configuração interna do agendamento (antecedência, faixa, lotação)', site.schedule_lead_minutes === undefined && site.schedule_slot_capacity === undefined);
  const before = stockOf();
  const r = await place({ scheduled_for: at(1, '12:00') });
  check('pedido com scheduled_for com o agendamento desligado: recusado, sem reservar estoque', r.status === 400 && /agendamento.*não está disponível/i.test(r.data.error) && stockOf() === before, r.data);
  const plain = await place({});
  check('pedido comum (sem agendar) segue igual: sem a chave scheduled_for', plain.status === 201 && plain.data.order.scheduled_for === undefined, plain.data);
}

// ------------------------------------------------------------------------------------------------
section('2. Configuração: só valores válidos (o banco também confere)');
{
  const bad = async (name, body) => check(`recusa: ${name}`, (await owner.patch('/api/admin/store', body)).status === 400, body);
  await bad('faixa de 20 minutos', { schedule_slot_minutes: 20 });
  await bad('faixa de 0', { schedule_slot_minutes: 0 });
  await bad('0 dias à frente', { schedule_max_days: 0 });
  await bad('31 dias à frente', { schedule_max_days: 31 });
  await bad('antecedência negativa', { schedule_lead_minutes: -5 });
  await bad('lotação 0', { schedule_slot_capacity: 0 });
  await bad('agendamento "sim" (não é verdadeiro/falso)', { scheduling_enabled: 'sim' });
  const ok = await store({ scheduling_enabled: true, schedule_lead_minutes: 60, schedule_max_days: 3, schedule_slot_minutes: 30, schedule_slot_capacity: 2 });
  check('liga o agendamento (faixas de 30 min, 60 min de antecedência, 3 dias, 2 pedidos por faixa)', ok.status === 200 && ok.data.store.scheduling_enabled === true && ok.data.store.schedule_slot_capacity === 2, ok.data);
  check('o registro de atividades guarda a mudança', /agendamento|faixa|antecedência/i.test(psql("select string_agg(summary, ' | ') from audit_log where action = 'store.update'")));
  const site = (await anon.get('/api/site')).data.store;
  check('o site passa a saber que o agendamento está ligado', site.scheduling_enabled === true);
}

// ------------------------------------------------------------------------------------------------
section('3. As faixas que o cliente vê (GET /api/schedule)');
{
  const info = (await anon.get('/api/schedule')).data;
  check('ligado: enabled, antecedência, dias e tamanho da faixa', info.enabled === true && info.lead_minutes === 60 && info.max_days === 3 && info.slot_minutes === 30 && info.timezone === TZ, info);
  const days = info.days;
  check('até hoje + 3 dias, em ordem', days.length >= 3 && days.length <= 4 && days.every((d, i) => i === 0 || d.date > days[i - 1].date) && days.at(-1).date <= dayOf(3), days.map((d) => d.date));
  const tomorrow = days.find((d) => d.date === dayOf(1));
  check('amanhã (loja aberta 24h): 48 faixas de 30 min, todas livres', tomorrow?.slots.length === 48 && tomorrow.slots.every((s) => s.available === true), tomorrow?.slots.length);
  check('cada faixa traz o instante (ISO) e o horário local (HH:MM) alinhado a :00 ou :30', tomorrow.slots.every((s) => /^\d{4}-\d{2}-\d{2}T/.test(s.at) && /^\d{2}:(00|30)$/.test(s.time)), tomorrow.slots.slice(0, 3));
  const today = days.find((d) => d.date === dayOf(0));
  check('hoje: só aparecem faixas com a antecedência mínima (nenhuma no passado)', !today || today.slots.every((s) => new Date(s.at).getTime() >= Date.now() + 59 * 60_000), today?.slots.length);
}

// ------------------------------------------------------------------------------------------------
section('4. Pedido agendado: o banco confere tudo');
let firstOrder;
{
  const slot = at(1, '12:00');
  const before = stockOf();
  const ok = await place({ scheduled_for: slot });
  firstOrder = ok.data?.order;
  check('amanhã 12:00: pedido criado e a resposta traz o horário', ok.status === 201 && new Date(ok.data.order.scheduled_for).getTime() === new Date(slot).getTime(), ok.data);
  check('o estoque é reservado na hora do pedido', stockOf() === before - 1);
  check('o banco guarda o horário', psql(`select scheduled_for = ${lit(slot)}::timestamptz from orders where order_number = ${firstOrder.order_number}`) === 't');
  const admin = await owner.get(`/api/admin/orders/${firstOrder.order_number}`);
  check('o painel recebe o horário agendado', admin.data.order?.scheduled_for && new Date(admin.data.order.scheduled_for).getTime() === new Date(slot).getTime(), admin.data.order?.scheduled_for);
  const track = await anon.get(`/api/tracking/${ok.data.token}`);
  check('a página do cliente recebe o horário', track.data.order.scheduled_for && new Date(track.data.order.scheduled_for).getTime() === new Date(slot).getTime());

  const refuse = async (name, when, re) => {
    const stock0 = stockOf();
    const r = await place({ scheduled_for: when });
    check(`recusa: ${name}`, r.status === 400 && re.test(r.data.error) && stockOf() === stock0, [r.status, r.data]);
  };
  await refuse('horário que não é início de faixa (12:07)', at(1, '12:07'), /horários da lista/i);
  await refuse('horário no passado (ontem 12:00)', at(-1, '12:00'), /passou|muito perto/i);
  await refuse('mais perto que a antecedência mínima (daqui a 10 min alinhado à faixa)', psql("select to_char(date_trunc('hour', now()) + interval '30 minutes' + case when date_trunc('hour', now()) + interval '30 minutes' < now() + interval '10 minutes' then interval '30 minutes' else interval '0' end, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"), /passou|muito perto/i);
  await refuse('além do limite de dias (daqui a 10 dias)', at(10, '12:00'), /próximos 3 dia/i);
  await refuse('texto que não é data', 'amanhã de manhã', /horário válido/i);
  await refuse('data sem fuso', `${dayOf(1)}T12:00:00`, /horário válido/i);
  await refuse('lista no lugar do horário', [at(1, '13:00'), at(1, '14:00')], /horário válido/i);
  await refuse('SQL no lugar do horário', "2026-01-01T00:00:00Z'; drop table orders;--", /horário válido/i);
  check('nenhum pedido inválido foi criado', psql("select count(*) from orders where scheduled_for is not null") === '1');

  const key = 'chave-agendada-0123456789-abcdef';
  const b = buyer();
  const body = order({ scheduled_for: at(1, '13:00'), idempotency_key: key });
  const a1 = await b.post('/api/orders', body);
  const a2 = await b.post('/api/orders', body);
  check('repetir o envio do pedido agendado (mesma chave) devolve o MESMO pedido', a1.status === 201 && a2.status === 200 && a2.data.order.order_number === a1.data.order.order_number);
  const other = await b.post('/api/orders', { ...body, scheduled_for: at(1, '13:30') });
  check('a mesma chave com OUTRO horário é recusada (409), não troca o pedido', other.status === 409, other.data);
}

// ------------------------------------------------------------------------------------------------
section('5. Lotação por faixa (2 pedidos) e corrida');
{
  const slot = at(2, '15:00');
  const r1 = await place({ scheduled_for: slot });
  const r2 = await place({ scheduled_for: slot });
  const r3 = await place({ scheduled_for: slot });
  check('dois pedidos cabem; o terceiro é recusado como lotado', r1.status === 201 && r2.status === 201 && r3.status === 400 && /lotado/i.test(r3.data.error), [r1.status, r2.status, r3.status, r3.data]);
  const day2 = (await anon.get('/api/schedule')).data.days.find((d) => d.date === dayOf(2));
  const full = day2.slots.find((s) => new Date(s.at).getTime() === new Date(slot).getTime());
  check('a faixa cheia aparece como indisponível (available = false)', full && full.available === false && day2.slots.filter((s) => s.available).length === 47, full);
  const cancel = await owner.patch(`/api/admin/orders/${psql(`select id from orders where order_number = ${r1.data.order.order_number}`)}`, { status: 'cancelled' });
  check('cancelar um dos pedidos', cancel.status === 200, cancel.data);
  const r4 = await place({ scheduled_for: slot });
  check('pedido cancelado não ocupa a faixa: um novo cabe', r4.status === 201, r4.data);

  const race = at(2, '16:00');
  const runs = await Promise.all(Array.from({ length: 6 }, () => place({ scheduled_for: race })));
  const won = runs.filter((r) => r.status === 201).length;
  check('6 pedidos simultâneos para uma faixa de 2 vagas: exatamente 2 passam', won === 2 && psql(`select count(*) from orders where scheduled_for = ${lit(race)}::timestamptz`) === '2', runs.map((r) => r.status));
}

// ------------------------------------------------------------------------------------------------
section('6. Feriados e horários especiais (dias especiais)');
{
  check('sem login: 401; atendente (admin) pode gerenciar dias especiais', (await anon.get('/api/admin/exceptions')).status === 401 && (await staff.get('/api/admin/exceptions')).status === 200);
  const bad = async (name, body) => check(`recusa: ${name}`, (await staff.post('/api/admin/exceptions', body)).status === 400, body);
  await bad('dia fora do formato', { day: 'natal', kind: 'closed' });
  await bad('tipo desconhecido', { day: dayOf(5), kind: 'folga' });
  await bad('horário especial sem horas', { day: dayOf(5), kind: 'custom' });
  await bad('hora inválida', { day: dayOf(5), kind: 'custom', start_time: '25:00', end_time: '26:00' });
  await bad('fim antes do início (atravessaria a meia-noite)', { day: dayOf(5), kind: 'custom', start_time: '20:00', end_time: '02:00' });
  await bad('dia muito no passado', { day: dayOf(-10), kind: 'closed' });
  await bad('dia a mais de 400 dias', { day: dayOf(500), kind: 'closed' });
  await bad('motivo que não é texto', { day: dayOf(5), kind: 'closed', reason: { x: 1 } });

  const closed = await staff.post('/api/admin/exceptions', { day: dayOf(1), kind: 'closed', reason: 'Feriado de teste' });
  check('fecha amanhã (feriado)', closed.status === 201 && closed.data.exception.kind === 'closed', closed.data);
  const day1 = (await anon.get('/api/schedule')).data.days.find((d) => d.date === dayOf(1));
  check('amanhã some da lista de faixas', day1 === undefined);
  const before = stockOf();
  const tryClosed = await place({ scheduled_for: at(1, '18:00') });
  check('pedido agendado para o feriado: recusado ("a loja não abre nesse horário")', tryClosed.status === 400 && /não abre/i.test(tryClosed.data.error) && stockOf() === before, tryClosed.data);

  const custom = await staff.post('/api/admin/exceptions', { day: dayOf(2), kind: 'custom', start_time: '10:00', end_time: '12:00', reason: 'Meio período' });
  check('horário especial em depois de amanhã (10:00 às 12:00)', custom.status === 201 && custom.data.exception.start_time === '10:00' && custom.data.exception.end_time === '12:00', custom.data);
  const day2 = (await anon.get('/api/schedule')).data.days.find((d) => d.date === dayOf(2));
  check('só as faixas 10:00, 10:30, 11:00 e 11:30 existem naquele dia', day2.slots.map((s) => s.time).join() === '10:00,10:30,11:00,11:30', day2.slots.map((s) => s.time));
  check('11:30 passa; 12:00 (fim, exclusivo) e 15:00 são recusados', (await place({ scheduled_for: at(2, '11:30') })).status === 201 && (await place({ scheduled_for: at(2, '12:00') })).status === 400 && (await place({ scheduled_for: at(2, '15:00') })).status === 400);

  const site = (await anon.get('/api/site')).data.store;
  check('o site recebe os dias especiais (para saber se está aberto)', site.exceptions.length === 2 && site.exceptions.some((e) => e.day === dayOf(1) && e.kind === 'closed') && site.exceptions.some((e) => e.day === dayOf(2) && e.start_time && e.end_time), site.exceptions);

  const upsert = await staff.post('/api/admin/exceptions', { day: dayOf(1), kind: 'custom', start_time: '08:00', end_time: '09:00' });
  check('repetir o mesmo dia troca o dia especial (não duplica)', upsert.status === 201 && psql(`select count(*) from store_exceptions where day = ${lit(dayOf(1))}`) === '1' && upsert.data.exception.kind === 'custom');

  // Dia especial de HOJE vale para pedido de agora
  const nowOk = await place({});
  check('antes de fechar hoje: pedido de agora entra', nowOk.status === 201);
  await staff.post('/api/admin/exceptions', { day: dayOf(0), kind: 'closed', reason: 'Fechado hoje' });
  const nowClosed = await place({});
  check('hoje marcado como fechado: pedido de agora é recusado ("fechados agora")', nowClosed.status === 400 && /fechados/i.test(nowClosed.data.error), nowClosed.data);
  const stillScheduled = await place({ scheduled_for: at(2, '10:00') });
  check('...mas agendar para um dia aberto continua possível (loja fechada agora)', stillScheduled.status === 201, stillScheduled.data);
  check('...e o horário de HOJE continua fechado para agendamento', (await place({ scheduled_for: at(0, '23:30') })).status === 400);
  check('remover o dia especial: 200 e depois 404', (await staff.del(`/api/admin/exceptions/${dayOf(0)}`)).status === 200 && (await staff.del(`/api/admin/exceptions/${dayOf(0)}`)).status === 404);
  check('...e o pedido de agora volta a entrar', (await place({})).status === 201);
  check('o registro de atividades guarda cada dia especial', Number(psql("select count(*) from audit_log where action in ('exception.save', 'exception.delete')")) >= 4);
  for (const d of [1, 2]) await staff.del(`/api/admin/exceptions/${dayOf(d)}`);
}

// ------------------------------------------------------------------------------------------------
section('7. Loja fechada agora e pedidos pausados');
{
  const dow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][Number(psql(`select extract(dow from (now() at time zone '${TZ}'))::int`))];
  const closedToday = { ...ALL_DAYS, [dow]: { open: false, start: '00:00', end: '00:00' } };
  await owner.patch('/api/admin/store', { opening_hours: closedToday });
  const now = await place({});
  check('hoje fechado na semana: pedido de agora recusado', now.status === 400 && /fechados/i.test(now.data.error), now.data);
  const sched = await place({ scheduled_for: at(2, '17:00') });
  check('...mas pedido agendado para um dia em que a loja abre é aceito', sched.status === 201, sched.data);
  const today = (await anon.get('/api/schedule')).data.days.find((d) => d.date === dayOf(0));
  check('...e hoje (fechado) não tem faixas', today === undefined);

  await store({ orders_paused: true });
  const paused = await place({ scheduled_for: at(2, '17:30') });
  check('pedidos pausados: nem o agendado entra', paused.status === 400 && /não está recebendo/i.test(paused.data.error), paused.data);
  await store({ orders_paused: false });
  check('despausar: volta a entrar', (await place({ scheduled_for: at(2, '17:30') })).status === 201);

  await store({ scheduling_enabled: false });
  check('desligar o agendamento: o pedido agendado volta a ser recusado, mas os já feitos continuam', (await place({ scheduled_for: at(2, '18:00') })).status === 400 && psql("select count(*) from orders where scheduled_for is not null") !== '0');
  check('GET /api/schedule volta a dizer enabled = false', (await anon.get('/api/schedule')).data.enabled === false);
}

// ------------------------------------------------------------------------------------------------
section('8. Consistência');
{
  check('todo pedido agendado tem horário alinhado à faixa de 30 min', psql(`select count(*) from orders where scheduled_for is not null and (extract(minute from scheduled_for at time zone '${TZ}')::int % 30 <> 0 or extract(second from scheduled_for) <> 0)`) === '0');
  check('nenhuma faixa passou da lotação (2) entre pedidos não cancelados', psql("select count(*) from (select scheduled_for from orders where scheduled_for is not null and order_status <> 'cancelled' group by 1 having count(*) > 2) x") === '0');
  check('o JSON público de um pedido sem agendamento não ganha a chave scheduled_for', !('scheduled_for' in JSON.parse(psql("select order_json(id)::text from orders where scheduled_for is null order by order_number limit 1"))));
}

summary();
