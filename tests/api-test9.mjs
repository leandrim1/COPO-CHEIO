// WhatsApp da loja (migration 0008): preenche o número só quando está vazio; quem já tem número não é sobrescrito; o painel
// continua podendo trocar e apagar; o número chega ao site e ao rodapé dos e-mails; um link do WhatsApp serve de link de banner.
// usage: bash tests/fresh.sh && node tests/api-test9.mjs
import { execFileSync } from 'node:child_process';
import { Client, check, clearMail, mailsTo, registerVerified, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres'];
const psql = (sql, db = 'copocheio_test') => execFileSync('psql', [...P, '-d', db, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const NUMBER = '5534991283384';
const root = new URL('..', import.meta.url).pathname;

const anon = new Client();
const owner = new Client();
await owner.login();

// ------------------------------------------------------------------------------------------------
section('Banco novo: a loja já nasce com o WhatsApp');
{
  const s = (await anon.get('/api/site')).data;
  check('o site recebe o número (só dígitos, com 55)', s.store.whatsapp === NUMBER, s.store.whatsapp);
  check('formato aceito pelo banco (10 a 15 dígitos) e igual ao do link informado', /^[0-9]{10,15}$/.test(s.store.whatsapp) && 'https://api.whatsapp.com/send/?phone=5534991283384&text&type=phone_number&app_absent=0'.includes(`phone=${s.store.whatsapp}&`));
  const admin = (await owner.get('/api/admin/settings')).data;
  check('o painel (Configurações → Loja) mostra o mesmo número', admin.store.whatsapp === NUMBER, admin.store.whatsapp);
}

// ------------------------------------------------------------------------------------------------
section('Banco antigo (sem número): a migration 0008 preenche; com número, não mexe');
{
  const mk = (db) => {
    execFileSync('psql', [...P, '-q', '-v', 'ON_ERROR_STOP=1', '-c', `drop database if exists ${db} with (force)`, '-c', `create database ${db}`], QUIET);
    const files = ['0001_schema', '0002_functions', '0003_initial_content', '0004_order_tracking', '0005_email_verification', '0006_password_reset_email', '0007_banner_cover'];
    for (const f of files) execFileSync('psql', [...P, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', '-f', `${root}db/migrations/${f}.sql`], QUIET);
    execFileSync('psql', [...P, '-d', db, '-q', '-c', `create table schema_migrations (version text primary key, applied_at timestamptz not null default now()); insert into schema_migrations(version) values ${files.map((f) => `('${f}')`).join(',')}`], QUIET);
  };
  const migrate = (db) => execFileSync('node', ['tests/with-neon-proxy.mjs', 'scripts/migrate.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_PG_URL: `postgres://postgres@127.0.0.1:5433/${db}` } });

  // (a) produção antes desta mudança: número vazio
  mk('legacy08_a');
  check('antes: o número está vazio (como no Neon de hoje)', psql('select coalesce(whatsapp, \'(vazio)\') from store_settings', 'legacy08_a') === '(vazio)');
  const outA = migrate('legacy08_a');
  check('migrate.mjs aplica só a 0008', /aplicada: 0008_store_whatsapp/.test(outA) && !/aplicada: 000[1-7]/.test(outA), outA);
  check('depois: o número da loja está preenchido', psql('select whatsapp from store_settings', 'legacy08_a') === NUMBER);
  check('o resto da loja não foi tocado (nome, Instagram, entrega)', psql("select store_name || '|' || instagram || '|' || delivery_fee from store_settings", 'legacy08_a') === 'Copo Cheio|copocheiodisk|5.00');

  // (b) a loja já cadastrou outro número no painel: fica como está
  mk('legacy08_b');
  psql("update store_settings set whatsapp = '5534988887777'", 'legacy08_b');
  migrate('legacy08_b');
  check('número já cadastrado no painel NÃO é sobrescrito', psql('select whatsapp from store_settings', 'legacy08_b') === '5534988887777');

  // (c) rodar de novo não faz nada, nem desfaz uma troca feita depois
  psql("update store_settings set whatsapp = '5511999990000'", 'legacy08_a');
  const again = migrate('legacy08_a');
  check('rodar de novo não faz nada', /Banco já está atualizado/.test(again), again);
  check('e uma troca feita depois no painel continua valendo', psql('select whatsapp from store_settings', 'legacy08_a') === '5511999990000');
  psql("update store_settings set whatsapp = null", 'legacy08_a');
  migrate('legacy08_a');
  check('quem apagar o número no painel depois da migration fica sem número (ela não volta a preencher)', psql("select coalesce(whatsapp, '(vazio)') from store_settings", 'legacy08_a') === '(vazio)');
  for (const db of ['legacy08_a', 'legacy08_b']) execFileSync('psql', [...P, '-q', '-c', `drop database ${db} with (force)`], QUIET);
}

// ------------------------------------------------------------------------------------------------
section('Painel: trocar, apagar e voltar');
{
  let r = await owner.patch('/api/admin/store', { whatsapp: '(34) 98888-7777' });
  check('trocar o número pelo painel (com máscara) → só dígitos', r.status === 200 && r.data.store.whatsapp === '34988887777', r.data);
  check('o site passa a mostrar o novo número', (await anon.get('/api/site')).data.store.whatsapp === '34988887777');
  r = await owner.patch('/api/admin/store', { whatsapp: null });
  check('apagar o número pelo painel é permitido (vazio = a pessoa escolhe o contato)', r.status === 200 && r.data.store.whatsapp === null);
  check('e o site recebe vazio', (await anon.get('/api/site')).data.store.whatsapp === null);
  check('número curto → 400', (await owner.patch('/api/admin/store', { whatsapp: '123' })).status === 400);
  r = await owner.patch('/api/admin/store', { whatsapp: NUMBER });
  check('voltar ao número da loja', r.status === 200 && r.data.store.whatsapp === NUMBER);
}

// ------------------------------------------------------------------------------------------------
section('Link do WhatsApp como link de banner (capa e cardápio)');
{
  const LINK = 'https://api.whatsapp.com/send/?phone=5534991283384&text&type=phone_number&app_absent=0';
  const made = await owner.post('/api/admin/banners', { placement: 'menu', title: 'Peça agora', link: LINK });
  check('o painel aceita o link do WhatsApp no banner do cardápio', made.status === 201 && made.data.banner.link === LINK, made.data);
  const pub = (await anon.get('/api/site')).data.banners.find((b) => b.title === 'Peça agora');
  check('o site recebe o link inteiro (sem mexer em nada)', pub?.link === LINK, pub);
  check('link sem https (http://) continua recusado', (await owner.post('/api/admin/banners', { placement: 'menu', title: 'x', link: 'http://wa.me/5534991283384' })).status === 400);
  await owner.del(`/api/admin/banners/${made.data.banner.id}`);
}

// ------------------------------------------------------------------------------------------------
section('Rodapé dos e-mails traz o WhatsApp da loja');
{
  await clearMail();
  const email = 'whats.teste@exemplo.com';
  const c = new Client();
  const r = await c.post('/api/account/register', { name: 'Maria Teste', email, phone: '34999990000', password: 'senha-boa-123' });
  const list = await mailsTo(email);
  const mail = list.at(-1);
  const visible = (mail?.html ?? '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  check('cadastro enviou o e-mail de confirmação', r.status < 300 && !!mail, [r.status, list.length]);
  check('o rodapé mostra o WhatsApp formatado: (34) 99128-3384', /WhatsApp/.test(visible) && visible.includes('(34) 99128-3384'), visible.slice(-300));
  check('com link wa.me para o número da loja', (mail?.html ?? '').includes('https://wa.me/5534991283384'));
  check('e também na versão em texto simples', /WhatsApp: \(34\) 99128-3384 – https:\/\/wa\.me\/5534991283384/.test(mail?.text ?? ''), mail?.text?.slice(-300));
}

summary();
