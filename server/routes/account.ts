// Conta do cliente (opcional): cadastro, login, "Meus pedidos" e vínculo seguro de pedidos feitos como visitante.
// Comprar e acompanhar um pedido nunca exigem conta; ela só guarda o histórico e os dados para o próximo pedido.
import { randomBytes } from 'node:crypto';
import { checkNewPassword, clearAttempts, clearAttemptsByPrefix, cookieHeader, decoyHash, hashPassword, readCookie, refund, reserve, sha256, verifyPassword } from '../auth.js';
import { CUSTOMER_COLUMNS, CUSTOMER_COOKIE, createCustomerSession, customerCookie, customerFromRequest, destroyCustomerSession, requireCustomer } from '../customer.js';
import { batch, one, query, updateRow } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Router } from '../http.js';
import { maskEmail, normalizeLoginEmail, parseEmail } from '../emailAddress.js';
import { cancelForCustomer } from '../orderCancel.js';
import { clearAutoSuppression } from '../email/ledger.js';
import { confirmPendingMarketing, setMarketingPending } from '../email/preferences.js';
import { DOMAIN_MESSAGE, checkMailDomain } from '../mailDomain.js';
import { mailConfigured } from '../mail.js';
import { CODE_TRY_BUCKET, LOGIN_CODE_MINUTES, challengeHash, checkLoginCode, clearLoginCookie, cleanCode as cleanLoginCode, expiredChallenge, resendLoginCode, startLoginChallenge } from '../loginCode.js';
import { RESET_MINUTES, RESET_RESEND_SECONDS, assertMailBudget, padResponse, resetMailUnavailable, sendPasswordChangedNotice, sendPasswordResetEmail } from '../passwordReset.js';
import { NOT_FOUND, normalizeToken, hashToken } from '../tracking.js';
import { digits, parse, text } from '../validate.js';
import type { Spec } from '../validate.js';
import {
  CODE_MINUTES,
  MAIL_IP_BUCKET,
  RESEND_SECONDS,
  checkCodeBound,
  checkLinkBound,
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

// Reserva uma tentativa de forma atômica (o contador mora no banco): tentativas simultâneas não furam o limite.
// Se o trabalho der certo e não deve contar como erro, devolva a vaga com `refund(bucket, key)`.
const limit = reserve;

// Cookie secreto de quem se cadastrou: só o navegador que fez o cadastro o tem. Ao confirmar o e-mail, se ele não bater, a senha
// escolhida no cadastro é descartada (veja a migration 0009): quem cadastra o e-mail de outra pessoa nunca fica com a conta dela.
const REGISTRATION_COOKIE = 'copocheio_cadastro';
const REGISTRATION_DAYS = 7;
const registrationCookie = (req: Request, nonce: string, maxAge = REGISTRATION_DAYS * 86400) => cookieHeader(req, REGISTRATION_COOKIE, nonce, maxAge);
const registrationHash = (req: Request): string | null => {
  const nonce = readCookie(req, REGISTRATION_COOKIE);
  return nonce && nonce.length <= 100 ? sha256(nonce) : null;
};

// Link de uso único para criar a senha, entregue a quem acabou de confirmar o e-mail por outro navegador que não o do cadastro.
async function setPasswordLink(customerId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await query('select issue_set_password_link($1::uuid, $2, 30)', [customerId, sha256(token)]);
  return token;
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
         (select string_agg(
                   i.quantity || 'x ' || i.product_name
                     || case i.ice_choice when 'normal' then ' (gelo normal)' when 'flavored' then ' (gelo de sabor)' else '' end,
                   ', ' order by i.created_at, i.product_name, i.ice_choice nulls first)
            from order_items i where i.order_id = o.id) as summary
    from orders o`;

export function registerAccount(r: Router) {
  // Cadastro: a conta nasce "pending_verification", SEM sessão. Só passa a valer depois de confirmar o e-mail
  // (código de 6 dígitos ou link que o servidor envia). A resposta é a mesma para e-mail novo, pendente ou que já
  // tem conta: quem tenta um endereço alheio não descobre se ele existe (o dono recebe um aviso por e-mail).
  r.post('/api/account/register', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 8 * 1024);
    if (!mailConfigured()) throw mailNotConfigured();
    const { values } = parse(profileSpec, body);
    if (values.phone === undefined) throw new HttpError(400, 'Telefone: preencha este campo.');
    const parsed = parseEmail(body.email);
    const password = checkNewPassword(body.password, { email: parsed.email, name: String(values.name ?? '') });

    // Camadas extras antes de gastar um e-mail: domínio temporário/inexistente. A prova de verdade vem da confirmação.
    const domain = await checkMailDomain(parsed.domain);
    if (!domain.ok) throw new HttpError(400, DOMAIN_MESSAGE[domain.reason], { code: 'invalid_email_domain', reason: domain.reason });

    // Só os cadastros que passaram nas conferências baratas (formato, senha, domínio) gastam a cota de 6 por hora; a reserva é atômica e
    // vem antes do trabalho caro (calcular o hash da senha, mandar o e-mail), então envios simultâneos não furam o limite.
    await limit('register-ip', ctx.ip, 3600, 6, 'Muitos cadastros em pouco tempo. Tente de novo mais tarde.');
    const passwordHash = await hashPassword(password);
    const nonce = randomBytes(24).toString('base64url');
    const nonceHash = sha256(nonce);

    const params = [values.name, parsed.email, values.phone, passwordHash, values.address ?? null, values.address_number ?? null, values.neighborhood ?? null, values.complement ?? null, values.reference ?? null, nonceHash];
    type Row = { id: string; email: string; name: string; email_verified_at: string | null; active: boolean };
    let existing = await one<Row>('select id, email, name, email_verified_at, active from customers where lower(email) = $1', [parsed.email]);
    let pending: { id: string; email: string } | null = null;
    if (!existing) {
      const created = await one<{ id: string; email: string }>(
        `insert into customers (name, email, phone, password_hash, address, address_number, neighborhood, complement, reference, reg_nonce_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
                reg_nonce_hash = $10, verify_by = greatest(verify_by, now() + interval '7 days')
          where id = $11 and email_verified_at is null and active
          returning id, email`,
        [...params, existing.id],
      );
    } else if (existing && existing.email_verified_at && existing.active) {
      await sendAlreadyRegisteredNotice(ctx.req, { email: existing.email, name: existing.name });
    }
    if (pending) {
      // "Quero receber promoções" (caixa desmarcada por padrão): ainda NÃO é consentimento. Quem digitou o e-mail pode não ser o dono dele;
      // só vira consentimento quando o código ou o link do e-mail de confirmação (que cita a escolha) for usado.
      await setMarketingPending(parsed.email, body.marketing_opt_in === true).catch(() => undefined);
      await sendVerificationEmail(ctx.req, ctx.ip, pending);
    }
    await clearAttempts('verify-email', parsed.email);
    // O cookie vai SEMPRE (inclusive quando o e-mail já tem conta): a resposta não pode revelar se o endereço existe.
    return json({ status: 'pending_verification', email: parsed.email, email_masked: maskEmail(parsed.email), resend_in: RESEND_SECONDS, code_minutes: CODE_MINUTES }, 202, { 'set-cookie': registrationCookie(ctx.req, nonce) });
  });

  // Confirma o e-mail com o código de 6 dígitos. Não abre sessão: depois de confirmar, a pessoa entra com a senha.
  r.post('/api/account/verify-email', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const email = normalizeLoginEmail(body.email);
    const code = cleanCode(body.code);
    if (!email) throw new HttpError(400, 'Informe o e-mail.');
    if (!code) throw new HttpError(400, 'Digite os 6 dígitos do código que enviamos por e-mail.', { code: 'invalid_code_format' });
    // Mesmo limite para endereço existente ou não: quem erra demais é barrado sem saber se o e-mail tem cadastro. A vaga é reservada
    // ANTES de conferir o código (atômico) e devolvida se o código estava certo.
    const tooMany = 'Muitas tentativas incorretas. Peça um novo código para continuar.';
    await reserve('verify-ip', ctx.ip, WINDOW, 30, tooMany, 'too_many_attempts');
    await reserve('verify-email', email, WINDOW, 5, tooMany, 'too_many_attempts');
    const checked = await checkCodeBound(email, code, registrationHash(ctx.req));
    if (checked.result === 'ok') {
      // Digitou o código que chegou nesta caixa: ela recebe e-mail, então uma devolução automática antiga não vale mais.
      await Promise.all([refund('verify-ip', ctx.ip), clearAttempts('verify-email', email), confirmPendingMarketing(email).catch(() => false), clearAutoSuppression(email).catch(() => undefined)]);
      // Confirmou de outro navegador que não o do cadastro: a senha do cadastro foi descartada e a pessoa cria uma agora.
      const setPassword = checked.bound === false && checked.customer_id ? await setPasswordLink(checked.customer_id) : null;
      return json({ ok: true, verified: true, ...(setPassword ? { set_password_token: setPassword } : {}) }, 200, { 'set-cookie': registrationCookie(ctx.req, '', 0) });
    }
    throw new HttpError(400, 'Código incorreto ou expirado. Confira os 6 dígitos ou peça um novo código.', { code: 'invalid_code' });
  });

  // Confirma pelo link do e-mail (a tela do link pede um clique antes de chamar isto, para que programas que
  // "abrem" links sozinhos não gastem o link).
  r.post('/api/account/verify-link', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const token = typeof body.token === 'string' ? body.token : '';
    await limit('verify-ip', ctx.ip, WINDOW, 30, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    const verified = await checkLinkBound(token, registrationHash(ctx.req));
    if (!verified) {
      throw new HttpError(400, 'Este link não vale mais: ele expirou, já foi usado ou foi trocado por um código mais novo. Entre na sua conta para receber um novo código.', { code: 'invalid_link' });
    }
    await refund('verify-ip', ctx.ip);
    await Promise.all([confirmPendingMarketing(verified.email.toLowerCase()).catch(() => false), clearAutoSuppression(verified.email).catch(() => undefined)]);
    // Abriu o link de outro navegador que não o do cadastro: a senha do cadastro foi descartada e a pessoa cria uma agora.
    const setPassword = verified.bound ? null : await setPasswordLink(verified.customer_id);
    return json({ ok: true, verified: true, email: verified.email, email_masked: maskEmail(verified.email), ...(setPassword ? { set_password_token: setPassword } : {}) }, 200, {
      'set-cookie': registrationCookie(ctx.req, '', 0),
    });
  });

  // Novo código. Resposta sempre igual (existindo cadastro pendente ou não); o banco aplica a espera de 60 s e os
  // limites por hora/dia, e o código anterior só deixa de valer depois que o novo e-mail sai.
  r.post('/api/account/resend-verification', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    if (!mailConfigured()) throw mailNotConfigured();
    const parsed = parseEmail(body.email);
    await limit('resend-ip', ctx.ip, 3600, 12, 'Muitos pedidos de código desta rede. Aguarde um pouco e tente de novo.');
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
    // Reservadas antes de conferir a senha (atômico). Por e-mail + rede (8 em 15 min): quem erra a senha de longe só trava a si mesmo;
    // por rede (30 em 15 min); e um teto por e-mail (100 por hora) contra ataques vindos de muitas redes.
    await limit('cust-login-pair', `${login}|${ctx.ip}`, WINDOW, 8, tooMany);
    await limit('cust-login-ip', ctx.ip, WINDOW, 30, tooMany);
    await limit('cust-login-email', login, 3600, 100, tooMany);

    const row = await one<{ id: string; email: string; password_hash: string; active: boolean; email_verified_at: string | null }>(
      'select id, email, password_hash, active, email_verified_at from customers where lower(email) = $1',
      [login],
    );
    const valid = await verifyPassword(password, row?.password_hash ?? (await decoyHash()));
    if (!row || !valid || !row.active) throw new HttpError(401, 'E-mail ou senha incorretos.');
    await Promise.all([refund('cust-login-pair', `${login}|${ctx.ip}`), refund('cust-login-ip', ctx.ip), refund('cust-login-email', login)]);

    // Senha certa, e-mail ainda não confirmado: nada de sessão. Manda um código novo (se os limites deixarem) e a tela
    // pede a confirmação. Só quem sabe a senha chega aqui.
    if (!row.email_verified_at) {
      // Quem acabou de provar que sabe a senha do cadastro é a pessoa certa: este navegador passa a ser o "dono" do cadastro, e o
      // código que chegar agora confirma com a senha que ela digitou (sem o passo extra de criar outra).
      const nonce = randomBytes(24).toString('base64url');
      await query('update customers set reg_nonce_hash = $2 where id = $1', [row.id, sha256(nonce)]);
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
      }, { 'set-cookie': registrationCookie(ctx.req, nonce) });
    }

    // Senha certa e e-mail confirmado: AINDA SEM SESSÃO. O servidor manda um código de 6 dígitos para o e-mail da conta e só abre a sessão
    // quando ele voltar certo, do mesmo navegador (POST /api/account/login/code). É assim a CADA entrada. Quem erra a senha nunca chega aqui,
    // então ninguém consegue encher a caixa de e-mail de um cliente sem saber a senha dele.
    const started = await startLoginChallenge(ctx.req, ctx.ip, row);
    return json(
      { status: 'code_required', email_masked: maskEmail(row.email), resend_in: started.resendIn, code_minutes: LOGIN_CODE_MINUTES },
      202,
      started.cookie ? { 'set-cookie': started.cookie } : {},
    );
  });

  // Segundo passo do login: o código de 6 dígitos que chegou no e-mail. Só vale vindo do navegador que digitou a senha (cookie do desafio).
  r.post('/api/account/login/code', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const code = cleanLoginCode(body.code);
    if (!code) throw new HttpError(400, 'Digite os 6 dígitos do código que enviamos por e-mail.', { code: 'invalid_code_format' });
    const nonceHash = challengeHash(ctx.req);
    if (!nonceHash) throw expiredChallenge();
    // A vaga é reservada ANTES de conferir (atômico) e devolvida se o código estava certo. Além disso o banco conta 5 erros por código.
    await reserve(CODE_TRY_BUCKET, ctx.ip, WINDOW, 30, 'Muitas tentativas incorretas. Aguarde alguns minutos e tente de novo.', 'too_many_attempts');
    const checked = await checkLoginCode(nonceHash, code);
    if (checked.result !== 'ok') {
      if (checked.result === 'locked') {
        throw new HttpError(400, 'Muitas tentativas incorretas com este código. Informe o e-mail e a senha de novo para receber um novo código.', { code: 'code_locked' }, { 'set-cookie': clearLoginCookie(ctx.req) });
      }
      throw new HttpError(400, 'Código incorreto ou expirado. Confira os 6 dígitos ou peça um novo código.', { code: 'invalid_code' });
    }
    await refund(CODE_TRY_BUCKET, ctx.ip);
    const who = await one<{ email: string }>('update customers set last_login_at = now() where id = $1 returning email', [checked.customer_id]);
    if (who) await clearAutoSuppression(who.email).catch(() => undefined);
    const { token, maxAge } = await createCustomerSession(checked.customer_id);
    const customer = await one(`select ${CUSTOMER_COLUMNS} from customers c where c.id = $1`, [checked.customer_id]);
    return json({ customer }, 200, { 'set-cookie': [clearLoginCookie(ctx.req), customerCookie(ctx.req, token, maxAge)] });
  });

  // "Reenviar código" na tela do código (mesma tentativa de login): espera de 60 s, no máximo 5 por tentativa e 10 por hora por conta.
  r.post('/api/account/login/resend', 'public', async (ctx) => {
    await readJson(ctx.req, 1024);
    const sent = await resendLoginCode(ctx.req, ctx.ip);
    return json({ ok: true, resend_in: sent.resendIn, code_minutes: LOGIN_CODE_MINUTES });
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
    const next = checkNewPassword(body.next, { email: customer.email, name: customer.name });
    await limit('cust-password', customer.id, WINDOW, 8, 'Muitas tentativas. Aguarde alguns minutos.');
    const row = await one<{ password_hash: string }>('select password_hash from customers where id = $1', [customer.id]);
    if (!row || !(await verifyPassword(current, row.password_hash))) throw new HttpError(400, 'A senha atual está incorreta.');
    await refund('cust-password', customer.id);
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
    if (!row || !(await verifyPassword(password, row.password_hash))) throw new HttpError(400, 'A senha está incorreta.');
    await refund('cust-password', customer.id);
    await query('delete from customers where id = $1', [customer.id]);
    // LGPD: o endereço também sai dos registros de e-mail (mensagens, preferências, supressão).
    await query('select email_forget($1)', [customer.email]).catch(() => undefined);
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
    await refund('cust-recover', ctx.ip);
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
      throw new HttpError(400, 'Confira o e-mail: ele precisa ter o formato nome@provedor.com, de qualquer provedor ou empresa.', { code: 'invalid_email' });
    }
    await limit('forgot-ip', ctx.ip, 3600, 10, 'Muitos pedidos de recuperação desta rede. Aguarde um pouco e tente de novo.');
    await assertMailBudget(ctx.ip);
    const account = await one<{ id: string }>('select id from customers where lower(email) = $1 and active', [email]);
    const sent = account ? await sendPasswordResetEmail(ctx.req, ctx.ip, account) : false;
    // A vaga do limite por rede só fica gasta quando um e-mail realmente saiu.
    if (!sent) await refund(MAIL_IP_BUCKET, ctx.ip);
    await padResponse(startedAt);
    return json({ ok: true, resend_in: RESET_RESEND_SECONDS, minutes: RESET_MINUTES });
  });

  // A tela do link pergunta se ele ainda vale antes de pedir a senha nova (não gasta o link). Mesma resposta para link
  // vencido, usado, trocado ou inventado.
  r.post('/api/account/reset-check', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    await limit('reset-check-ip', ctx.ip, WINDOW, 60, 'Muitas consultas. Aguarde alguns minutos e tente de novo.');
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
    if (!valid) throw invalid;
    type Done = { email: string; name: string; verified: boolean; via: 'admin' | 'email'; active: boolean; confirmed: boolean };
    const row = await one<{ r: Done | null }>('select reset_customer_password($1, $2) as r', [hash, await hashPassword(password)]);
    const done = row?.r;
    if (!done) throw invalid;
    await refund('cust-reset', ctx.ip);
    // Quem ficou bloqueado por errar a senha muitas vezes volta a poder entrar com a senha nova.
    await Promise.all([clearAttempts('cust-login-email', done.email.toLowerCase()), clearAttemptsByPrefix('cust-login-pair', `${done.email.toLowerCase()}|`)]);
    if (done.via === 'email') await clearAutoSuppression(done.email).catch(() => undefined);
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
    if (!canonical) throw new HttpError(400, NOT_FOUND);
    const row = await one<{ order: unknown }>('select claim_order($1::uuid, $2::bigint, $3) as "order"', [customer.id, number, hashToken(canonical)]);
    await refund('cust-claim', customer.id);
    return json({ order: row?.order });
  });

  r.get('/api/account/orders/:number', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const number = ctx.params.number;
    if (!/^\d{1,12}$/.test(number)) throw new HttpError(404, 'Pedido não encontrado.');
    const row = await one<{ order: unknown }>('select get_customer_order($1::uuid, $2::bigint) as "order"', [customer.id, number]);
    if (!row?.order) throw new HttpError(404, 'Pedido não encontrado.');
    return json({ order: row.order });
  });

  // Cancelamento pela conta: só o pedido da própria conta (o número sozinho nunca basta; a sessão vem do cookie). Mesmas regras do cancelamento por código.
  r.post('/api/account/orders/:number/cancel', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const number = ctx.params.number;
    if (!/^\d{1,12}$/.test(number)) throw new HttpError(404, 'Pedido não encontrado.');
    await limit('order-cancel', customer.id, 600, 12, 'Muitas tentativas de cancelamento. Aguarde alguns minutos ou fale com a loja.');
    const body = await readJson(ctx.req, 1024);
    const result = await cancelForCustomer({ hash: null, number, customerId: customer.id, actor: 'Cliente (conta)', reason: body.reason });
    if (!result) throw new HttpError(404, 'Pedido não encontrado.');
    return json({ order: result.order, already_cancelled: result.already });
  });
}
