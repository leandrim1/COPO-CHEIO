// Atualiza a lista de domínios de e-mail temporário/descartável usada no cadastro (server/disposableDomains.ts).
//
//   npm run emails:update-blocklist
//
// Junta duas listas públicas mantidas pela comunidade e grava tudo num arquivo TypeScript (assim vai junto com o
// código da função na Vercel, sem depender de arquivo solto nem de rede em tempo de execução). Rode de vez em
// quando e faça commit. Domínios legítimos que apareçam por engano ficam em ALWAYS_ALLOWED (server/mailDomain.ts).
//
//  • disposable-email-domains (CC0): https://github.com/disposable-email-domains/disposable-email-domains
//  • MailChecker (MIT):              https://github.com/FGRibreau/mailchecker
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = {
  'disposable-email-domains': 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf',
  mailchecker: 'https://raw.githubusercontent.com/FGRibreau/mailchecker/master/list.txt',
};

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} respondeu ${res.status}`);
  return (await res.text())
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith('#') && DOMAIN.test(line));
}

const all = new Set();
const counts = {};
for (const [name, url] of Object.entries(SOURCES)) {
  const list = await download(url);
  counts[name] = list.length;
  for (const domain of list) all.add(domain);
}
if (all.size < 5000) throw new Error(`Só ${all.size} domínios: as listas de origem parecem incompletas; nada foi gravado.`);

const domains = [...all].sort();
const today = new Date().toISOString().slice(0, 10);
const file = `// @generated por scripts/update-disposable-domains.mjs em ${today}. Não edite à mão: rode \`npm run emails:update-blocklist\`.
// Domínios de e-mail temporário/descartável (um por linha). Fontes: ${Object.keys(SOURCES)
  .map((name) => `${name} (${counts[name]})`)
  .join(', ')}; união sem repetidos. Total: ${domains.length}.
export const DISPOSABLE_DOMAINS_UPDATED = '${today}';
export const DISPOSABLE_DOMAINS_TEXT = \`
${domains.join('\n')}
\`;
`;
writeFileSync(join(root, 'server/disposableDomains.ts'), file);
console.log(`[emails:update-blocklist] ${domains.length} domínios gravados em server/disposableDomains.ts (${Object.entries(counts).map(([n, c]) => `${n}: ${c}`).join(', ')}).`);
