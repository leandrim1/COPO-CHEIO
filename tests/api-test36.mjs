// Site público: buscadores, instalação (PWA), medição de visitas e a página "Contato e responsável".
//  • /robots.txt e /sitemap.xml saem do servidor, com o endereço completo do site; o sitemap só lista páginas públicas e estáveis, nunca pedido, conta, checkout, pagamento ou painel;
//  • as páginas de termos e políticas existem para os robôs (título, canônica, 200) e as pessoais continuam com noindex;
//  • GA_MEASUREMENT_ID chega ao site por /api/site só no formato G-XXXXXXXX (valor estranho vira nulo) e nunca vem de outro lugar;
//  • manifesto e service worker são servidos como arquivos estáticos corretos; o service worker não toca em /api nem em páginas pessoais;
//  • a quinta página de políticas (contato e responsável) segue as mesmas regras de edição e revisão das outras quatro.
// usage: bash tests/fresh.sh && node tests/api-test36.mjs   (reinicia o servidor de teste algumas vezes e, no fim, volta ao normal)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BASE, Client, check, section, summary } from './lib.mjs';

const root = new URL('..', import.meta.url).pathname;
const serve = (env = {}) => execSync(`bash ${process.env.SERVE_SCRIPT ?? `${root}tests/serve.sh`}`, { env: { ...process.env, ...env }, stdio: 'ignore' });
const text = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, headers: res.headers, body: await res.text() };
};

const anon = new Client(undefined, '198.51.100.120');
const owner = new Client(undefined, '198.51.100.121');
await owner.login();

// ------------------------------------------------------------------------------------------------
section('1. robots.txt: bloqueios de sempre + endereço do mapa do site');
{
  const r = await text('/robots.txt');
  check('responde 200 em texto puro', r.status === 200 && /text\/plain/.test(r.headers.get('content-type')), [r.status, r.headers.get('content-type')]);
  check('mantém os bloqueios (/api/, /pedido/, /pagar/, /acompanhar-pedido/, /conta)', ['/api/', '/pedido/', '/pagar/', '/acompanhar-pedido/', '/conta'].every((p) => r.body.includes(`Disallow: ${p}`)), r.body);
  check('não anuncia o painel', !/admin/i.test(r.body));
  check('anuncia o sitemap com endereço completo', r.body.includes(`Sitemap: ${BASE}/sitemap.xml`), r.body);
}

// ------------------------------------------------------------------------------------------------
section('2. sitemap.xml: só páginas públicas e estáveis');
{
  const r = await text('/sitemap.xml');
  check('responde 200 em XML', r.status === 200 && /application\/xml/.test(r.headers.get('content-type')) && r.body.startsWith('<?xml'), [r.status, r.headers.get('content-type')]);
  const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const wanted = ['/', '/bebidas', '/privacidade', '/termos', '/trocas-e-cancelamentos', '/entrega', '/pagamento-e-reembolso', '/contato-e-responsavel'];
  check('lista as 8 páginas públicas, com endereço completo', locs.length === wanted.length && wanted.every((p) => locs.includes(p === '/' ? `${BASE}/` : `${BASE}${p}`)), locs);
  check('nada de checkout, pedido, acompanhamento, conta, pagamento, painel nem API', !locs.some((l) => /\/(checkout|pedido|acompanhar-pedido|conta\b|pagar|admin|api)/.test(l.replace(BASE, ''))), locs);
  check('o cache é público e curto o bastante para refletir mudança de endereço', /s-maxage=3600/.test(r.headers.get('cache-control')));
  const post = await fetch(`${BASE}/sitemap.xml`, { method: 'POST' });
  check('só leitura: POST não é aceito', post.status >= 400, post.status);
}

// ------------------------------------------------------------------------------------------------
section('3. Páginas de políticas para os robôs; páginas pessoais seguem fora do Google');
{
  for (const [path, title] of [['/termos', 'Termos de uso'], ['/trocas-e-cancelamentos', 'Cancelamento e trocas'], ['/entrega', 'Entrega e retirada'], ['/pagamento-e-reembolso', 'Pagamento e reembolso'], ['/contato-e-responsavel', 'Contato e responsável'], ['/privacidade', 'Política de privacidade']]) {
    const r = await text(`/api/__page?__from=${encodeURIComponent(path)}`);
    check(`${path}: 200, título e canônica próprios, sem noindex`, r.status === 200 && r.body.includes(`<title>${title}`) && r.body.includes(`<link rel="canonical" href="${BASE}${path}" />`) && !/noindex/.test(r.body) && !/noindex/.test(r.headers.get('x-robots-tag') ?? ''), [r.status, r.body.match(/<title>[^<]*/)?.[0]]);
  }
  for (const path of ['/checkout', '/pedido/ABCDEFGH12345678', '/conta', '/acompanhar-pedido']) {
    const r = await text(`/api/__page?__from=${encodeURIComponent(path)}`);
    check(`${path}: noindex e sem cache`, r.status === 200 && /noindex/.test(r.headers.get('x-robots-tag') ?? '') && /no-store/.test(r.headers.get('cache-control')), r.status);
  }
  const missing = await text('/api/__page?__from=%2Ftermos-inexistente');
  check('endereço que não existe: 404 de verdade', missing.status === 404);
}

// ------------------------------------------------------------------------------------------------
section('4. Medição de visitas: o identificador só chega ao site se estiver no formato do GA4');
{
  const base = (await anon.get('/api/site')).data;
  check('sem GA_MEASUREMENT_ID: analytics_id é nulo (nada é medido)', base.analytics_id === null, base.analytics_id);
  serve({ GA_MEASUREMENT_ID: 'G-TEST1234' });
  const on = (await anon.get('/api/site')).data;
  check('com um identificador válido ele vai ao site (não é segredo)', on.analytics_id === 'G-TEST1234', on.analytics_id);
  for (const bad of ['UA-12345-1', 'g-test1234', 'G-<script>', 'G-', 'https://evil.example/x.js', 'G-TEST1234;alert(1)']) {
    serve({ GA_MEASUREMENT_ID: bad });
    const r = (await anon.get('/api/site')).data;
    check(`valor fora do formato (${bad}) é ignorado`, r.analytics_id === null, r.analytics_id);
  }
  serve({});
  check('voltou ao normal', (await anon.get('/api/site')).data.analytics_id === null);
  const db = (await owner.get('/api/admin/store')).data;
  check('o painel não guarda nem devolve o identificador (vem só da variável de ambiente)', !JSON.stringify(db).includes('G-TEST1234'));
}

// ------------------------------------------------------------------------------------------------
section('5. Instalação (PWA): manifesto e service worker');
{
  const m = await text('/manifest.webmanifest');
  let manifest = null;
  try {
    manifest = JSON.parse(m.body);
  } catch {
    /* abaixo */
  }
  check('o manifesto é JSON válido, com nome, início, modo app e cores', m.status === 200 && manifest?.name && manifest.start_url === '/' && manifest.display === 'standalone' && /^#/.test(manifest.theme_color) && manifest.lang === 'pt-BR', m.status);
  check('traz ícones de 192 e 512 px que existem', Array.isArray(manifest?.icons) && manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  for (const icon of manifest?.icons ?? []) {
    const res = await fetch(`${BASE}${icon.src}`);
    check(`ícone ${icon.src} existe e é imagem`, res.status === 200 && /^image\//.test(res.headers.get('content-type')), [res.status, res.headers.get('content-type')]);
  }
  const html = await text('/');
  check('a página inicial aponta para o manifesto', /<link rel="manifest" href="\/manifest\.webmanifest"/.test(html.body));
  const sw = await text('/sw.js');
  check('/sw.js é JavaScript', sw.status === 200 && /javascript/.test(sw.headers.get('content-type')), [sw.status, sw.headers.get('content-type')]);
  const code = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  check('o service worker só trata GET e deixa passar /api, páginas e qualquer coisa fora da lista estática', /request\.method !== 'GET'\) return/.test(code) && /if \(!isStatic\(url\)\) return/.test(code) && !/\/api\//.test(code.replace(/\/\/.*$/gm, '')));
  check('o service worker não guarda resposta com cookie', /!response\.headers\.has\('set-cookie'\)/.test(code));
  const off = await text('/offline.html');
  check('página "sem conexão" existe, em português, sem indexação', off.status === 200 && /Você está sem conexão/.test(off.body) && /noindex/.test(off.body));
}

// ------------------------------------------------------------------------------------------------
section('6. Contato e responsável: a quinta página de políticas');
{
  const page = await anon.get('/api/legal/contato-e-responsavel');
  check('texto padrão público, sem inventar CNPJ, razão social nem endereço', page.status === 200 && page.data.page.title === 'Contato e responsável' && !/\bCNPJ:?\s*\d/.test(page.data.page.body) && /serão informados nesta página/.test(page.data.page.body), page.status);
  const list = await owner.get('/api/admin/legal');
  check('o painel lista as 5 páginas, nesta ordem', list.status === 200 && list.data.pages.map((p) => p.slug).join() === 'termos,trocas-e-cancelamentos,entrega,pagamento-e-reembolso,contato-e-responsavel', list.data.pages?.map((p) => p.slug));
  check('nenhuma nasce como revisada juridicamente', list.data.pages.every((p) => p.reviewed_at === null));
  check('anônimo não edita (401)', (await anon.put('/api/admin/legal/contato-e-responsavel', { title: 'x', body: 'texto com mais de vinte letras' })).status === 401);
  const edit = await owner.put('/api/admin/legal/contato-e-responsavel', { title: 'Contato e responsável', body: '## Atendimento\nFale conosco pelo WhatsApp.\n\n## Responsável\nTexto escrito pela loja, com mais de vinte letras.' });
  check('o owner edita', edit.status === 200 && /Texto escrito pela loja/.test(edit.data.page.body), edit.status);
  const review = await owner.post('/api/admin/legal/contato-e-responsavel/review', { reviewed_by: 'Dra. Teste (OAB 000)' });
  check('e marca como revisada (só anotação)', review.status === 200 && review.data.page.reviewed_by === 'Dra. Teste (OAB 000)' && review.data.page.reviewed_at, review.status);
  const again = await owner.put('/api/admin/legal/contato-e-responsavel', { title: 'Contato e responsável', body: '## Atendimento\nFale conosco pelo WhatsApp, de segunda a sábado.\n\n## Responsável\nTexto escrito pela loja, com mais de vinte letras.' });
  check('mexer no texto tira a marca de revisada', again.status === 200 && again.data.page.reviewed_at === null);
  check('slug que não existe: 404', (await anon.get('/api/legal/contato')).status === 404 && (await owner.put('/api/admin/legal/outro', { title: 'x', body: 'texto com mais de vinte letras' })).status === 404);
}

serve({});
summary();
