export const BASE = process.env.BASE ?? 'http://127.0.0.1:4180';

export class Client {
  constructor(base = BASE, ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) {
    this.base = base;
    this.jar = new Map();
    this.ip = ip;
  }
  // Como um navegador: guarda todos os cookies (sessão, aparelho, cadastro...), um por nome. `cookie` continua sendo o texto do cabeçalho.
  get cookie() {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  set cookie(text) {
    this.jar = new Map();
    for (const part of String(text || '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name && rest.length) this.jar.set(name, rest.join('='));
    }
  }
  async req(method, path, body, { headers = {}, raw = false } = {}) {
    const h = { 'x-real-ip': this.ip, ...headers };
    if (this.cookie) h.cookie = this.cookie;
    // Pedido de bebida alcoólica exige a declaração de maioridade (migration 0027). Os testes que não tratam disso declaram por padrão, como o checkout
    // faz depois de a pessoa marcar a caixa; quem quer testar a recusa envia a chave `age_confirmed` explicitamente (mesmo com valor falso ou undefined).
    if (method === 'POST' && path === '/api/orders' && !raw && body && typeof body === 'object' && !Array.isArray(body) && !('age_confirmed' in body)) body = { ...body, age_confirmed: true };
    // Pedido com bebida alcoólica só vira "entregue" com a conferência do documento (migration 0027). Os testes que não tratam disso conferem por padrão, como o
    // painel faz depois do clique em "Conferi: 18 anos ou mais"; quem quer testar a recusa envia a chave `age_checked` explicitamente (mesmo com valor falso ou undefined).
    if (method === 'PATCH' && /^\/api\/admin\/orders\/[^/?]+$/.test(path) && !raw && body && typeof body === 'object' && !Array.isArray(body) && body.status === 'delivered' && !('age_checked' in body)) body = { ...body, age_checked: true };
    let payload;
    if (body !== undefined && !raw) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    } else if (raw) payload = body;
    // Depois que o servidor de teste é reiniciado, a primeira conexão reaproveitada pode estar morta: tenta de novo uma vez.
    let res;
    try {
      res = await fetch(this.base + path, { method, headers: h, body: payload });
    } catch (error) {
      if (!['UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code)) throw error;
      res = await fetch(this.base + path, { method, headers: h, body: payload });
    }
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (value) this.jar.set(name, value);
      else this.jar.delete(name);
      this.lastSetCookie = c;
    }
    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }
  get = (p, o) => this.req('GET', p, undefined, o);
  post = (p, b, o) => this.req('POST', p, b ?? {}, o);
  patch = (p, b, o) => this.req('PATCH', p, b, o);
  put = (p, b, o) => this.req('PUT', p, b, o);
  del = (p, b, o) => this.req('DELETE', p, b, o);
  // Login do PAINEL em dois passos (e-mail + senha → código enviado por e-mail → sessão): usa a caixa simulada do servidor de teste.
  async login(email = 'dono@copocheio.local', password = 'senha-forte-123') {
    const r = await loginAdmin(this, { email, password });
    if (r.status !== 200) throw new Error(`login falhou: ${r.status} ${JSON.stringify(r.data)}`);
    return r;
  }
}

let passed = 0;
let failed = 0;
const failures = [];
export function check(name, ok, detail) {
  if (ok) passed++;
  else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail !== undefined ? ' → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  }
}
export function section(title) {
  console.log(`\n# ${title}`);
}
export function summary() {
  console.log(`\n${failed ? 'FALHOU' : 'OK'}: ${passed} checks passaram, ${failed} falharam`);
  if (failed) console.log('Falhas:\n - ' + failures.join('\n - '));
  process.exit(failed ? 1 : 0);
}

// ---- E-mail de verificação (servidor SMTP de mentira do servidor de teste) -----------------------------
// `base`: o servidor de teste que recebeu o pedido (cada servidor tem a sua caixa simulada). Reconexão automática: depois de o servidor ser reiniciado, a
// primeira conexão reaproveitada pode estar morta.
export async function mailsTo(email, base) {
  // `.map(mailsTo)` passa o índice como 2º argumento: só vale `base` se for um endereço.
  if (typeof base !== 'string') base = BASE;
  const url = `${base}/__mail?to=${encodeURIComponent(email.toLowerCase())}`;
  try {
    return await (await fetch(url)).json();
  } catch (error) {
    if (!['UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code)) throw error;
    return (await fetch(url)).json();
  }
}
export async function clearMail() {
  await fetch(`${BASE}/__mail`, { method: 'DELETE' });
}
export const codeFrom = (message) => /\b(\d{6})\b/.exec(message?.text ?? '')?.[1];
export const linkFrom = (message) => /(https?:\/\/[^\s]+\/conta\/verificar\/[A-Za-z0-9_-]+)/.exec(message?.text ?? '')?.[1];
export async function lastCode(email) {
  const list = await mailsTo(email);
  return codeFrom(list[list.length - 1]);
}
export async function mailStats() {
  return (await fetch(`${BASE}/__mail/stats`)).json();
}
export async function mailMode(failure = null, delayMs = 0) {
  await fetch(`${BASE}/__mail/mode`, { method: 'POST', body: JSON.stringify({ failure, delayMs }) });
}

// Login do cliente em DOIS passos (e-mail + senha → código enviado por e-mail → sessão). Devolve a resposta final (a do código: 200 com
// o cliente e o cookie da sessão); se o primeiro passo falhar (senha errada, e-mail não confirmado, limite...), devolve a resposta dele, igual ao
// que o servidor respondeu. Serve para trocar, sem mudar o resto do teste, qualquer `client.post('/api/account/login', { email, password })`.
export async function loginCustomer(client, body, opts) {
  const email = String(body?.email ?? '').trim();
  const before = email ? (await mailsTo(email, client.base)).length : 0;
  const first = await client.post('/api/account/login', body, opts);
  if (first.status !== 202 || first.data?.status !== 'code_required') return first;
  let code;
  for (let i = 0; i < 50 && !code; i++) {
    const list = await mailsTo(email, client.base);
    if (list.length > before) code = codeFrom(list[list.length - 1]);
    else await new Promise((r) => setTimeout(r, 100));
  }
  // Pedido repetido logo em seguida pelo mesmo navegador: vale o código que já tinha sido enviado (nenhum e-mail novo).
  if (!code) code = codeFrom((await mailsTo(email, client.base)).at(-1));
  return client.post('/api/account/login/code', { code });
}

// Onde o teste lê o código do login do painel: por padrão, a caixa simulada do servidor de teste. Quem sobe o servidor com outro transporte (a API da Resend
// simulada, por exemplo) troca o leitor com `setAdminCodeReader(async (email, client) => código)`.
let adminCodeReader = null;
export const setAdminCodeReader = (reader) => {
  adminCodeReader = reader;
};

// Login do PAINEL em DOIS passos, como o do cliente: devolve a resposta final (a do código: 200 com o administrador e o cookie da sessão); se o primeiro passo
// falhar (senha errada, conta desativada, limite, e-mail fora do ar...), devolve a resposta dele. Para contas com o aplicativo autenticador (TOTP) a resposta final
// é { two_factor: true, challenge } (o terceiro passo é do teste). Troca, sem mudar o resto do teste, qualquer `client.post('/api/auth/login', { email, password })`.
// O e-mail do código diz de que rede veio o pedido: com vários logins da MESMA conta ao mesmo tempo (clientes com IPs diferentes), cada um acha o seu.
export async function loginAdmin(client, body, opts) {
  const email = String(body?.email ?? '').trim();
  const sinkMails = async () => {
    try {
      return (await mailsTo(email, client.base)).filter((m) => /código de acesso ao painel/.test(m.subject));
    } catch {
      return []; // servidor sem caixa simulada (sem e-mail configurado): o primeiro passo responde sozinho
    }
  };
  const before = adminCodeReader || !email ? 0 : (await sinkMails()).length;
  const first = await client.post('/api/auth/login', body, opts);
  if (first.status !== 202 || first.data?.status !== 'code_required') return first;
  let code;
  if (adminCodeReader) code = await adminCodeReader(email, client);
  else {
    for (let i = 0; i < 50 && !code; i++) {
      const fresh = (await sinkMails()).slice(before);
      if (fresh.length) code = codeFrom(fresh.find((m) => client.ip && String(m.text).includes(client.ip)) ?? fresh.at(-1));
      else await new Promise((r) => setTimeout(r, 100));
    }
    // Pedido repetido logo em seguida pelo mesmo navegador: vale o código que já tinha sido enviado (nenhum e-mail novo).
    if (!code) code = codeFrom((await sinkMails()).at(-1));
  }
  return client.post('/api/auth/login/code', { code });
}

// Cadastra, confirma o e-mail com o código recebido e entra. Devolve a resposta do login.
export async function registerVerified(client, { name, email, phone, password }) {
  const reg = await client.post('/api/account/register', { name, email, phone, password });
  if (reg.status !== 202) throw new Error(`cadastro falhou: ${reg.status} ${JSON.stringify(reg.data)}`);
  const code = await lastCode(email);
  const ver = await client.post('/api/account/verify-email', { email, code });
  if (ver.status !== 200) throw new Error(`confirmação falhou: ${ver.status} ${JSON.stringify(ver.data)}`);
  const login = await loginCustomer(client, { email, password });
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${JSON.stringify(login.data)}`);
  return login;
}
