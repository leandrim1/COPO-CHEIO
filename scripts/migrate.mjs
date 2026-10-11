// Aplica as migrations de db/migrations no Neon (copocheio-db).
//
//   npm run db:migrate
//
// Usa a DATABASE_URL que a integração Neon da Vercel já cadastra no projeto (para rodar no seu computador:
// `vercel env pull .env.local`). Cada arquivo roda numa transação; os já aplicados ficam registrados em
// schema_migrations e são pulados. Na Vercel, roda sozinho antes do build (script "vercel-build").
import { neon } from '@neondatabase/serverless';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Variáveis do .env.local (vercel env pull) quando rodando fora da Vercel.
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
  if (process.env.VERCEL) {
    console.warn('[db:migrate] DATABASE_URL não encontrada neste ambiente da Vercel: migrations NÃO aplicadas.');
    console.warn('[db:migrate] Conecte o banco copocheio-db (Neon) ao projeto e faça um novo deploy.');
    process.exit(0);
  }
  console.error('[db:migrate] Falta a variável DATABASE_URL (a integração Neon da Vercel a cadastra).');
  console.error('[db:migrate] Rode `vercel env pull .env.local` e tente de novo.');
  process.exit(1);
}

// Migrations mexem no banco de verdade. Na Vercel, só o deploy de PRODUÇÃO as aplica: um deploy de teste (preview, branch ou PR) que
// compartilhe o banco de produção poderia alterar o banco da loja ao vivo com uma migration ainda não revisada. Nos previews elas só
// são conferidas (lista o que está pendente). Quem usa um banco separado para previews liga MIGRATE_ON_PREVIEW=1 para aplicá-las.
const onVercel = Boolean(process.env.VERCEL);
const production = process.env.VERCEL_ENV === 'production';
const applyHere = !onVercel || production || process.env.MIGRATE_ON_PREVIEW === '1';

const sql = neon(url);
const BREAKPOINT = /^\s*--\s*statement-breakpoint\s*$/m;

const statementsOf = (file) =>
  readFileSync(join(root, 'db/migrations', file), 'utf8')
    .split(BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.replace(/^\s*--.*$/gm, '').trim() !== '');

await sql.query('create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())');
const applied = new Set((await sql.query('select version from schema_migrations')).map((r) => r.version));

const files = readdirSync(join(root, 'db/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (!applyHere) {
  const pending = files.map((f) => f.replace(/\.sql$/, '')).filter((version) => !applied.has(version));
  console.log(`[db:migrate] Deploy de teste na Vercel (VERCEL_ENV=${process.env.VERCEL_ENV ?? '?'}): migrations NÃO aplicadas, para não mexer no banco de produção.`);
  console.log(pending.length ? `[db:migrate] Pendentes neste banco: ${pending.join(', ')}.` : '[db:migrate] Nenhuma pendente.');
  console.log('[db:migrate] Se este deploy usa um banco só de testes, defina MIGRATE_ON_PREVIEW=1 nas variáveis do projeto (Preview).');
  process.exit(0);
}

let ran = 0;
for (const file of files) {
  const version = file.replace(/\.sql$/, '');
  if (applied.has(version)) continue;
  const statements = statementsOf(file);
  try {
    await sql.transaction([
      // Trava e registra primeiro: dois deploys ao mesmo tempo não aplicam o mesmo arquivo duas vezes.
      sql.query('select pg_advisory_xact_lock(7001)'),
      sql.query('insert into schema_migrations (version) values ($1)', [version]),
      ...statements.map((statement) => sql.query(statement)),
    ]);
  } catch (error) {
    if (error?.code === '23505') {
      console.log(`[db:migrate] ${version}: já aplicada por outro processo.`);
      continue;
    }
    console.error(`[db:migrate] Falhou em ${version}: ${error?.message ?? error}`);
    process.exit(1);
  }
  ran += 1;
  console.log(`[db:migrate] aplicada: ${version} (${statements.length} comandos)`);
}
console.log(ran ? `[db:migrate] ${ran} migration(s) aplicada(s).` : '[db:migrate] Banco já está atualizado.');
