// Cria (ou atualiza a senha de) um administrador do painel.
//
//   npm run admin:create -- seu@email.com "Seu Nome"          (pergunta a senha, sem mostrar na tela)
//   npm run admin:create -- seu@email.com "Seu Nome" --admin  (função "admin" em vez de "owner")
//
// O primeiro administrador criado por aqui é o owner da loja (gerencia os demais pelo painel).
// Usa a DATABASE_URL da integração Neon: para rodar no seu computador, `vercel env pull .env.local`.
import { neon } from '@neondatabase/serverless';
import { randomBytes, scrypt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['.env.local', '.env']) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('Falta a variável DATABASE_URL (a integração Neon da Vercel a cadastra). Rode `vercel env pull .env.local`.');
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const role = process.argv.includes('--admin') ? 'admin' : 'owner';
const [email, name] = args;
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
  console.error('Uso: npm run admin:create -- seu@email.com "Seu Nome" [--admin]');
  process.exit(1);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Não mostra a senha enquanto digita.
    rl._writeToOutput = (text) => {
      if (text.startsWith(question)) rl.output.write(question);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const password = process.env.ADMIN_PASSWORD ?? (await ask('Senha (mínimo 8 caracteres): '));
if (password.length < 8 || password.length > 200) {
  console.error('A senha precisa ter de 8 a 200 caracteres.');
  process.exit(1);
}

// Mesmo formato de server/auth.ts: scrypt$N$r$p$salt$hash
const cost = { N: 65536, r: 8, p: 1 };
const salt = randomBytes(16);
const hash = await promisify(scrypt)(password, salt, 32, { ...cost, maxmem: 256 * cost.N * cost.r });
const passwordHash = ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64'), hash.toString('base64')].join('$');

const sql = neon(url);
try {
  const rows = await sql.query(
    `insert into admins (name, email, password_hash, role) values ($1, $2, $3, $4)
     on conflict (lower(email)) do update set name = excluded.name, password_hash = excluded.password_hash, active = true
     returning email, role`,
    [name.trim(), email.trim().toLowerCase(), passwordHash, role],
  );
  console.log(`Pronto: ${rows[0].email} (${rows[0].role}). Entre em /admin/login.`);
} catch (error) {
  console.error(`Não foi possível criar o administrador: ${error?.message ?? error}`);
  console.error('Se as tabelas ainda não existem, rode antes: npm run db:migrate');
  process.exit(1);
}
