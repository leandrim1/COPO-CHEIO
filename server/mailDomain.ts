// O domínio do e-mail pode receber mensagens? Camadas de proteção ANTES de gastar um e-mail de confirmação:
//
//   1. domínio reservado/de teste (example.com, .test, .invalid, localhost...);
//   2. domínio de e-mail temporário/descartável (lista em disposableDomains.ts, atualizável com
//      `npm run emails:update-blocklist`; provedores legítimos de apelido ficam em ALWAYS_ALLOWED);
//   3. DNS: tem registro MX (ou, na falta dele, A/AAAA, como manda o RFC 5321), e não é um "MX nulo"
//      (RFC 7505: domínio que declara que não recebe e-mail).
//
// Isto NÃO prova que a caixa postal existe nem que é da pessoa: só descarta o que é claramente impossível.
// Quem prova é o código/link enviado por e-mail (verification.ts). Por isso o DNS só rejeita quando a
// inexistência é CONFIRMADA (todas as consultas dizem "não existe" e o próprio DNS está funcionando, testado
// com domínios conhecidos). Falha de rede, timeout ou resposta duvidosa deixam o cadastro seguir.
import { Resolver } from 'node:dns/promises';
import { DISPOSABLE_DOMAINS_TEXT } from './disposableDomains.js';

export type DomainProblem = 'reserved' | 'disposable' | 'nxdomain' | 'no-mail' | 'null-mx';
export type DomainCheck = { ok: true; via: 'mx' | 'a' | 'unverified' } | { ok: false; reason: DomainProblem };

// Provedores legítimos que não podem ser bloqueados, mesmo que alguma lista os marque: serviços de "apelido de e-mail"
// que encaminham para uma caixa real (o código chega do mesmo jeito, então não há motivo para barrar).
const ALWAYS_ALLOWED = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'globo.com', 'globomail.com', 'ig.com.br', 'oi.com.br', 'r7.com',
  'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.com', 'zoho.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com',
  'duck.com', 'simplelogin.com', 'simplelogin.io', 'anonaddy.com', 'anonaddy.me', 'addy.io', 'privaterelay.appleid.com', 'mozmail.com',
]);

const RESERVED_DOMAINS = new Set(['example.com', 'example.net', 'example.org', 'localhost', 'localdomain']);
const RESERVED_TLDS = new Set(['example', 'invalid', 'localhost', 'local', 'localdomain', 'test', 'internal', 'lan', 'home', 'corp', 'onion', 'arpa']);

let disposable: Set<string> | null = null;
const disposableSet = () => (disposable ??= new Set(DISPOSABLE_DOMAINS_TEXT.split('\n').filter(Boolean)));

export function isReservedDomain(domain: string): boolean {
  return RESERVED_DOMAINS.has(domain) || RESERVED_TLDS.has(domain.slice(domain.lastIndexOf('.') + 1));
}

// O domínio e os "pais" dele: a.b.mailinator.com → b.mailinator.com → mailinator.com.
export function isDisposableDomain(domain: string): boolean {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    if (ALWAYS_ALLOWED.has(candidate)) return false;
    if (disposableSet().has(candidate)) return true;
  }
  return false;
}

// ---- DNS --------------------------------------------------------------------------------------------

let shared: Resolver | null = null;
const defaultResolver = () => (shared ??= new Resolver({ timeout: 2500, tries: 2 }));

type Answer<T> = { ok: true; value: T } | { ok: false; code: string };
async function ask<T>(run: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? 'UNKNOWN' };
  }
}

// O DNS desta máquina está funcionando? (se nem os domínios mais conhecidos resolvem, "não existe" não prova nada)
const CANARIES = ['gmail.com', 'google.com', 'cloudflare.com'];
let healthy: { value: boolean; until: number } | null = null;
async function dnsHealthy(resolver: Resolver): Promise<boolean> {
  if (healthy && healthy.until > Date.now()) return healthy.value;
  let value = false;
  for (const name of CANARIES) {
    const answer = await ask(() => resolver.resolve4(name));
    if (answer.ok && answer.value.length) {
      value = true;
      break;
    }
  }
  healthy = { value, until: Date.now() + 60_000 };
  return value;
}

const cache = new Map<string, { verdict: DomainCheck; until: number }>();
const POSITIVE_TTL = 10 * 60_000;
const NEGATIVE_TTL = 2 * 60_000;

export async function checkMailDomain(domain: string, resolver: Resolver = defaultResolver()): Promise<DomainCheck> {
  if (isReservedDomain(domain)) return { ok: false, reason: 'reserved' };
  if (isDisposableDomain(domain)) return { ok: false, reason: 'disposable' };

  const hit = cache.get(domain);
  if (hit && hit.until > Date.now()) return hit.verdict;
  const verdict = await dnsVerdict(domain, resolver);
  if (cache.size > 2000) cache.clear();
  cache.set(domain, { verdict, until: Date.now() + (verdict.ok ? POSITIVE_TTL : NEGATIVE_TTL) });
  return verdict;
}

async function dnsVerdict(domain: string, resolver: Resolver): Promise<DomainCheck> {
  const mx = await ask(() => resolver.resolveMx(domain));
  if (mx.ok && mx.value.length) {
    // "MX nulo" (prioridade 0 e destino vazio ou "."): o domínio avisa que não recebe e-mail.
    const real = mx.value.filter((record) => record.exchange && record.exchange !== '.');
    return real.length ? { ok: true, via: 'mx' } : { ok: false, reason: 'null-mx' };
  }

  // Sem MX, o domínio ainda recebe e-mail se tiver endereço (A/AAAA): é a regra do protocolo.
  const [a4, a6] = await Promise.all([ask(() => resolver.resolve4(domain)), ask(() => resolver.resolve6(domain))]);
  if ((a4.ok && a4.value.length) || (a6.ok && a6.value.length)) return { ok: true, via: 'a' };

  // Só rejeita quando TODAS as respostas são "não existe" / "sem dados" e o DNS está comprovadamente funcionando.
  const answers = [mx, a4, a6];
  const definitive = answers.every((answer) => answer.ok || answer.code === 'ENOTFOUND' || answer.code === 'ENODATA');
  if (!definitive || !(await dnsHealthy(resolver))) return { ok: true, via: 'unverified' };
  const gone = answers.some((answer) => !answer.ok && answer.code === 'ENOTFOUND');
  return { ok: false, reason: gone ? 'nxdomain' : 'no-mail' };
}

// Mensagens para o cliente.
export const DOMAIN_MESSAGE: Record<DomainProblem, string> = {
  disposable: 'E-mails temporários ou descartáveis não são aceitos. Use o seu e-mail de uso pessoal (Gmail, Outlook, Yahoo, etc.).',
  reserved: 'Esse domínio de e-mail não é válido. Use o seu e-mail pessoal (Gmail, Outlook, Yahoo, etc.).',
  nxdomain: 'Não encontramos esse domínio de e-mail. Confira se digitou certo (por exemplo, maria@gmail.com).',
  'no-mail': 'Esse domínio não recebe e-mails. Confira se digitou certo ou use outro endereço.',
  'null-mx': 'Esse domínio não recebe e-mails. Confira se digitou certo ou use outro endereço.',
};
