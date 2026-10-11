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
  async login(email = 'dono@copocheio.local', password = 'senha-forte-123') {
    const r = await this.post('/api/auth/login', { email, password });
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
export async function mailsTo(email) {
  return (await fetch(`${BASE}/__mail?to=${encodeURIComponent(email.toLowerCase())}`)).json();
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
export async function mailMode(failure = null, delayMs = 0) {
  await fetch(`${BASE}/__mail/mode`, { method: 'POST', body: JSON.stringify({ failure, delayMs }) });
}

// Cadastra, confirma o e-mail com o código recebido e entra. Devolve a resposta do login.
export async function registerVerified(client, { name, email, phone, password }) {
  const reg = await client.post('/api/account/register', { name, email, phone, password });
  if (reg.status !== 202) throw new Error(`cadastro falhou: ${reg.status} ${JSON.stringify(reg.data)}`);
  const code = await lastCode(email);
  const ver = await client.post('/api/account/verify-email', { email, code });
  if (ver.status !== 200) throw new Error(`confirmação falhou: ${ver.status} ${JSON.stringify(ver.data)}`);
  const login = await client.post('/api/account/login', { email, password });
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${JSON.stringify(login.data)}`);
  return login;
}
