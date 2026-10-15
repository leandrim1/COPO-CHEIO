// E-mails de pedido e pagamento: o banco enfileira o aviso sozinho (gatilhos), o servidor monta a mensagem na hora de enviar, e as travas
// (endereço digitado no pedido pode não ser do cliente) protegem terceiros. API real contra Postgres local + SMTP de mentira.
// usage: bash tests/fresh.sh && node tests/api-test18.mjs
import { execFileSync, execSync } from 'node:child_process';
import { Client, check, clearMail, mailMode, mailStats, mailsTo, registerVerified, section, summary } from './lib.mjs';

const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1'];
const psql = (sql) => execFileSync('psql', [...P, '-c', sql], { encoding: 'utf8' }).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const serve = (env = {}) => execSync(`bash ${new URL('./serve.sh', import.meta.url).pathname}`, { env: { ...process.env, ...env }, stdio: 'ignore' });
const BASE = process.env.BASE ?? 'http://127.0.0.1:4180';
const STRONG = 'Caixa#Segura-2026';
const PASS = 'senha-antiga-123';
let seq = 0;
const fresh = (prefix = 'ped') => `${prefix}${++seq}@exemplo.com`;
const rows = (where = 'true') => JSON.parse(psql(`select coalesce(json_agg(m order by m.created_at, m.id), '[]') from email_messages m where ${where}`));
const row = (where) => rows(where)[0];
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* ainda não */
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
};
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));

const owner = new Client(undefined, '198.51.100.31');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const anon = new Client();
const cat = (await owner.post('/api/admin/categories', { name: 'Cervejas' })).data.category;
const beer = (await owner.post('/api/admin/products', { name: 'Heineken Long Neck', price: 8.5, category_id: cat.id, stock: 500, confirm_duplicate: true })).data.product;
const water = (await owner.post('/api/admin/products', { name: 'Água com gás', price: 4, category_id: cat.id, stock: 500, confirm_duplicate: true })).data.product;

let ip = 40;
const buyer = () => new Client(undefined, `203.0.113.${ip++}`);
let phone = 0;
const nextPhone = () => `3496${String(3000000 + ++phone).slice(-7)}`;
// O site sempre manda uma chave de idempotência (o código de acompanhamento nasce dela); os pedidos de teste também.
let keyN = 0;
const nextKey = () => `chave-pedido-18-${String(++keyN).padStart(6, '0')}-abcdef`;
async function placeOrder(extra = {}, items = [{ product_id: beer.id, quantity: 2 }], client = buyer()) {
  const r = await client.post('/api/orders', { customer_name: 'Carla Compradora', customer_phone: nextPhone(), delivery_type: 'pickup', payment_method: 'pix', items, idempotency_key: nextKey(), ...extra });
  if (r.status !== 201 && r.status !== 200) throw new Error(`pedido recusado: ${r.status} ${JSON.stringify(r.data)}`);
  const number = r.data.order.order_number;
  return { c: client, token: r.data.token, order: r.data.order, number, id: psql(`select id from orders where order_number = ${number}`), status: r.status };
}
const orderRow = (n) => JSON.parse(psql(`select row_to_json(o) from orders o where order_number = ${n}`));
const msgs = (n, kind) => rows(`order_id = (select id from orders where order_number = ${n})${kind ? ` and kind = ${lit(kind)}` : ''}`);
const patchStatus = (id, status) => owner.patch(`/api/admin/orders/${id}`, { status });
const process_ = () => owner.post('/api/admin/emails/process');
// Espera a fila em segundo plano mandar (o pedido dispara o envio sem esperar) e devolve os e-mails que chegaram ao endereço.
const arrive = async (email, count = 1, subject = /./) => (await until(async () => (await mailsTo(email)).filter((m) => subject.test(m.subject)).length >= count, 8000)) && (await mailsTo(email)).filter((m) => subject.test(m.subject));
const plain = (m) => `${m.subject}\n${m.text}`;

// ------------------------------------------------------------------------------------------------
section('1. Pedido de visitante: o banco enfileira "pedido recebido" e o e-mail sai sem o cliente esperar');
const g1mail = fresh();
let G1;
{
  await clearMail();
  G1 = await placeOrder({ customer_email: g1mail, delivery_type: 'delivery', neighborhood: 'Centro', address: 'Rua Secreta', address_number: '123', complement: 'apto 45', payment_method: 'cash', change_for: '50' });
  const fila = msgs(G1.number);
  check('uma mensagem do tipo "pedido recebido", transacional, para o e-mail digitado, ligada ao pedido', fila.length === 1 && fila[0].kind === 'order_received' && fila[0].category === 'transactional' && fila[0].recipient_email === g1mail && fila[0].order_id === G1.id, fila);
  check('a chave de unicidade é "order:<pedido>:<tipo>" (uma só vez por etapa)', fila[0]?.dedupe_key === `order:${G1.id}:order_received`, fila[0]?.dedupe_key);
  check('a receita guardada só tem o id do pedido (nada de nome, telefone ou endereço)', JSON.stringify(fila[0]?.spec) === JSON.stringify({ order_id: G1.id }), fila[0]?.spec);
  const mail = (await arrive(g1mail))[0];
  check('o e-mail chegou ao servidor de e-mail', Boolean(mail), (await mailsTo(g1mail)).length);
  check('assunto claro, com o número do pedido e o nome da loja', mail?.subject === `Pedido #${G1.number} recebido – Copo Cheio`, mail?.subject);
  const done = row(`order_id = ${lit(G1.id)} and kind = 'order_received'`);
  check('registro: aceito pelo servidor SMTP, 1 tentativa, assunto guardado, receita apagada ao terminar', done?.status === 'accepted' && done.attempts === 1 && done.subject === mail?.subject && done.spec === null, done);
  check('o Message-ID é o do registro', mail?.headers['message-id'] === done?.message_id, [mail?.headers['message-id'], done?.message_id]);
  const text = plain(mail);
  check('o texto traz o pedido, os itens, a taxa e o total', text.includes(`#${G1.number}`) && /2\s*[x×]?\s*Heineken Long Neck/i.test(text) && /R\$\s*17,00/.test(text) && /Taxa de entrega/i.test(text) && /R\$\s*22,00/.test(text), text.slice(0, 900));
  check('mostra só o bairro da entrega: nunca o endereço, o telefone nem o troco', /Centro/.test(text) && !/Rua Secreta|apto 45|\b3496\d{7}\b|troco/i.test(text) && !/Rua Secreta|apto 45/.test(mail.html), text);
  check('nome e forma de pagamento aparecem', /Carla/.test(text) && /dinheiro/i.test(text), text.slice(0, 400));
  check('transacional: e-mail automático, SEM cabeçalho de descadastro de promoção', mail.headers['auto-submitted'] === 'auto-generated' && !mail.headers['list-unsubscribe'] && !mail.headers['list-unsubscribe-post']);
  const link = /https?:\/\/[^\s"<>]+\/acompanhar-pedido\/([A-Za-z0-9_-]+)/.exec(mail.html)?.[1];
  check('o link de acompanhamento vale: o mesmo código que o cliente recebeu ao pedir', link === G1.token, [link, G1.token]);
  check('...e abre o pedido certo', (await anon.get(`/api/tracking/${link}`)).data?.order?.order_number === G1.number);
  const prefs = /\/conta\/emails\/([0-9a-f-]{36}_[0-9a-f]{32})/.exec(mail.html)?.[1];
  check('há um link para não receber e-mails de pedidos neste endereço', Boolean(prefs), mail.html.match(/href="[^"]+"/g));
  check('só links https/do próprio site e nenhuma imagem de rastreamento (sem pixel de abertura)', !/<img[^>]+\b(width|height)=["']?1["']?[\s>\/]/i.test(mail.html) && !/\bopen\b.*pixel|track\.gif/i.test(mail.html) && [...mail.html.matchAll(/(?:href|src)="([^"]+)"/g)].every((m) => /^(https:\/\/|mailto:|tel:|http:\/\/127\.0\.0\.1|http:\/\/localhost)/.test(m[1])), [...mail.html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]));
  check('a lista de pedidos do painel não vê corpo nem receita', !Object.keys((await owner.get(`/api/admin/emails/messages?q=${g1mail}`)).data.messages[0] ?? {}).some((k) => /^(spec|html|text|body)/.test(k)));
}

// ------------------------------------------------------------------------------------------------
section('2. Reenvio do mesmo pedido (chave de idempotência) e reprocessamento da fila: nenhum e-mail repetido');
{
  const email = fresh();
  const same = { customer_name: 'Rita Repetida', customer_phone: nextPhone(), customer_email: email, delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: beer.id, quantity: 1 }], idempotency_key: 'chave-idem-pedido-18-0001' };
  await clearMail();
  const c0 = buyer();
  const ra = await c0.post('/api/orders', same);
  const rb = await c0.post('/api/orders', same);
  const a = { number: ra.data?.order?.order_number, id: psql(`select id from orders where order_number = ${ra.data?.order?.order_number}`) };
  const b = { number: rb.data?.order?.order_number, status: rb.status };
  check('o segundo envio devolve o MESMO pedido (200)', ra.status === 201 && b.status === 200 && b.number === a.number, [a.number, b.number, b.status]);
  await arrive(email);
  await process_();
  await process_();
  await new Promise((r) => setTimeout(r, 400));
  check('uma mensagem no registro e um e-mail entregue ao servidor', msgs(a.number).length === 1 && (await mailsTo(email)).length === 1, [msgs(a.number).length, (await mailsTo(email)).length]);
  // O mesmo gatilho disparado de novo (ex.: histórico reescrito) bate na chave de unicidade.
  psql(`insert into order_status_history (order_id, from_status, to_status, changed_by_name) values (${lit(a.id)}, 'new', 'new', 'teste')`);
  check('um segundo "novo" no histórico não gera outro e-mail', msgs(a.number).length === 1);
}

// ------------------------------------------------------------------------------------------------
section('3. O caminho do pedido: confirmado, saiu para entrega, entregue, cancelado — um e-mail por etapa, texto certo para entrega e retirada');
const flowMail = fresh('fluxo');
let F;
{
  await clearMail();
  F = await placeOrder({ customer_email: flowMail, delivery_type: 'delivery', neighborhood: 'Centro', address: 'Rua das Flores', address_number: '10' });
  await arrive(flowMail, 1);
  check('a mudança de etapa pelo painel é registrada e a fila só pega etapas novas', (await patchStatus(F.id, 'confirmed')).status === 200);
  check('"confirmado": e-mail enfileirado e enviado', (await arrive(flowMail, 1, /confirmado/)).length === 1);
  check('repetir a mesma etapa não duplica (o painel recusa ou ignora)', [200, 400, 409].includes((await patchStatus(F.id, 'confirmed')).status) && msgs(F.number, 'order_confirmed').length === 1);
  check('"preparando" não manda e-mail (não é uma etapa que o cliente precise saber)', (await patchStatus(F.id, 'preparing')).status === 200 && msgs(F.number).length === 2);
  await patchStatus(F.id, 'out_for_delivery');
  const out = (await arrive(flowMail, 1, /saiu para entrega/))[0];
  check('"saiu para entrega": texto de ENTREGA', Boolean(out) && /saiu para entrega/i.test(plain(out)) && !/retirar/i.test(out.subject), out?.subject);
  await patchStatus(F.id, 'delivered');
  const del = (await arrive(flowMail, 1, /entregue/))[0];
  check('"entregue": agradece e usa o texto de entrega', Boolean(del) && /entregue/i.test(del.subject) && !/retirad/i.test(del.subject), del?.subject);
  const kinds = msgs(F.number).map((m) => m.kind).join(',');
  check('o histórico do pedido tem exatamente: recebido, confirmado, saiu, entregue', kinds === 'order_received,order_confirmed,order_out_for_delivery,order_delivered', kinds);
  check('todos aceitos pelo servidor, uma tentativa cada', msgs(F.number).every((m) => m.status === 'accepted' && m.attempts === 1), msgs(F.number).map((m) => [m.kind, m.status, m.attempts]));
  check('os quatro e-mails enviados caíram no mesmo destinatário', (await mailsTo(flowMail)).length === 4, (await mailsTo(flowMail)).map((m) => m.subject));
}
{
  // Retirada na loja: "pronto para retirar" e "retirado".
  const email = fresh('retira');
  await clearMail();
  const R = await placeOrder({ customer_email: email, delivery_type: 'pickup' });
  await arrive(email, 1);
  await patchStatus(R.id, 'confirmed');
  await patchStatus(R.id, 'out_for_delivery');
  const ready = (await arrive(email, 1, /pronto para retirar/))[0];
  check('retirada: "pronto para retirar" (não "saiu para entrega")', Boolean(ready) && !/entrega/i.test(ready.subject) && /passar na loja para retirar/i.test(plain(ready)), ready?.subject);
  await patchStatus(R.id, 'delivered');
  const done = (await arrive(email, 1, /retirado/))[0];
  check('retirada: "retirado"', Boolean(done) && /retirado/i.test(done.subject), done?.subject);
}
{
  // Cancelamento de um pedido que não foi pago pelo site.
  const email = fresh('cancela');
  await clearMail();
  const C = await placeOrder({ customer_email: email });
  await arrive(email, 1);
  await patchStatus(C.id, 'cancelled');
  const cancelled = (await arrive(email, 1, /cancelado/))[0];
  check('cancelado: avisa o cliente, sem prometer reembolso que não existe', Boolean(cancelled) && /cancelado/i.test(cancelled.subject) && !/devolu|reembols|estorno/i.test(cancelled.text), cancelled?.text?.slice(0, 500));
}

// ------------------------------------------------------------------------------------------------
section('4. Sem e-mail no pedido: nenhum e-mail; com conta, vai para o e-mail da conta; e-mail da conta não vaza para outro pedido');
{
  const none = await placeOrder({});
  await patchStatus(none.id, 'confirmed');
  check('pedido sem e-mail e sem conta: nada na fila', msgs(none.number).length === 0);
  const acct = fresh('conta');
  const maria = buyer();
  await registerVerified(maria, { name: 'Maria Conta', email: acct, phone: nextPhone(), password: PASS });
  await clearMail();
  const mine = await placeOrder({}, [{ product_id: water.id, quantity: 3 }], maria);
  const m = (await arrive(acct, 1, /recebido/))[0];
  check('logada e sem e-mail no pedido: o aviso vai para o e-mail da conta', Boolean(m) && msgs(mine.number)[0]?.recipient_email === acct, msgs(mine.number));
  check('...e o pedido de quem NÃO está logado e não deu e-mail continua sem aviso', msgs(none.number).length === 0);
  // Pagamento marcado à mão pela loja (dinheiro, Pix da loja) não gera e-mail de pagamento: a loja já falou com o cliente.
  const cashEmail = fresh('dinheiro');
  const cash = await placeOrder({ customer_email: cashEmail, payment_method: 'cash' });
  await owner.patch(`/api/admin/orders/${cash.id}`, { payment_status: 'paid' });
  await owner.patch(`/api/admin/orders/${cash.id}`, { payment_status: 'refunded' });
  await process_();
  check('pagamento marcado à mão não manda e-mail de pagamento nem de reembolso', msgs(cash.number).every((m) => m.kind === 'order_received'), msgs(cash.number).map((m) => m.kind));
  const other = fresh('outro');
  await clearMail();
  const withOther = await placeOrder({ customer_email: other }, [{ product_id: water.id, quantity: 1 }], maria);
  await arrive(other, 1);
  check('logada, mas digitou outro e-mail no pedido: vai para o digitado, NÃO para o da conta', msgs(withOther.number)[0]?.recipient_email === other && (await mailsTo(acct)).length === 0, msgs(withOther.number));
}

// ------------------------------------------------------------------------------------------------
section('5. Pagamento online (Pix): só "pagamento confirmado" (um e-mail, não dois), cancelamento por falta de pagamento e reembolso');
{
  psql(`insert into merchant_accounts (provider, kind, status, provider_account_id, proposal_id, authorized_at) values ('simulador', 'pj', 'approved', 'sim-sub-18', 'sim-prop-18', now())`);
  const on = await owner.patch('/api/admin/payments/pix_online', { enabled: true });
  check('Pix online ligado para o teste', on.status === 200, on.data);
  const sim = (path, body) => fetch(`${BASE}/__pay/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
  const email = fresh('pix');
  await clearMail();
  const A = await placeOrder({ customer_email: email, payment_method: 'pix_online' });
  check('pedido nasce "aguardando pagamento" e NÃO manda "pedido recebido"', orderRow(A.number).order_status === 'awaiting_payment' && msgs(A.number).length === 0, msgs(A.number));
  const created = await A.c.post(`/api/tracking/${A.token}/payment`, { method: 'pix' });
  check('Pix gerado', created.status === 201, created.data);
  const charge = psql(`select provider_charge_id from payments p join orders o on o.id = p.order_id where o.order_number = ${A.number}`);
  await sim(`charge/${charge}`, { status: 'paid' });
  const refreshed = await owner.post(`/api/admin/payments/${psql(`select p.id from payments p join orders o on o.id = p.order_id where o.order_number = ${A.number}`)}/refresh`);
  check('a operadora confirma e o painel atualiza o pagamento', refreshed.status === 200 && orderRow(A.number).payment_status === 'paid', [refreshed.status, orderRow(A.number).payment_status]);
  const pay = (await arrive(email, 1, /Pagamento do pedido/))[0];
  check('"pagamento confirmado": um e-mail só, com o valor, a taxa de serviço do Pix (R$ 0,43) e o total (R$ 17,43)', Boolean(pay) && /confirmado/i.test(pay.subject) && /R\$\s*17,00/.test(plain(pay)) && /Taxa de serviço do Pix/.test(plain(pay)) && /R\$\s*0,43/.test(plain(pay)) && /R\$\s*17,43/.test(plain(pay)) && (await mailsTo(email)).length === 1, (await mailsTo(email)).map((m) => m.subject));
  check('...e NÃO sai "pedido recebido" junto', msgs(A.number, 'order_received').length === 0 && msgs(A.number, 'payment_confirmed').length === 1, msgs(A.number).map((m) => m.kind));
  // Ver o mesmo pagamento de novo (atualização repetida) não repete o aviso.
  await owner.post(`/api/admin/payments/${psql(`select p.id from payments p join orders o on o.id = p.order_id where o.order_number = ${A.number}`)}/refresh`);
  await process_();
  check('atualizar o mesmo pagamento de novo não duplica o e-mail', msgs(A.number, 'payment_confirmed').length === 1 && (await mailsTo(email)).length === 1);
  await patchStatus(A.id, 'confirmed');
  check('depois, a loja confirma o pedido: "confirmado" segue normalmente', (await arrive(email, 1, /Pedido #\d+ confirmado/)).length === 1 && msgs(A.number, 'order_confirmed').length === 1);

  // Pagamento online: a loja não marca "reembolsado" à mão (quem confirma é a operadora).
  check('pagamento online não se altera à mão no painel (400)', (await owner.patch(`/api/admin/orders/${A.id}`, { payment_status: 'refunded' })).status === 400);
  // Estorno PARCIAL: o pedido segue pago e nada é enviado; estorno TOTAL: "reembolso registrado".
  await sim(`charge/${charge}`, { status: 'refunded', refundedCents: 500 });
  await sim('webhook', { id: 'evt-18-part', type: 'charge.refunded', chargeId: charge });
  await process_();
  check('estorno parcial: o pedido continua "pago" e nenhum e-mail de reembolso sai', orderRow(A.number).payment_status === 'paid' && msgs(A.number, 'payment_refunded').length === 0);
  await sim(`charge/${charge}`, { status: 'refunded', refundedCents: 1743 });
  await sim('webhook', { id: 'evt-18-total', type: 'charge.refunded', chargeId: charge });
  const refund = (await arrive(email, 1, /Reembolso/))[0];
  check('estorno total: e-mail "reembolso", sem prometer prazo', Boolean(refund) && /reembolso/i.test(refund.subject) && /R\$\s*17,43/.test(plain(refund)) && !/em até \d+ dias/i.test(refund.text), refund?.subject);

  // Pedido que não foi pago a tempo e foi cancelado: texto "nada foi cobrado".
  const email2 = fresh('pixexp');
  await clearMail();
  const B = await placeOrder({ customer_email: email2, payment_method: 'pix_online' });
  psql(`update orders set order_status = 'cancelled' where id = ${lit(B.id)}`);
  psql(`insert into order_status_history (order_id, from_status, to_status, changed_by_name) values (${lit(B.id)}, 'awaiting_payment', 'cancelled', 'Sistema')`);
  await process_();
  const exp = (await arrive(email2, 1, /cancelado/))[0];
  check('cancelado por falta de pagamento: diz que nada foi cobrado', Boolean(exp) && /nada foi cobrado/i.test(plain(exp)) && !/devolu/i.test(plain(exp)), exp?.text?.slice(0, 500));

  // Pagamento que chega depois de o pedido ter sido cancelado não vira "pagamento confirmado".
  const email3 = fresh('pixlate');
  await clearMail();
  const L = await placeOrder({ customer_email: email3, payment_method: 'pix_online' });
  psql(`update orders set order_status = 'cancelled' where id = ${lit(L.id)}`);
  psql(`update orders set payment_status = 'paid' where id = ${lit(L.id)}`);
  check('pagamento tardio de pedido cancelado não manda "pagamento confirmado"', msgs(L.number, 'payment_confirmed').length === 0, msgs(L.number).map((m) => m.kind));
}

// ------------------------------------------------------------------------------------------------
section('6. Falha do servidor de e-mail NÃO atrapalha o pedido; o aviso espera na fila e sai depois; e-mail velho não sai fora de hora');
{
  const email = fresh('falha');
  await clearMail();
  await mailMode('temp');
  const t = await placeOrder({ customer_email: email });
  check('o pedido entra normalmente com o servidor de e-mail fora do ar (201)', t.status === 201);
  const q = await until(() => {
    const m = msgs(t.number)[0];
    return m && m.attempts === 1 && m.status === 'queued' ? m : null;
  });
  check('o aviso fica na fila, com a 1ª tentativa registrada, o motivo (451) e a hora da próxima', q && q.error_kind === 'recipient' && /451/.test(q.error_code) && q.next_attempt_at !== null, q);
  // A loja avança o pedido enquanto o e-mail estava preso: o "recebido" que sobrou já não faz sentido.
  await patchStatus(t.id, 'confirmed');
  await patchStatus(t.id, 'out_for_delivery');
  await patchStatus(t.id, 'delivered');
  // Espera as quatro mensagens serem tentadas uma vez (e falharem) antes de o servidor de e-mail "voltar": nenhuma fica no meio do envio.
  const settled = await until(() => msgs(t.number).length === 4 && msgs(t.number).every((m) => m.status === 'cancelled' || (m.status === 'queued' && m.attempts === 1)));
  check('com o servidor fora do ar, o que ficou velho já é cancelado na vez de tentar e o aviso da etapa atual espera na fila', Boolean(settled) && msgs(t.number, 'order_delivered')[0]?.status === 'queued', msgs(t.number).map((m) => [m.kind, m.status, m.attempts]));
  await mailMode(null);
  psql(`update email_messages set next_attempt_at = now() - interval '1 minute' where order_id = ${lit(t.id)}`);
  const run = await process_();
  const states = Object.fromEntries(msgs(t.number).map((m) => [m.kind, m.status]));
  check('na hora, só sai o que ainda faz sentido: "recebido", "confirmado" e "saiu" ficam cancelados; "retirado" sai', states.order_delivered === 'accepted' && states.order_received === 'cancelled' && states.order_confirmed === 'cancelled' && states.order_out_for_delivery === 'cancelled', states);
  check('...e o cliente recebeu um único e-mail: o "retirado"', (await mailsTo(email)).length === 1 && /retirado/i.test((await mailsTo(email))[0].subject), (await mailsTo(email)).map((m) => m.subject));
  void run;
}

// ------------------------------------------------------------------------------------------------
section('7. Travas contra abuso: endereço de outra pessoa digitado no pedido');
{
  // 7a. Domínio inexistente / descartável: o e-mail nem é tentado.
  await clearMail();
  const before = await mailStats();
  const ghost = await placeOrder({ customer_email: 'alguem@dominio-inexistente-xyz.com' });
  await process_();
  const g = msgs(ghost.number)[0];
  check('domínio que não existe: bloqueado ("domínio inexistente, descartável…"), sem tentar o servidor de e-mail', g?.status === 'blocked' && g.block_reason === 'bad_domain' && (await mailStats()).rcpt === before.rcpt, [g, before, await mailStats()]);
  const disp = await placeOrder({ customer_email: 'teste@mailinator.com' });
  await process_();
  check('e-mail descartável (mailinator.com): bloqueado', msgs(disp.number)[0]?.block_reason === 'bad_domain', msgs(disp.number));

  // 7b. Teto por endereço no mesmo tipo: o 5º "pedido recebido" em 24 h para o mesmo endereço não sai.
  const victim = fresh('vitima');
  await clearMail();
  const made = [];
  for (let i = 0; i < 6; i++) {
    const o = await placeOrder({ customer_email: victim }, [{ product_id: water.id, quantity: 1 }]);
    made.push(o);
    // Cada aviso é decidido (enviado ou bloqueado) antes do pedido seguinte, como no uso real. Sem esperar, o envio em segundo plano de
    // pedidos feitos em rajada vê os avisos "irmãos" ainda na fila e bloqueia além do teto (em máquina lenta, como a do CI, deu 3 em vez de 4).
    await until(() => ['accepted', 'blocked'].includes(msgs(o.number, 'order_received')[0]?.status));
  }
  for (let i = 0; i < 4; i++) await process_();
  await new Promise((r) => setTimeout(r, 600));
  const states = made.map((o) => msgs(o.number, 'order_received')[0]?.status);
  check('para o mesmo endereço, só 4 "pedido recebido" por dia; os outros ficam bloqueados', states.filter((s) => s === 'accepted').length === 4 && states.filter((s) => s === 'blocked').length === 2, states);
  check('...e o servidor de e-mail recebeu só 4 mensagens para esse endereço', (await mailsTo(victim)).length === 4, (await mailsTo(victim)).length);
  check('o motivo do bloqueio fica no registro', rows(`recipient_email = ${lit(victim)} and status = 'blocked'`).every((m) => m.block_reason === 'recipient_limit'));

  // 7c. Devolução definitiva (caixa inexistente) suprime o endereço: nada mais é enviado a ele, de nenhum tipo.
  const bad = 'naoexiste-18@exemplo.com';
  await clearMail();
  const first = await placeOrder({ customer_email: bad });
  await until(() => msgs(first.number)[0]?.status === 'failed');
  const f = msgs(first.number)[0];
  check('caixa inexistente: o aviso falha de vez (sem repetir) e registra a devolução definitiva', f?.status === 'failed' && f.bounce_type === 'hard' && f.error_kind === 'recipient' && f.attempts === 1, f);
  check('o endereço entrou na lista de supressão', psql(`select reason from email_suppressions where email = ${lit(bad)}`) === 'hard_bounce');
  const rcpt = (await mailStats()).rcpt;
  await patchStatus(first.id, 'confirmed');
  await process_();
  const second = msgs(first.number, 'order_confirmed')[0];
  check('as etapas seguintes do mesmo pedido são bloqueadas ("suprimido") sem procurar o servidor', second?.status === 'blocked' && second.block_reason === 'suppressed' && (await mailStats()).rcpt === rcpt, [second, rcpt, await mailStats()]);
}

// ------------------------------------------------------------------------------------------------
section('8. "Não quero e-mails de pedidos neste endereço": pelo link do e-mail (sem login)');
{
  const email = fresh('pref');
  await clearMail();
  const A = await placeOrder({ customer_email: email });
  const mail = (await arrive(email))[0];
  const token = /\/conta\/emails\/([0-9a-f-]{36}_[0-9a-f]{32})/.exec(mail.html)[1];
  const got = await anon.get(`/api/email/preferences/${token}`);
  check('a página de preferências mostra o endereço mascarado e o estado', got.status === 200 && got.data.notify_orders === true && got.data.marketing === false && !JSON.stringify(got.data).includes(email) && /\*/.test(got.data.email_masked), got.data);
  check('sem rastreio em cache: resposta marcada noindex', got.headers.get('x-robots-tag') === 'noindex, nofollow');
  const off = await anon.patch(`/api/email/preferences/${token}`, { notify_orders: false });
  check('desligar os avisos de pedido pelo link (sem login)', off.status === 200 && off.data.notify_orders === false, off.data);
  await patchStatus(A.id, 'confirmed');
  await process_();
  const blocked = msgs(A.number, 'order_confirmed')[0];
  check('as etapas seguintes ficam bloqueadas ("pediu para não receber")', blocked?.status === 'blocked' && blocked.block_reason === 'order_notices_off', blocked);
  check('...e nada novo foi enviado', (await mailsTo(email)).length === 1);
  check('ligar promoções por este link é recusado quando a conta não existe (409)', (await anon.patch(`/api/email/preferences/${token}`, { marketing: true })).status === 409);
  check('link adulterado ou inventado: sempre 404, igual', (await anon.get(`/api/email/preferences/${token.slice(0, -1)}0`)).status === 404 && (await anon.get('/api/email/preferences/qualquer-coisa')).status === 404 && (await anon.get('/api/email/preferences/00000000-0000-4000-8000-000000000000_00000000000000000000000000000000')).status === 404);
  check('corpo inválido: 400', (await anon.patch(`/api/email/preferences/${token}`, { notify_orders: 'sim' })).status === 400 && (await anon.patch(`/api/email/preferences/${token}`, {})).status === 400);
  // Um código de login/senha NUNCA depende dessa preferência.
  await clearMail();
  const reg = await new Client().post('/api/account/register', { name: 'Pref Teste', email, phone: nextPhone(), password: PASS });
  check('quem desligou os avisos de pedido ainda recebe o código de confirmação da própria conta', reg.status === 202 && (await mailsTo(email)).some((m) => /confirm/i.test(m.subject)), (await mailsTo(email)).map((m) => m.subject));
  // Ligar de novo.
  const on = await anon.patch(`/api/email/preferences/${token}`, { notify_orders: true });
  check('ligar de novo pelo mesmo link', on.status === 200 && on.data.notify_orders === true);
}

// ------------------------------------------------------------------------------------------------
section('9. O painel mostra o que aconteceu com cada pedido (por pedido e por cliente), sem corpo nem segredo');
{
  const byOrder = await owner.get(`/api/admin/emails/messages?q=${flowMail}`);
  check('histórico do endereço: recebido, confirmado, saiu, entregue', byOrder.status === 200 && byOrder.data.messages.length === 4 && byOrder.data.messages.every((m) => m.category === 'transactional' && m.order_number === F.number), byOrder.data.messages?.map((m) => [m.kind, m.order_number]));
  const labels = byOrder.data.messages.map((m) => m.kind_label).sort().join('|');
  check('os nomes dos tipos estão em português', /Pedido confirmado pela loja/.test(labels) && /Pedido entregue/.test(labels) && /Pedido recebido/.test(labels) && /Pedido saiu para entrega/.test(labels), labels);
  const byKind = await owner.get('/api/admin/emails/messages?kind=order_cancelled');
  check('filtro por tipo', byKind.status === 200 && byKind.data.messages.length >= 1 && byKind.data.messages.every((m) => m.kind === 'order_cancelled'));
  const blocked = await owner.get('/api/admin/emails/messages?status=blocked');
  check('filtro por "bloqueada" mostra o motivo em português', blocked.data.messages.length >= 4 && blocked.data.messages.every((m) => m.status === 'blocked' && typeof m.block_label === 'string' && m.block_label.length > 5), blocked.data.messages?.map((m) => m.block_label));
}

// ------------------------------------------------------------------------------------------------
section('10. Falha do gatilho nunca derruba o pedido');
{
  // Uma restrição quebrada na tabela de mensagens (como se o esquema estivesse errado) não pode impedir o pedido.
  psql('alter table email_messages add constraint email_messages_quebrada check (false) not valid');
  const email = fresh('quebra');
  let r;
  try {
    r = await placeOrder({ customer_email: email });
  } finally {
    psql('alter table email_messages drop constraint email_messages_quebrada');
  }
  check('o pedido entra mesmo com o registro de e-mails quebrado', Boolean(r?.number) && orderRow(r.number).order_status === 'new', r);
  check('...e nada foi enfileirado para ele', msgs(r.number).length === 0);
}

// ------------------------------------------------------------------------------------------------
section('11. Interruptor de segurança: EMAIL_ORDER_NOTICES=off pausa SÓ os e-mails de pedido e pagamento');
{
  serve({ EMAIL_ORDER_NOTICES: 'off' });
  const o = new Client(undefined, '198.51.100.38');
  await o.login();
  await clearMail();
  const quiet = fresh('pausa');
  const P1 = await placeOrder({ customer_email: quiet });
  check('o pedido é criado normalmente', P1.status === 201 && Boolean(P1.number), P1.status);
  const held = await until(() => msgs(P1.number, 'order_received')[0]?.status === 'blocked');
  check('o aviso de pedido fica bloqueado com o motivo "pausado" e nada sai', Boolean(held) && msgs(P1.number, 'order_received')[0].block_reason === 'paused' && (await mailsTo(quiet)).length === 0, msgs(P1.number));
  const paid = await patchStatus(P1.id, 'confirmed');
  check('mudar o status do pedido também não envia nada enquanto estiver pausado', paid.status === 200 && (await until(() => msgs(P1.number, 'order_confirmed')[0]?.status === 'blocked')) && (await mailsTo(quiet)).length === 0, msgs(P1.number).map((m) => [m.kind, m.status]));
  const ov = await o.get('/api/admin/emails/overview');
  check('a visão geral avisa que os e-mails de pedido estão pausados', ov.status === 200 && ov.data.transport.order_notices_paused === true, ov.data.transport);
  const list = await o.get(`/api/admin/emails/messages?q=${P1.number}`);
  check('o histórico mostra o motivo em português', list.status === 200 && list.data.messages.some((m) => /pausados pela loja/.test(m.block_label ?? '')), list.data.messages?.map((m) => m.block_label));
  // O que NÃO é pedido segue normal: o código de confirmação da conta sai.
  await clearMail();
  const who = fresh('conta');
  const reg = await new Client().post('/api/account/register', { name: 'Conta Nova', email: who, phone: nextPhone(), password: PASS });
  check('o código de confirmação de conta continua saindo', reg.status === 202 && (await mailsTo(who)).length === 1, reg.status);

  // Desligou o interruptor: os pedidos novos voltam a avisar; o que foi bloqueado antes NÃO é reenviado.
  serve();
  const o2 = new Client(undefined, '198.51.100.39');
  await o2.login();
  await clearMail();
  const back = fresh('volta');
  const P2 = await placeOrder({ customer_email: back });
  check('sem a variável, o pedido novo volta a avisar por e-mail', (await arrive(back)).length === 1, msgs(P2.number));
  await o2.post('/api/admin/emails/process');
  check('o que foi bloqueado durante a pausa continua bloqueado (não sai atrasado)', msgs(P1.number).every((m) => m.status === 'blocked') && (await mailsTo(quiet)).length === 0, msgs(P1.number).map((m) => [m.kind, m.status]));
  const ov2 = await o2.get('/api/admin/emails/overview');
  check('e a visão geral não avisa mais de pausa', ov2.data.transport.order_notices_paused === false);
}

summary();
