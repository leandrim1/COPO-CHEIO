// Banner da capa da página Bebidas (banners.placement 'cover' | 'menu'): migration (inclusive sobre um banco que já tinha
// banners), validação, ordem própria de cada lugar, troca de lugar, API pública separada (banners × cover_banners),
// Blob liberado ao trocar/excluir imagem e acesso restrito ao painel.
// usage: bash tests/fresh.sh && node tests/api-test8.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client, check, section, summary } from './lib.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const BLOB = process.env.BLOB_BASE ?? 'http://127.0.0.1:4181';
const blobFiles = async () => (await (await fetch(`${BLOB}/__files`)).json()).sort();
const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const psql = (sql, db = 'copocheio_test') => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', db, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();

const anon = new Client();
const owner = new Client();
await owner.login();

const upload = async (name = 'a.webp') => {
  const r = await owner.post('/api/admin/upload?folder=banners', fx(name), { raw: true, headers: { 'content-type': 'image/webp' } });
  if (r.status !== 201) throw new Error(`upload falhou: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
const site = async () => (await anon.get('/api/site')).data;
const adminList = async () => (await owner.get('/api/admin/banners')).data.banners;

// ------------------------------------------------------------------------------------------------
section('Estrutura no banco (migration 0007)');
{
  check('coluna placement existe, com padrão menu', psql("select column_default from information_schema.columns where table_name='banners' and column_name='placement'").includes("'menu'"));
  check('regra do lugar e regra da imagem da capa existem', psql("select string_agg(conname, ',' order by conname) from pg_constraint where conrelid='banners'::regclass and conname in ('banners_placement_valid','banners_cover_needs_image')") === 'banners_cover_needs_image,banners_placement_valid');
  check('índice por lugar e posição existe, o antigo saiu', psql("select string_agg(indexname, ',' order by indexname) from pg_indexes where tablename='banners' and indexname like 'banners_%idx'") === 'banners_placement_position_idx');
  check('banco novo: nenhum banner inventado', Number(psql('select count(*) from banners')) === 0);
  check('site novo: banners e cover_banners vazios', JSON.stringify([(await site()).banners, (await site()).cover_banners]) === '[[],[]]');
}

// ------------------------------------------------------------------------------------------------
section('Banco que já tinha banners: tudo continua no cardápio');
{
  const legacy = 'legacy07_api';
  const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres'];
  const run = (db, args) => execFileSync('psql', [...P, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', ...args], QUIET);
  run('postgres', ['-c', `drop database if exists ${legacy} with (force)`, '-c', `create database ${legacy}`]);
  const files = ['0001_schema', '0002_functions', '0003_initial_content', '0004_order_tracking', '0005_email_verification', '0006_password_reset_email'];
  for (const f of files) run(legacy, ['-f', new URL(`../db/migrations/${f}.sql`, import.meta.url).pathname]);
  run(legacy, ['-c', `create table schema_migrations (version text primary key, applied_at timestamptz not null default now()); insert into schema_migrations(version) values ${files.map((f) => `('${f}')`).join(',')}`]);
  run(legacy, [
    '-c',
    "insert into banners (title, subtitle, image_desktop_url, link, active, position) values ('A','sub','https://x.example/a.webp','/bebidas',true,0),('B',null,null,null,true,1),('C',null,'https://x.example/c.webp',null,false,2)",
  ]);
  const out = execFileSync('node', ['tests/with-neon-proxy.mjs', 'scripts/migrate.mjs'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: { ...process.env, TEST_PG_URL: `postgres://postgres@127.0.0.1:5433/${legacy}` } });
  check('migrate.mjs aplica só a 0007 sobre o banco antigo', /aplicada: 0007_banner_cover/.test(out) && !/aplicada: 000[1-6]/.test(out), out);
  check('banners antigos viram menu, na mesma ordem e com o mesmo estado', psql("select string_agg(title || ':' || placement || ':' || position || ':' || active, ',' order by position) from banners", legacy) === 'A:menu:0:true,B:menu:1:true,C:menu:2:false');
  const again = execFileSync('node', ['tests/with-neon-proxy.mjs', 'scripts/migrate.mjs'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: { ...process.env, TEST_PG_URL: `postgres://postgres@127.0.0.1:5433/${legacy}` } });
  check('rodar de novo não faz nada', /Banco já está atualizado/.test(again), again);
  run('postgres', ['-c', `drop database ${legacy} with (force)`]);
}

// ------------------------------------------------------------------------------------------------
section('Painel exige login para banners (capa incluída)');
{
  const body = { placement: 'cover', title: 'x', image_desktop_url: 'https://teststore.public.blob.vercel-storage.com/banners/x.webp' };
  check('POST sem login → 401', (await anon.post('/api/admin/banners', body)).status === 401);
  check('PATCH sem login → 401', (await anon.patch('/api/admin/banners/00000000-0000-0000-0000-000000000000', { placement: 'cover' })).status === 401);
  check('PUT ordem sem login → 401', (await anon.put('/api/admin/banners/order', { ids: [] })).status === 401);
  check('DELETE sem login → 401', (await anon.del('/api/admin/banners/00000000-0000-0000-0000-000000000000')).status === 401);
  check('GET sem login → 401', (await anon.get('/api/admin/banners')).status === 401);
}

// ------------------------------------------------------------------------------------------------
section('Criar banners: lugar, imagem obrigatória na capa e validação');
let cover1, cover2, menu1, menu2;
{
  const u1 = await upload('a.webp');
  const u2 = await upload('b.webp');
  const u3 = await upload('a.png');

  // padrão: sem "placement" = cardápio (o painel antigo e os testes antigos continuam valendo)
  menu1 = (await owner.post('/api/admin/banners', { title: 'Promo do cardápio', subtitle: 'Cerveja', link: '/bebidas', button_text: 'Ver', image_desktop_url: u3.url })).data.banner;
  check('sem placement → menu', menu1?.placement === 'menu' && menu1.position === 0, menu1);
  menu2 = (await owner.post('/api/admin/banners', { placement: 'menu', title: 'Segundo do cardápio' })).data.banner;
  check('segundo do cardápio → posição 1', menu2?.position === 1, menu2);

  const c1 = await owner.post('/api/admin/banners', { placement: 'cover', title: 'Cerveja gelada em dobro', image_desktop_url: u1.url, image_mobile_url: u2.url, link: '/bebidas' });
  cover1 = c1.data.banner;
  check('banner de capa criado (201)', c1.status === 201 && cover1.placement === 'cover', c1.data);
  check('a capa tem ordem própria (começa em 0, mesmo com 2 no cardápio)', cover1.position === 0, cover1);
  const c2 = await owner.post('/api/admin/banners', { placement: 'cover', image_mobile_url: u3.url });
  cover2 = c2.data.banner;
  check('capa só com imagem de celular e sem título é válida', c2.status === 201 && cover2.title === null && cover2.position === 1, c2.data);

  const noImage = await owner.post('/api/admin/banners', { placement: 'cover', title: 'Só texto' });
  check('capa sem imagem → 400 com mensagem clara', noImage.status === 400 && noImage.data.error === 'O banner da capa precisa de uma imagem.', noImage.data);
  const nothing = await owner.post('/api/admin/banners', { placement: 'cover' });
  check('capa sem nada → 400', nothing.status === 400 && /imagem/.test(nothing.data.error), nothing.data);
  const empty = await owner.post('/api/admin/banners', { subtitle: 'só subtítulo' });
  check('cardápio sem imagem nem título → 400 com mensagem clara', empty.status === 400 && /pelo menos uma imagem ou um título/.test(empty.data.error), empty.data);
  for (const placement of ['lateral', '', null, 1, 'COVER', 'cover ']) {
    const r = await owner.post('/api/admin/banners', { placement, title: 'x' });
    check(`placement ${JSON.stringify(placement)} → 400`, r.status === 400 && /Onde aparece/.test(r.data.error), r.data);
  }
  check('link javascript: na capa → 400', (await owner.post('/api/admin/banners', { placement: 'cover', image_desktop_url: u1.url, link: 'javascript:alert(1)' })).status === 400);
  check('link // na capa → 400', (await owner.post('/api/admin/banners', { placement: 'cover', image_desktop_url: u1.url, link: '//evil.com' })).status === 400);
  check('imagem http (sem s) na capa → 400', (await owner.post('/api/admin/banners', { placement: 'cover', image_desktop_url: 'http://x.example/a.webp' })).status === 400);
  check('título de 61 caracteres → 400', (await owner.post('/api/admin/banners', { placement: 'cover', image_desktop_url: u1.url, title: 'a'.repeat(61) })).status === 400);
  check('nenhum dos pedidos inválidos criou banner', (await adminList()).length === 4, (await adminList()).length);

  // o banco recusa mesmo que alguém fale direto com ele
  let refused = '';
  try {
    psql("insert into banners (placement, title) values ('cover', 'sem imagem')");
  } catch (e) {
    refused = String(e.stderr ?? e.message);
  }
  check('banco recusa capa sem imagem (banners_cover_needs_image)', /banners_cover_needs_image/.test(refused), refused.slice(0, 200));
  refused = '';
  try {
    psql("insert into banners (placement, title) values ('rodape', 'x')");
  } catch (e) {
    refused = String(e.stderr ?? e.message);
  }
  check('banco recusa lugar desconhecido (banners_placement_valid)', /banners_placement_valid/.test(refused), refused.slice(0, 200));
}

// ------------------------------------------------------------------------------------------------
section('API pública: banners (cardápio) e cover_banners (capa) separados');
{
  const s = await site();
  check('banners = só os do cardápio', s.banners.length === 2 && s.banners.every((b) => b.placement === 'menu'), s.banners);
  check('cover_banners = só os da capa, na ordem', s.cover_banners.length === 2 && s.cover_banners.map((b) => b.id).join() === [cover1.id, cover2.id].join(), s.cover_banners);
  check('capa pública traz só o que a tela usa', JSON.stringify(Object.keys(s.cover_banners[0]).sort()) === JSON.stringify(['active', 'id', 'image_desktop_url', 'image_mobile_url', 'link', 'placement', 'position', 'title']), Object.keys(s.cover_banners[0]));
  check('cardápio público mantém os campos de sempre', ['subtitle', 'button_text', 'link', 'image_desktop_url'].every((k) => k in s.banners[0]));
  check('nada de datas nem campos internos na capa', !('created_at' in s.cover_banners[0]) && !('updated_at' in s.cover_banners[0]));
  check('imagem da capa é a URL do Blob', s.cover_banners[0].image_desktop_url === cover1.image_desktop_url && s.cover_banners[0].image_mobile_url === cover1.image_mobile_url);
  check('o painel vê os 4 (dos dois lugares)', (await adminList()).length === 4);

  // capa inativa não vai para o site
  await owner.patch(`/api/admin/banners/${cover2.id}`, { active: false });
  check('capa inativa some de cover_banners', (await site()).cover_banners.map((b) => b.id).join() === cover1.id);
  check('capa inativa continua no painel', (await adminList()).some((b) => b.id === cover2.id && b.active === false));
  await owner.patch(`/api/admin/banners/${cover2.id}`, { active: true });
  check('reativada, volta', (await site()).cover_banners.length === 2);
}

// ------------------------------------------------------------------------------------------------
section('Ordem dentro de cada lugar');
{
  const r = await owner.put('/api/admin/banners/order', { ids: [cover2.id, cover1.id] });
  check('reordenar só a capa → 200', r.status === 200);
  const s = await site();
  check('capa na nova ordem', s.cover_banners.map((b) => b.id).join() === [cover2.id, cover1.id].join(), s.cover_banners.map((b) => b.id));
  check('cardápio não mexeu', s.banners.map((b) => b.id).join() === [menu1.id, menu2.id].join());
  await owner.put('/api/admin/banners/order', { ids: [menu2.id, menu1.id] });
  const s2 = await site();
  check('reordenar só o cardápio não mexe na capa', s2.banners.map((b) => b.id).join() === [menu2.id, menu1.id].join() && s2.cover_banners.map((b) => b.id).join() === [cover2.id, cover1.id].join());
  check('ids inválidos na ordem → 400', (await owner.put('/api/admin/banners/order', { ids: [1] })).status === 400);
}

// ------------------------------------------------------------------------------------------------
section('Trocar um banner de lugar');
{
  // cardápio → capa: vai para o fim da fila da capa
  let r = await owner.patch(`/api/admin/banners/${menu1.id}`, { placement: 'cover' });
  check('menu com imagem → capa (200), no fim da fila', r.status === 200 && r.data.banner.placement === 'cover' && r.data.banner.position === 2, r.data);
  let s = await site();
  check('aparece em cover_banners e sai de banners', s.cover_banners.at(-1).id === menu1.id && !s.banners.some((b) => b.id === menu1.id), s.cover_banners.map((b) => b.id));

  // cardápio sem imagem → capa: recusa e não muda nada
  r = await owner.patch(`/api/admin/banners/${menu2.id}`, { placement: 'cover' });
  check('menu sem imagem → capa recusado (400) com mensagem clara', r.status === 400 && r.data.error === 'O banner da capa precisa de uma imagem.', r.data);
  check('o banner continua no cardápio', (await adminList()).find((b) => b.id === menu2.id).placement === 'menu');

  // capa → cardápio: fim da fila do cardápio
  r = await owner.patch(`/api/admin/banners/${menu1.id}`, { placement: 'menu' });
  check('capa → cardápio (200), no fim da fila', r.status === 200 && r.data.banner.placement === 'menu' && r.data.banner.position === 1, r.data);

  // tirar a imagem de uma capa é recusado; trocar por outra, não
  r = await owner.patch(`/api/admin/banners/${cover2.id}`, { image_mobile_url: null });
  check('tirar a única imagem da capa → 400', r.status === 400 && /imagem/.test(r.data.error), r.data);
  const unchanged = (await adminList()).find((b) => b.id === cover2.id);
  check('a capa ficou como estava', unchanged.image_mobile_url === cover2.image_mobile_url);
  const u = await upload('b.webp');
  r = await owner.patch(`/api/admin/banners/${cover2.id}`, { image_mobile_url: u.url });
  check('trocar a imagem da capa → 200', r.status === 200 && r.data.banner.image_mobile_url === u.url, r.data);

  // PATCH sem placement não muda o lugar (painel antigo, ativar/desativar)
  r = await owner.patch(`/api/admin/banners/${cover1.id}`, { active: false });
  check('PATCH sem placement mantém o lugar', r.data.banner.placement === 'cover' && r.data.banner.position === (await adminList()).find((b) => b.id === cover1.id).position);
  await owner.patch(`/api/admin/banners/${cover1.id}`, { active: true });

  // posição explícita é respeitada
  r = await owner.patch(`/api/admin/banners/${menu1.id}`, { placement: 'cover', position: 0 });
  check('placement + position explícita → respeita a posição', r.data.banner.placement === 'cover' && r.data.banner.position === 0, r.data);
  await owner.patch(`/api/admin/banners/${menu1.id}`, { placement: 'menu', position: 5 });
  check('placement inválido no PATCH → 400', (await owner.patch(`/api/admin/banners/${cover1.id}`, { placement: 'nada' })).status === 400);
  check('banner inexistente → 404', (await owner.patch('/api/admin/banners/00000000-0000-0000-0000-000000000000', { placement: 'cover' })).status === 404);
  check('id que não é uuid → 404', (await owner.patch('/api/admin/banners/xyz', { placement: 'cover' })).status === 404);
  s = await site();
  check('estado final consistente (2 na capa, 2 no cardápio)', s.cover_banners.length === 2 && s.banners.length === 2, [s.cover_banners.length, s.banners.length]);
}

// ------------------------------------------------------------------------------------------------
section('Imagens no Blob: trocar e excluir liberam o arquivo');
{
  const a = await upload('a.webp');
  const b = await upload('b.webp');
  const made = (await owner.post('/api/admin/banners', { placement: 'cover', image_desktop_url: a.url, title: 'blob' })).data.banner;
  let files = await blobFiles();
  check('imagem da capa está no Blob', files.includes(a.pathname), files);
  await owner.patch(`/api/admin/banners/${made.id}`, { image_desktop_url: b.url });
  files = await blobFiles();
  check('trocar a imagem da capa apaga a antiga do Blob', !files.includes(a.pathname) && files.includes(b.pathname), files);
  const refused = await owner.patch(`/api/admin/banners/${made.id}`, { placement: 'cover', image_desktop_url: null, image_mobile_url: null });
  files = await blobFiles();
  check('tentativa recusada não apaga a imagem que está em uso', refused.status === 400 && files.includes(b.pathname), [refused.status, files]);
  await owner.del(`/api/admin/banners/${made.id}`);
  files = await blobFiles();
  check('excluir a capa apaga a imagem do Blob', !files.includes(b.pathname), files);
  check('excluir de novo → 404', (await owner.del(`/api/admin/banners/${made.id}`)).status === 404);
}

// ------------------------------------------------------------------------------------------------
section('Cache e resposta pública');
{
  const r = await anon.get('/api/site');
  check('/api/site: cache curto na borda (s-maxage) e nada guardado no navegador (max-age=0)', /s-maxage=\d+/.test(r.headers.get('cache-control') ?? '') && /max-age=0/.test(r.headers.get('cache-control') ?? ''), r.headers.get('cache-control'));
  check('nenhum segredo na resposta pública', !/password|token|secret|hash/i.test(JSON.stringify(r.data)));
}

summary();
