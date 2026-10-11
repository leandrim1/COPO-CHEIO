// Cria (ou atualiza a senha de) um administrador do painel.
//
//   npm run admin:create -- seu@email.com "Seu Nome"          (pergunta a senha, sem mostrar na tela)
//   npm run admin:create -- seu@email.com "Seu Nome" --admin  (função "admin" em vez de "owner")
//   npm run admin:create -- seu@email.com "Seu Nome" --reset-2fa  (também desliga a verificação em duas etapas dessa conta)
//
// A senha segue a mesma regra do painel (mínimo de 10 caracteres, sem senhas comuns, sequências nem o próprio e-mail).
// O primeiro administrador criado por aqui é o owner da loja (gerencia os demais pelo painel).
// Se o e-mail já existe, a senha é trocada e TODAS as sessões abertas dessa conta são encerradas (quem estava logado com a senha
// antiga, inclusive um invasor, perde o acesso na hora).
// Usa a DATABASE_URL da integração Neon: para rodar no seu computador, `vercel env pull .env.local`.
import { neon } from '@neondatabase/serverless';
import { randomBytes, scrypt } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const reset2fa = process.argv.includes('--reset-2fa');
const [email, name] = args;
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
  console.error('Uso: npm run admin:create -- seu@email.com "Seu Nome" [--admin] [--reset-2fa]');
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

// A regra de senha do painel (server/passwordPolicy.ts) é TypeScript: aqui ela é convertida na hora com o TypeScript do próprio
// projeto, para o script e o painel nunca discordarem. Se isso não for possível (instalação sem as dependências de desenvolvimento),
// vale só o tamanho mínimo, e o painel continua aplicando a regra completa quando a senha for trocada lá.
async function loadPasswordPolicy() {
  let dir;
  try {
    const ts = (await import('typescript')).default;
    dir = mkdtempSync(join(tmpdir(), 'copocheio-policy-'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const file of ['passwordPolicy', 'commonPasswords']) {
      const { outputText } = ts.transpileModule(readFileSync(join(root, 'server', `${file}.ts`), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      writeFileSync(join(dir, `${file}.js`), outputText);
    }
    return (await import(pathToFileURL(join(dir, 'passwordPolicy.js')).href)).passwordProblem;
  } catch {
    return null;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const password = process.env.ADMIN_PASSWORD ?? (await ask('Senha (mínimo 10 caracteres): '));
if (password.length < 10 || password.length > 200) {
  console.error('A senha precisa ter de 10 a 200 caracteres.');
  process.exit(1);
}
const policy = await loadPasswordPolicy();
if (!policy) console.warn('Aviso: não foi possível conferir a lista de senhas comuns neste computador (rode `npm install`); só o tamanho foi conferido.');
const problem = policy?.(password, { kind: 'admin', email: email.trim(), name: name.trim() });
if (problem) {
  console.error(problem);
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
     returning id, email, role, (xmax <> 0) as updated`,
    [name.trim(), email.trim().toLowerCase(), passwordHash, role],
  );
  let closed = 0;
  if (rows[0].updated) {
    // Senha trocada: as sessões abertas com a senha antiga não podem continuar valendo.
    closed = (await sql.query('delete from admin_sessions where admin_id = $1 returning token_hash', [rows[0].id])).length;
    await sql.query('delete from admin_login_challenges where admin_id = $1', [rows[0].id]);
  }
  if (reset2fa) {
    await sql.query('update admins set totp_secret = null, totp_enabled_at = null, totp_last_step = null where id = $1', [rows[0].id]);
    await sql.query('delete from admin_recovery_codes where admin_id = $1', [rows[0].id]);
    await sql.query('delete from admin_sessions where admin_id = $1', [rows[0].id]);
    console.log('A verificação em duas etapas dessa conta foi desligada.');
  }
  console.log(`Pronto: ${rows[0].email} (${rows[0].role}). Entre em /admin/login.${rows[0].updated ? ` ${closed} sessão(ões) aberta(s) foram encerradas.` : ''}`);
  if (!reset2fa) console.log('Depois de entrar, ligue a verificação em duas etapas em Configurações → Painel.');
} catch (error) {
  console.error(`Não foi possível criar o administrador: ${error?.message ?? error}`);
  console.error('Se as tabelas ainda não existem, rode antes: npm run db:migrate');
  process.exit(1);
}
