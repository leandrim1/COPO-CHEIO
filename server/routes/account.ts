// Conta do cliente (opcional): cadastro, login, "Meus pedidos" e vínculo seguro de pedidos feitos como visitante.
// Comprar e acompanhar um pedido nunca exigem conta; ela só guarda o histórico e os dados para o próximo pedido.
import { attempts, checkNewPassword, clearAttempts, decoyHash, hashPassword, readCookie, recordAttempt, sha256, verifyPassword } from '../auth.js';
import { CUSTOMER_COLUMNS, CUSTOMER_COOKIE, createCustomerSession, customerCookie, customerFromRequest, destroyCustomerSession, requireCustomer } from '../customer.js';
import { batch, one, query, updateRow } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Router } from '../http.js';
import { maskEmail, normalizeLoginEmail, parseEmail } from '../emailAddress.js';
import { DOMAIN_MESSAGE, checkMailDomain } from '../mailDomain.js';
import { mailConfigured } from '../mail.js';
import { RESET_MINUTES, RESET_RESEND_SECONDS, assertMailBudget, padResponse, resetMailUnavailable, sendPasswordChangedNotice, sendPasswordResetEmail } from '../passwordReset.js';
import { NOT_FOUND, normalizeToken, hashToken } from '../tracking.js';
import { digits, parse, text } from '../validate.js';
import type { Spec } from '../validate.js';
import {
  CODE_MINUTES,
  RESEND_SECONDS,
  checkCode,
  checkLink,
  cleanCode,
  mailNotConfigured,
  sendAlreadyRegisteredNotice,
  sendVerificationEmail,
} from '../verification.js';

const WINDOW = 15 * 60;

// Qualquer troca de senha (logada, por pedido ou pelo link) deixa de valer os links de redefinição que ainda estavam em aberto:
// quem recuperou a conta não precisa deles, e quem tivesse acesso a eles não pode trocar a senha de novo depois.
const EXPIRE_OPEN_RESET_LINKS = `update customer_password_resets set expires_at = least(expires_at, now()) where customer_id = $1 and used_at is null and expires_at > now()`;

const RESET_LINK_INVALID = 'Este link de redefinição não vale mais: ele expirou, já foi usado ou foi trocado por um mais novo. Peça um novo link.';

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
  // Cadastro: a conta nasce "pending_verification", SEM sessão. Só passa a valer depois de confirmar o e-mail
  // (código de 6 dígitos ou link que o servidor envia). A resposta é a mesma para e-mail novo, pendente ou que já
  // tem conta: quem tenta um endereço alheio não descobre se ele existe (o dono recebe um aviso por e-mail).
  r.post('/api/account/register', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 8 * 1024);
    if (!mailConfigured()) throw mailNotConfigured();
    await limit('register-ip', ctx.ip, 3600, 6, 'Muitos cadastros em pouco tempo. Tente de novo mais tarde.');
    const { values } = parse(profileSpec, body);
    if (values.phone === undefined) throw new HttpError(400, 'Telefone: preencha este campo.');
    const parsed = parseEmail(body.email);
    const password = checkNewPassword(body.password);

    // Camadas extras antes de gastar um e-mail: domínio temporário/inexistente. A prova de verdade vem da confirmação.
    const domain = await checkMailDomain(parsed.domain);
    if (!domain.ok) throw new HttpError(400, DOMAIN_MESSAGE[domain.reason], { code: 'invalid_email_domain', reason: domain.reason });

    const passwordHash = await hashPassword(password);
    await recordAttempt('register-ip', ctx.ip);

    const params = [values.name, parsed.email, values.phone, passwordHash, values.address ?? null, values.address_number ?? null, values.neighborhood ?? null, values.complement ?? null, values.reference ?? null];
    type Row = { id: string; email: string; name: string; email_verified_at: string | null; active: boolean };
    let existing = await one<Row>('select id, email, name, email_verified_at, active from customers where lower(email) = $1', [parsed.email]);
    let pending: { id: string; email: string } | null = null;
    if (!existing) {
      const created = await one<{ id: string; email: string }>(
        `insert into customers (name, email, phone, password_hash, address, address_number, neighborhood, complement, reference)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict ((lower(email))) do nothing
         returning id, email`,
        params,
      );
      if (created) pending = created;
      else existing = await one<Row>('select id, email, name, email_verified_at, active from customers where lower(email) = $1', [parsed.email]);
    }
    if (existing && !existing.email_verified_at && existing.active) {
      // Cadastro pendente: quem provar acesso ao e-mail fica com a conta (os dados novos substituem os antigos).
      pending = await one<{ id: string; email: string }>(
        `update customers set name = $1, email = $2, phone = $3, password_hash = $4, address = $5, address_number = $6, neighborhood = $7, complement = $8, reference = $9,
                verify_by = greatest(verify_by, now() + interval '7 days')
          where id = $10 and email_verified_at is null and active
          returning id, email`,
        [...params, existing.id],
      );
    } else if (existing && existing.email_verified_at && existing.active) {
      await sendAlreadyRegisteredNotice(ctx.req, { email: existing.email, name: existing.name });
    }
    if (pending) await sendVerificationEmail(ctx.req, ctx.ip, pending);
    await clearAttempts('verify-email', parsed.email);
    return json({ status: 'pending_verification', email: parsed.email, email_masked: maskEmail(parsed.email), resend_in: RESEND_SECONDS, code_minutes: CODE_MINUTES }, 202);
  });

  // Confirma o e-mail com o código de 6 dígitos. Não abre sessão: depois de confirmar, a pessoa entra com a senha.
  r.post('/api/account/verify-email', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const email = normalizeLoginEmail(body.email);
    const code = cleanCode(body.code);
    if (!email) throw new HttpError(400, 'Informe o e-mail.');
    if (!code) throw new HttpError(400, 'Digite os 6 dígitos do código que enviamos por e-mail.', { code: 'invalid_code_format' });
    // Mesmo limite para endereço existente ou não: quem erra demais é barrado sem saber se o e-mail tem cadastro.
    if ((await attempts('verify-ip', ctx.ip, WINDOW)) >= 30 || (await attempts('verify-email', email, WINDOW)) >= 5) {
      throw new HttpError(429, 'Muitas tentativas incorretas. Peça um novo código para continuar.', { code: 'too_many_attempts' });
    }
    if ((await checkCode(email, code)) === 'ok') {
      await clearAttempts('verify-email', email);
      return json({ ok: true, verified: true });
    }
    await Promise.all([recordAttempt('verify-ip', ctx.ip), recordAttempt('verify-email', email)]);
    throw new HttpError(400, 'Código incorreto ou expirado. Confira os 6 dígitos ou peça um novo código.', { code: 'invalid_code' });
  });

  // Confirma pelo link do e-mail (a tela do link pede um clique antes de chamar isto, para que programas que
  // "abrem" links sozinhos não gastem o link).
  r.post('/api/account/verify-link', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const token = typeof body.token === 'string' ? body.token : '';
    await limit('verify-ip', ctx.ip, WINDOW, 30, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    const verified = await checkLink(token);
    if (!verified) {
      await recordAttempt('verify-ip', ctx.ip);
      throw new HttpError(400, 'Este link não vale mais: ele expirou, já foi usado ou foi trocado por um código mais novo. Entre na sua conta para receber um novo código.', { code: 'invalid_link' });
    }
    return json({ ok: true, verified: true, email: verified, email_masked: maskEmail(verified) });
  });

  // Novo código. Resposta sempre igual (existindo cadastro pendente ou não); o banco aplica a espera de 60 s e os
  // limites por hora/dia, e o código anterior só deixa de valer depois que o novo e-mail sai.
  r.post('/api/account/resend-verification', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    if (!mailConfigured()) throw mailNotConfigured();
    const parsed = parseEmail(body.email);
    await limit('resend-ip', ctx.ip, 3600, 12, 'Muitos pedidos de código desta rede. Aguarde um pouco e tente de novo.');
    await recordAttempt('resend-ip', ctx.ip);
    await clearAttempts('verify-email', parsed.email);
    const row = await one<{ id: string; email: string }>('select id, email from customers where lower(email) = $1 and email_verified_at is null and active', [parsed.email]);
    if (row) await sendVerificationEmail(ctx.req, ctx.ip, row);
    return json({ ok: true, resend_in: RESEND_SECONDS, code_minutes: CODE_MINUTES });
  });

  r.post('/api/account/login', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 4 * 1024);
    const login = normalizeLoginEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!login || !password || login.length > 254 || password.length > 200) throw new HttpError(400, 'Informe o e-mail e a senha.');
    const tooMany = 'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.';
    await limit('cust-login-email', login, WINDOW, 8, tooMany);
    await limit('cust-login-ip', ctx.ip, WINDOW, 30, tooMany);

    const row = await one<{ id: string; email: string; password_hash: string; active: boolean; email_verified_at: string | null }>(
      'select id, email, password_hash, active, email_verified_at from customers where lower(email) = $1',
      [login],
    );
    const valid = await verifyPassword(password, row?.password_hash ?? (await decoyHash()));
    if (!row || !valid || !row.active) {
      await Promise.all([recordAttempt('cust-login-email', login), recordAttempt('cust-login-ip', ctx.ip)]);
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    await clearAttempts('cust-login-email', login);

    // Senha certa, e-mail ainda não confirmado: nada de sessão. Manda um código novo (se os limites deixarem) e a tela
    // pede a confirmação. Só quem sabe a senha chega aqui.
    if (!row.email_verified_at) {
      let sent = false;
      if (mailConfigured()) {
        try {
          sent = (await sendVerificationEmail(ctx.req, ctx.ip, row)).sent;
        } catch {
          /* falha de envio não muda a resposta: a tela oferece "reenviar" */
        }
        await clearAttempts('verify-email', row.email);
      }
      throw new HttpError(403, `Falta confirmar o seu e-mail (${maskEmail(row.email)}) para entrar na conta.`, {
        code: 'email_not_verified',
        email: row.email,
        email_masked: maskEmail(row.email),
        sent,
        mail_available: mailConfigured(),
        resend_in: RESEND_SECONDS,
        code_minutes: CODE_MINUTES,
      });
    }

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
    await query(EXPIRE_OPEN_RESET_LINKS, [customer.id]);
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
    const login = normalizeLoginEmail(body.email);
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
      [EXPIRE_OPEN_RESET_LINKS, [row.id]],
    ]);
    return json({ ok: true });
  });

  // Esqueci a senha, por e-mail: manda um link de uso único (vale 60 minutos) para a caixa de e-mail da conta. A resposta é a
  // mesma exista a conta ou não (e demora o mesmo tempo), então esta tela não revela quem tem cadastro. Contas que ainda não
  // confirmaram o e-mail também recebem o link: usá-lo prova o acesso à caixa e confirma o e-mail ao mesmo tempo.
  r.post('/api/account/forgot-password', 'public', async (ctx) => {
    const startedAt = Date.now();
    const body = await readJson(ctx.req, 2 * 1024);
    if (!mailConfigured()) throw resetMailUnavailable();
    // Mais tolerante que o cadastro: contas antigas podem ter e-mails que o formato novo recusaria.
    const email = normalizeLoginEmail(body.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new HttpError(400, 'Confira o e-mail: ele precisa ter o formato nome@dominio.com (por exemplo, maria@gmail.com).', { code: 'invalid_email' });
    }
    await limit('forgot-ip', ctx.ip, 3600, 10, 'Muitos pedidos de recuperação desta rede. Aguarde um pouco e tente de novo.');
    await assertMailBudget(ctx.ip);
    await recordAttempt('forgot-ip', ctx.ip);
    const account = await one<{ id: string }>('select id from customers where lower(email) = $1 and active', [email]);
    if (account) await sendPasswordResetEmail(ctx.req, ctx.ip, account);
    await padResponse(startedAt);
    return json({ ok: true, resend_in: RESET_RESEND_SECONDS, minutes: RESET_MINUTES });
  });

  // A tela do link pergunta se ele ainda vale antes de pedir a senha nova (não gasta o link). Mesma resposta para link
  // vencido, usado, trocado ou inventado.
  r.post('/api/account/reset-check', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    await limit('reset-check-ip', ctx.ip, WINDOW, 60, 'Muitas consultas. Aguarde alguns minutos e tente de novo.');
    await recordAttempt('reset-check-ip', ctx.ip);
    const token = typeof body.token === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(body.token) ? body.token : '';
    const row = token
      ? await one<{ email: string }>(
          `select c.email from customer_password_resets r join customers c on c.id = r.customer_id
            where r.token_hash = $1 and r.used_at is null and r.expires_at > now()`,
          [sha256(token)],
        )
      : null;
    if (!row) throw new HttpError(400, RESET_LINK_INVALID, { code: 'invalid_link' });
    return json({ valid: true, email_masked: maskEmail(row.email) });
  });

  // Link de redefinição (enviado por e-mail ou gerado pela loja no painel → Clientes): uso único. Troca a senha, derruba
  // todas as sessões da conta e invalida os outros links. Link de e-mail também confirma o e-mail da conta.
  r.post('/api/account/reset', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 4 * 1024);
    await limit('cust-reset', ctx.ip, WINDOW, 10, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    const password = checkNewPassword(body.password);
    const token = typeof body.token === 'string' && body.token.length <= 100 ? body.token : '';
    const hash = sha256(token);
    const invalid = new HttpError(400, RESET_LINK_INVALID, { code: 'invalid_link' });
    // Confere o link antes de gastar tempo calculando o hash da senha (link inválido não custa CPU).
    const valid = await one('select 1 as ok from customer_password_resets where token_hash = $1 and used_at is null and expires_at > now()', [hash]);
    if (!valid) {
      await recordAttempt('cust-reset', ctx.ip);
      throw invalid;
    }
    type Done = { email: string; name: string; verified: boolean; via: 'admin' | 'email'; active: boolean; confirmed: boolean };
    const row = await one<{ r: Done | null }>('select reset_customer_password($1, $2) as r', [hash, await hashPassword(password)]);
    const done = row?.r;
    if (!done) {
      await recordAttempt('cust-reset', ctx.ip);
      throw invalid;
    }
    // Quem ficou bloqueado por errar a senha muitas vezes volta a poder entrar com a senha nova.
    await clearAttempts('cust-login-email', done.email.toLowerCase());
    if (done.via === 'email' && done.active && done.confirmed) await sendPasswordChangedNotice(ctx.req, done);
    return json({ ok: true, email: done.email, email_masked: maskEmail(done.email), verified: done.verified });
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
