// Conta do cliente (opcional): cadastro, login, "Meus pedidos" e vínculo seguro de pedidos feitos como visitante.
// Comprar e acompanhar um pedido nunca exigem conta; ela só guarda o histórico e os dados para o próximo pedido.
import { attempts, checkNewPassword, clearAttempts, decoyHash, hashPassword, readCookie, recordAttempt, sha256, verifyPassword } from '../auth.js';
import { CUSTOMER_COLUMNS, CUSTOMER_COOKIE, createCustomerSession, customerCookie, customerFromRequest, destroyCustomerSession, requireCustomer } from '../customer.js';
import { batch, one, query, updateRow } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Router } from '../http.js';
import { NOT_FOUND, normalizeToken, hashToken } from '../tracking.js';
import { digits, email, parse, text } from '../validate.js';
import type { Spec } from '../validate.js';

const WINDOW = 15 * 60;

async function limit(bucket: string, key: string, seconds: number, max: number, message: string) {
  if ((await attempts(bucket, key, seconds)) >= max) throw new HttpError(429, message);
}

const profileSpec: Spec = {
  name: text('Nome', { min: 2, max: 80, required: true }),
  phone: digits('Telefone', { min: 10, max: 13 }),
  address: text('Rua', { max: 120, nullable: true }),
  address_number: text('Número', { max: 20, nullable: true }),
  neighborhood: text('Bairro', { max: 60, nullable: true }),
  complement: text('Complemento', { max: 60, nullable: true }),
  reference: text('Ponto de referência', { max: 120, nullable: true }),
};

const orderNumber = (value: unknown): string => {
  const n = typeof value === 'string' || typeof value === 'number' ? String(value).trim().replace(/^#/, '') : '';
  if (!/^\d{1,12}$/.test(n)) throw new HttpError(400, 'Informe o número do pedido (só números, como #1001).');
  return n;
};

const ORDER_LIST = `
  select o.order_number, o.order_status, o.payment_status, o.payment_method, o.delivery_type, o.total, o.created_at, o.updated_at,
         (select string_agg(i.quantity || 'x ' || i.product_name, ', ' order by i.created_at, i.product_name)
            from order_items i where i.order_id = o.id) as summary
    from orders o`;

export function registerAccount(r: Router) {
  r.post('/api/account/register', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 8 * 1024);
    await limit('cust-register', ctx.ip, 3600, 10, 'Muitos cadastros em pouco tempo. Tente de novo mais tarde.');
    const { values } = parse({ ...profileSpec, email }, body);
    if (values.phone === undefined) throw new HttpError(400, 'Telefone: preencha este campo.');
    const passwordHash = await hashPassword(checkNewPassword(body.password));
    const customer = await one<{ id: string }>(
      `insert into customers (name, email, phone, password_hash, address, address_number, neighborhood, complement, reference)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [values.name, values.email, values.phone, passwordHash, values.address ?? null, values.address_number ?? null, values.neighborhood ?? null, values.complement ?? null, values.reference ?? null],
    );
    await recordAttempt('cust-register', ctx.ip);
    const { token, maxAge } = await createCustomerSession(customer!.id);
    const me = await one(`select ${CUSTOMER_COLUMNS} from customers c where c.id = $1`, [customer!.id]);
    return json({ customer: me }, 201, { 'set-cookie': customerCookie(ctx.req, token, maxAge) });
  });

  r.post('/api/account/login', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 4 * 1024);
    const login = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!login || !password || login.length > 254 || password.length > 200) throw new HttpError(400, 'Informe o e-mail e a senha.');
    const tooMany = 'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.';
    await limit('cust-login-email', login, WINDOW, 8, tooMany);
    await limit('cust-login-ip', ctx.ip, WINDOW, 30, tooMany);

    const row = await one<{ id: string; password_hash: string; active: boolean }>('select id, password_hash, active from customers where lower(email) = $1', [login]);
    const valid = await verifyPassword(password, row?.password_hash ?? (await decoyHash()));
    if (!row || !valid || !row.active) {
      await Promise.all([recordAttempt('cust-login-email', login), recordAttempt('cust-login-ip', ctx.ip)]);
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    await clearAttempts('cust-login-email', login);
    await query('update customers set last_login_at = now() where id = $1', [row.id]);
    const { token, maxAge } = await createCustomerSession(row.id);
    const customer = await one(`select ${CUSTOMER_COLUMNS} from customers c where c.id = $1`, [row.id]);
    return json({ customer }, 200, { 'set-cookie': customerCookie(ctx.req, token, maxAge) });
  });

  r.post('/api/account/logout', 'public', async (ctx) => {
    await destroyCustomerSession(ctx.req);
    return json({ ok: true }, 200, { 'set-cookie': customerCookie(ctx.req, '', 0) });
  });

  // Sem login responde { customer: null } (não é erro).
  r.get('/api/account/me', 'public', async (ctx) => json({ customer: await customerFromRequest(ctx.req) }));

  r.patch('/api/account', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const body = await readJson(ctx.req, 8 * 1024);
    const { values } = parse(profileSpec, body, { partial: true });
    const updated = await updateRow('customers', { column: 'id', value: customer.id }, values);
    if (!updated) throw new HttpError(404, 'Conta não encontrada.');
    return json({ customer: await customerFromRequest(ctx.req) });
  });

  r.patch('/api/account/password', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const body = await readJson(ctx.req, 4 * 1024);
    const current = typeof body.current === 'string' ? body.current : '';
    const next = checkNewPassword(body.next);
    await limit('cust-password', customer.id, WINDOW, 8, 'Muitas tentativas. Aguarde alguns minutos.');
    const row = await one<{ password_hash: string }>('select password_hash from customers where id = $1', [customer.id]);
    if (!row || !(await verifyPassword(current, row.password_hash))) {
      await recordAttempt('cust-password', customer.id);
      throw new HttpError(400, 'A senha atual está incorreta.');
    }
    await query('update customers set password_hash = $1 where id = $2', [await hashPassword(next), customer.id]);
    // Encerra as outras sessões (outros aparelhos); a atual continua.
    const token = readCookie(ctx.req, CUSTOMER_COOKIE);
    if (token) await query('delete from customer_sessions where customer_id = $1 and token_hash <> $2', [customer.id, sha256(token)]);
    return json({ ok: true });
  });

  // Excluir a conta: apaga cadastro, endereço guardado e sessões. Os pedidos ficam na loja (histórico e
  // obrigações fiscais), sem ligação com a conta, e continuam acessíveis pelo link de acompanhamento.
  r.delete('/api/account', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const body = await readJson(ctx.req, 4 * 1024);
    const password = typeof body.password === 'string' ? body.password : '';
    await limit('cust-password', customer.id, WINDOW, 8, 'Muitas tentativas. Aguarde alguns minutos.');
    const row = await one<{ password_hash: string }>('select password_hash from customers where id = $1', [customer.id]);
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      await recordAttempt('cust-password', customer.id);
      throw new HttpError(400, 'A senha está incorreta.');
    }
    await query('delete from customers where id = $1', [customer.id]);
    return json({ ok: true }, 200, { 'set-cookie': customerCookie(ctx.req, '', 0) });
  });

  // Esqueci a senha, sem e-mail: prova de posse com e-mail + telefone da conta + número e código de um pedido
  // que já está nela. Quem não tem pedido na conta pede à loja um link de redefinição (painel → Clientes).
  r.post('/api/account/recover', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 4 * 1024);
    const generic = 'Não foi possível redefinir a senha com esses dados. Confira tudo e tente de novo, ou peça um link à loja pelo WhatsApp.';
    await limit('cust-recover', ctx.ip, WINDOW, 10, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    const login = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const phone = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
    const number = orderNumber(body.order_number);
    const password = checkNewPassword(body.password);
    const canonical = normalizeToken(body.code);
    const miss = async () => {
      await recordAttempt('cust-recover', ctx.ip);
      throw new HttpError(400, generic);
    };
    if (!login || phone.length < 10 || !canonical) return miss();
    const row = await one<{ id: string }>(
      `select c.id
         from customers c
         join orders o on o.customer_id = c.id
         join order_tracking_tokens t on t.order_id = o.id
         join store_settings s on s.id = 1
        where lower(c.email) = $1 and c.active
          and phone_key(c.phone) = phone_key($2)
          and o.order_number = $3::bigint
          and t.token_hash = $4 and t.revoked_at is null
          and o.updated_at > now() - make_interval(days => s.tracking_retention_days)`,
      [login, phone, number, hashToken(canonical)],
    );
    if (!row) return miss();
    await batch([
      ['update customers set password_hash = $1 where id = $2', [await hashPassword(password), row.id]],
      ['delete from customer_sessions where customer_id = $1', [row.id]],
    ]);
    return json({ ok: true });
  });

  // Link de redefinição gerado pela loja (painel → Clientes): uso único.
  r.post('/api/account/reset', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 4 * 1024);
    await limit('cust-reset', ctx.ip, WINDOW, 10, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    const password = checkNewPassword(body.password);
    const token = typeof body.token === 'string' && body.token.length <= 100 ? body.token : '';
    const hash = sha256(token);
    const expired = 'Este link de redefinição não vale mais. Peça um novo à loja.';
    // Confere o link antes de gastar tempo calculando o hash da senha (link inválido não custa CPU).
    const valid = await one('select 1 as ok from customer_password_resets where token_hash = $1 and used_at is null and expires_at > now()', [hash]);
    if (!valid) {
      await recordAttempt('cust-reset', ctx.ip);
      throw new HttpError(400, expired);
    }
    // Uma instrução só: usa o link, troca a senha e encerra as sessões, tudo ou nada.
    const [result] = await batch([
      [
        `with used as (
           update customer_password_resets set used_at = now()
            where token_hash = $1 and used_at is null and expires_at > now()
            returning customer_id
         ), pass as (
           update customers c set password_hash = $2 from used where c.id = used.customer_id returning c.id
         ), sessions as (
           delete from customer_sessions s using used where s.customer_id = used.customer_id returning s.token_hash
         )
         select (select count(*) from used) as n`,
        [hash, await hashPassword(password)],
      ],
    ]);
    if (!result[0]?.n) {
      await recordAttempt('cust-reset', ctx.ip);
      throw new HttpError(400, expired);
    }
    return json({ ok: true });
  });

  // ---- Meus pedidos --------------------------------------------------------------------------------

  r.get('/api/account/orders', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const before = ctx.url.searchParams.get('before');
    const cursor = before !== null && /^\d{1,12}$/.test(before) ? before : null;
    const rows = await query(
      `${ORDER_LIST} where o.customer_id = $1 ${cursor ? 'and o.order_number < $2::bigint' : ''} order by o.order_number desc limit 21`,
      cursor ? [customer.id, cursor] : [customer.id],
    );
    return json({ orders: rows.slice(0, 20), has_more: rows.length > 20 });
  });

  // Vincula um pedido de visitante: exige o código de acompanhamento (que só quem fez o pedido tem).
  r.post('/api/account/orders/claim', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const body = await readJson(ctx.req, 2 * 1024);
    const number = orderNumber(body.order_number);
    await limit('cust-claim', customer.id, WINDOW, 10, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    const canonical = normalizeToken(body.code);
    if (!canonical) {
      await recordAttempt('cust-claim', customer.id);
      throw new HttpError(400, NOT_FOUND);
    }
    try {
      const row = await one<{ order: unknown }>('select claim_order($1::uuid, $2::bigint, $3) as "order"', [customer.id, number, hashToken(canonical)]);
      return json({ order: row?.order });
    } catch (error) {
      await recordAttempt('cust-claim', customer.id);
      throw error;
    }
  });

  r.get('/api/account/orders/:number', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const number = ctx.params.number;
    if (!/^\d{1,12}$/.test(number)) throw new HttpError(404, 'Pedido não encontrado.');
    const row = await one<{ order: unknown }>('select get_customer_order($1::uuid, $2::bigint) as "order"', [customer.id, number]);
    if (!row?.order) throw new HttpError(404, 'Pedido não encontrado.');
    return json({ order: row.order });
  });
}
