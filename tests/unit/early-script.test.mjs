// O pedido adiantado do cardápio (public/early.js): roda assim que o HTML é lido, antes do JavaScript principal, e `fetchShop` (site/data.tsx)
// aproveita a resposta. O arquivo é um script comum (sem import), guardado no cache do navegador por até um dia: o formato da variável global
// precisa continuar o mesmo e o script nunca pode derrubar a página.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { ROOT } from './load.mjs';

const code = readFileSync(`${ROOT}/public/early.js`, 'utf8');
const html = readFileSync(`${ROOT}/index.html`, 'utf8');
const vercel = JSON.parse(readFileSync(`${ROOT}/vercel.json`, 'utf8'));
const data = readFileSync(`${ROOT}/src/site/data.tsx`, 'utf8');

// Executa o script numa "janela" de mentira; devolve o que ele pediu, o que deixou na janela e as conexões que mandou abrir.
// `bodies`: o texto que cada resposta teria (cardápio e textos do site); `stored`: a cópia guardada no navegador (ou uma função que lança).
function run({ pathname, fetchImpl, bodies = {}, stored = null, extra = {} }) {
  const calls = [];
  const links = [];
  const window = {};
  const response = (text) => ({ ok: true, clone: () => ({ text: async () => text, json: async () => JSON.parse(text) }), text: async () => text });
  const context = vm.createContext({
    window,
    location: { pathname },
    fetch:
      fetchImpl ??
      ((url, init) => {
        calls.push({ url, init });
        return Promise.resolve(response(bodies[url] ?? '{}'));
      }),
    document: { createElement: () => ({}), head: { appendChild: (el) => links.push(el) } },
    localStorage: { getItem: typeof stored === 'function' ? stored : () => stored },
    ...extra,
  });
  vm.runInContext(code, context);
  return { calls, window, links };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const kind = (links, rel) => links.filter((l) => l.rel === rel);
const preconnects = (links) => kind(links, 'preconnect');
const preloads = (links) => kind(links, 'preload').map((l) => ({ href: l.href, media: l.media, as: l.as, priority: l.fetchPriority }));

test('páginas do site: pede o cardápio e os textos, com cookies do próprio site, e deixa as duas promessas na janela', async () => {
  for (const pathname of ['/', '/bebidas', '/checkout', '/conta', '/acompanhar-pedido', '/pedido/abc', '/privacidade']) {
    const { calls, window } = run({ pathname });
    assert.deepEqual(calls.map((c) => c.url), ['/api/products', '/api/site'], pathname);
    assert.ok(calls.every((c) => c.init?.credentials === 'same-origin'), 'mesmas credenciais do cliente da API');
    assert.deepEqual(Object.keys(window.__copoEarly).sort(), ['products', 'site']);
    assert.equal((await window.__copoEarly.products).ok, true);
    assert.equal((await window.__copoEarly.site).ok, true);
  }
});

const BLOB_A = 'https://ab12cd.public.blob.vercel-storage.com';

test('conexão com o armazenamento das imagens: aberta pelo endereço que veio na resposta do cardápio, uma vez só', async () => {
  const { links: all } = run({ pathname: '/bebidas', bodies: { '/api/products': `{"products":[{"image_url":"${BLOB_A}/products/a.webp"}]}`, '/api/site': `{"banners":[{"image_desktop_url":"${BLOB_A}/banners/b.webp"}]}` } });
  await flush();
  const links = preconnects(all);
  assert.equal(links.length, 1, 'duas respostas com o mesmo endereço abrem uma conexão só');
  assert.deepEqual({ rel: links[0].rel, href: links[0].href }, { rel: 'preconnect', href: BLOB_A });
});

test('conexão com o armazenamento: vem da cópia guardada na visita anterior, antes mesmo da resposta', () => {
  const { links } = run({ pathname: '/', stored: `{"products":[{"image":"${BLOB_A}/products/z.webp"}]}` });
  assert.equal(preconnects(links).length, 1, 'na hora (sem esperar a rede)');
  assert.equal(preconnects(links)[0].href, BLOB_A);
});

test('conexão com o armazenamento: só para o Blob (https), nunca para endereço qualquer', async () => {
  for (const body of ['{}', '{"products":[{"image_url":"https://exemplo.com/a.webp"}]}', '{"products":[{"image_url":"http://ab12cd.public.blob.vercel-storage.com/a.webp"}]}', '{"products":[{"image_url":"https://blob.vercel-storage.com.exemplo.com/a.webp"}]}', '']) {
    const { links } = run({ pathname: '/bebidas', bodies: { '/api/products': body, '/api/site': body } });
    await flush();
    assert.equal(preconnects(links).length, 0, body);
  }
});

test('conexão com o armazenamento: armazenamento do navegador quebrado ou resposta com erro não impedem nada', async () => {
  const quebrado = run({ pathname: '/bebidas', stored: () => { throw new Error('modo privado'); }, bodies: { '/api/products': `{"p":"${BLOB_A}/x.webp"}` } });
  await flush();
  assert.equal(preconnects(quebrado.links).length, 1, 'sem armazenamento local, vale a resposta');
  const erro = run({ pathname: '/bebidas', fetchImpl: () => Promise.resolve({ ok: false, clone: () => ({ text: async () => `${BLOB_A}/x.webp` }) }) });
  await flush();
  assert.equal(erro.links.length, 0, 'resposta de erro não vale (nem conexão, nem foto adiantada)');
  assert.deepEqual(Object.keys(erro.window.__copoEarly).sort(), ['products', 'site'], 'e as promessas continuam disponíveis');
});

// ---- Foto principal adiantada (preload) ---------------------------------------------------------------------------------------------------------

const site = (extra) => JSON.stringify({ banners: [], cover_banners: [], hero: { images: [] }, ...extra });
const B = (name) => `${BLOB_A}/banners/${name}.webp`;

test('foto principal de /bebidas: o 1º slide da capa e o 1º do cardápio são pedidos já, com prioridade alta, pelo endereço certo para cada tela', async () => {
  const { links } = run({
    pathname: '/bebidas',
    bodies: {
      '/api/site': site({
        cover_banners: [{ image_mobile_url: null, image_desktop_url: null }, { image_mobile_url: B('cover-m'), image_desktop_url: B('cover-d') }, { image_mobile_url: B('cover2-m') }],
        banners: [{ image_mobile_url: B('menu-m'), image_desktop_url: B('menu-d') }, { image_desktop_url: B('menu2-d') }],
      }),
    },
  });
  await flush();
  assert.deepEqual(preloads(links), [
    { href: B('cover-m'), media: '(max-width: 639px)', as: 'image', priority: 'high' },
    { href: B('cover-d'), media: '(min-width: 640px)', as: 'image', priority: 'high' },
    { href: B('menu-m'), media: '(max-width: 639px)', as: 'image', priority: 'high' },
    { href: B('menu-d'), media: '(min-width: 640px)', as: 'image', priority: 'high' },
  ], 'a capa pula o slide sem foto (como o site) e só o 1º de cada carrossel é adiantado');
});

test('foto principal de /bebidas: só uma versão da foto = um pedido só, sem condição de tela', async () => {
  const { links } = run({ pathname: '/bebidas/', bodies: { '/api/site': site({ cover_banners: [{ image_mobile_url: B('so-celular') }], banners: [{ image_desktop_url: B('so-pc') }] }) } });
  await flush();
  assert.deepEqual(preloads(links), [
    { href: B('so-celular'), media: undefined, as: 'image', priority: 'high' },
    { href: B('so-pc'), media: undefined, as: 'image', priority: 'high' },
  ]);
  const igual = run({ pathname: '/bebidas', bodies: { '/api/site': site({ banners: [{ image_mobile_url: B('x'), image_desktop_url: B('x') }] }) } });
  await flush();
  assert.equal(preloads(igual.links).length, 1, 'a mesma foto para celular e computador é pedida uma vez');
});

test('foto principal de /bebidas: sem banners, nada a adiantar; banner sem foto também não', async () => {
  for (const body of [site({}), site({ banners: [{ title: 'Só texto' }], cover_banners: [] }), site({ banners: null, cover_banners: null }), '{}', '[]', 'null']) {
    const { links } = run({ pathname: '/bebidas', bodies: { '/api/site': body } });
    await flush();
    assert.deepEqual(preloads(links), [], body);
  }
});

test('foto principal da página inicial: a 1ª foto do painel ou, sem fotos, a 1ª bebida de sempre (a mesma de DRINKS, em App.tsx)', async () => {
  const comFotos = run({ pathname: '/', bodies: { '/api/site': site({ hero: { images: [B('hero-1'), B('hero-2')] } }) } });
  await flush();
  assert.deepEqual(preloads(comFotos.links), [{ href: B('hero-1'), media: undefined, as: 'image', priority: 'high' }], 'só a primeira (a outras esperam, no site)');
  const padrao = run({ pathname: '/', bodies: { '/api/site': site({}) } });
  await flush();
  const app = readFileSync(`${ROOT}/src/App.tsx`, 'utf8');
  const first = /const DRINKS = \[\s*\{ src: '([^']+)'/.exec(app)?.[1];
  assert.ok(first, 'achou a 1ª bebida padrão em App.tsx');
  assert.deepEqual(preloads(padrao.links), [{ href: first, media: undefined, as: 'image', priority: 'high' }], 'o endereço padrão do early.js é o de App.tsx');
});

test('foto principal: nas outras páginas e no painel não se adianta foto nenhuma', async () => {
  for (const pathname of ['/checkout', '/conta', '/acompanhar-pedido', '/pedido/abc', '/privacidade', '/bebidas-extra', '/admin', '/admin/banners']) {
    const { links } = run({ pathname, bodies: { '/api/site': site({ banners: [{ image_desktop_url: B('menu') }], cover_banners: [{ image_desktop_url: B('cover') }], hero: { images: [B('hero')] } }) } });
    await flush();
    assert.deepEqual(preloads(links), [], pathname);
  }
});

test('foto principal: só https ou caminho do próprio site vira pedido (nada de http, javascript:, //host, espaço, aspas)', async () => {
  const ruins = ['http://x.test/a.webp', 'javascript:alert(1)', '//evil.test/a.webp', 'data:image/png;base64,AAAA', 'https://x.test/a b.webp', 'https://x.test/a".webp', "https://x.test/a'.webp", 'https://x.test/<a>.webp', '', 42, {}, null];
  for (const bad of ruins) {
    const { links } = run({ pathname: '/bebidas', bodies: { '/api/site': site({ banners: [{ image_desktop_url: bad }], cover_banners: [{ image_mobile_url: bad }] }) } });
    await flush();
    assert.deepEqual(preloads(links), [], String(bad));
    const home = run({ pathname: '/', bodies: { '/api/site': site({ hero: { images: [bad] } }) } });
    await flush();
    assert.deepEqual(preloads(home.links), [], `início: ${String(bad)}`);
  }
  const boa = run({ pathname: '/bebidas', bodies: { '/api/site': site({ banners: [{ image_desktop_url: '/img/bench/menu-1-d.webp' }] }) } });
  await flush();
  assert.equal(preloads(boa.links).length, 1, 'caminho do próprio site vale');
});

test('foto principal: resposta com erro ou texto que não é JSON não derruba nada', async () => {
  const lixo = run({ pathname: '/bebidas', bodies: { '/api/site': '<html>erro</html>' } });
  await flush();
  assert.deepEqual(preloads(lixo.links), []);
  assert.deepEqual(Object.keys(lixo.window.__copoEarly).sort(), ['products', 'site'], 'e as promessas continuam disponíveis para o site');
  const semClone = run({ pathname: '/bebidas', fetchImpl: () => Promise.resolve({ ok: true, clone: () => { throw new Error('sem clone'); } }) });
  await flush();
  assert.deepEqual(preloads(semClone.links), []);
});

// A foto principal só começa a baixar depois que o pacote principal do site terminou de baixar (senão ela dividiria a rede com ele e atrasaria o 1º desenho).
function withObserver() {
  const state = { callback: null, options: null, timers: [] };
  class PerformanceObserver {
    constructor(callback) {
      state.callback = callback;
    }
    observe(options) {
      state.options = options;
    }
  }
  return {
    state,
    extra: { PerformanceObserver, setTimeout: (fn, ms) => state.timers.push({ fn, ms }) },
    emit: (...names) => state.callback({ getEntries: () => names.map((name) => ({ name })) }),
  };
}

test('foto principal: espera o pacote principal terminar de baixar (e só ele); pede uma vez só', async () => {
  const o = withObserver();
  const { links } = run({ pathname: '/bebidas', extra: o.extra, bodies: { '/api/site': site({ banners: [{ image_desktop_url: B('menu') }] }) } });
  await flush();
  assert.deepEqual({ ...o.state.options }, { type: 'resource', buffered: true }, 'olha os recursos já baixados e os que vierem');
  assert.deepEqual(preloads(links), [], 'com o pacote ainda baixando, nada é pedido');
  o.emit('http://x.test/early.js', 'http://x.test/api/site', 'http://x.test/assets/index-ab12.css', 'http://x.test/img/frozen-rosa.webp');
  assert.deepEqual(preloads(links), [], 'outros arquivos não contam (script de pedido adiantado, API, CSS, imagens)');
  o.emit('http://x.test/assets/index-Dj-R3xnh.js');
  assert.equal(preloads(links).length, 1, 'terminou o pacote: pede a foto');
  o.emit('http://x.test/assets/Checkout-abc.js', 'http://x.test/assets/index-Dj-R3xnh.js');
  assert.equal(preloads(links).length, 1, 'avisos repetidos não repetem o pedido');
  o.state.timers[0].fn();
  assert.equal(preloads(links).length, 1, 'nem o prazo, depois de já ter pedido');
});

test('foto principal: se o aviso do pacote nunca chega, pede ao fim de 2,5 s', async () => {
  const o = withObserver();
  const { links } = run({ pathname: '/', extra: o.extra, bodies: { '/api/site': site({}) } });
  await flush();
  assert.deepEqual(preloads(links), []);
  assert.equal(o.state.timers.length, 1);
  assert.equal(o.state.timers[0].ms, 2500);
  o.state.timers[0].fn();
  assert.equal(preloads(links).length, 1);
});

test('foto principal: navegador sem PerformanceObserver pede na hora', async () => {
  const { links } = run({ pathname: '/', bodies: { '/api/site': site({}) } });
  await flush();
  assert.equal(preloads(links).length, 1);
  const quebrado = run({ pathname: '/', extra: { PerformanceObserver: class { constructor() { throw new Error('sem suporte'); } }, setTimeout: () => {} }, bodies: { '/api/site': site({}) } });
  await flush();
  assert.equal(preloads(quebrado.links).length, 1, 'observador que lança também não impede');
});

test('painel: não pede nada (o painel não usa o cardápio público)', () => {
  for (const pathname of ['/admin', '/admin/login', '/admin/produtos/novo']) {
    const { calls, window } = run({ pathname });
    assert.deepEqual(calls, [], pathname);
    assert.equal(window.__copoEarly, undefined);
  }
  assert.equal(run({ pathname: '/administracao' }).calls.length, 2, '/administracao não é o painel');
});

test('falha de rede não vira erro sem tratamento, e o script nunca derruba a página', async () => {
  const failing = run({ pathname: '/bebidas', fetchImpl: () => Promise.reject(new Error('sem rede')) });
  // Quem usa a resposta trata a rejeição; o script só marca como tratada (nenhum unhandledRejection).
  await assert.rejects(failing.window.__copoEarly.products, /sem rede/);
  await assert.rejects(failing.window.__copoEarly.site, /sem rede/);
  assert.doesNotThrow(() => run({ pathname: '/bebidas', fetchImpl: () => { throw new Error('fetch quebrado'); } }), 'fetch que lança na hora');
  assert.doesNotThrow(() => vm.runInContext(code, vm.createContext({ window: {}, location: { pathname: '/' } })), 'navegador sem fetch');
});

test('o HTML carrega o script sem travar a página e o site pede os mesmos endereços', () => {
  assert.match(html, /<script src="\/early\.js" async><\/script>/);
  assert.ok(!/<script>[\s\S]*?<\/script>/.test(html), 'nenhum script dentro do HTML (a política de segurança não aceita)');
  assert.match(data, /fromEarly<[^>]*>\(early\?\.products, `\/api\/products\$\{bust\}`\)/);
  assert.match(data, /fromEarly<[^>]*>\(early\?\.site, `\/api\/site\$\{bust\}`\)/);
  assert.match(data, /bypassCache \? undefined : window\.__copoEarly/, 'o pedido que quer o dado fresco (preço mudou) não usa o adiantado');
});

test('cache: arquivos fixos (early.js, logo e gelo menores) têm o cache de um dia', () => {
  const rule = vercel.headers.find((h) => /early/.test(h.source));
  assert.ok(rule, 'regra de cache do early.js');
  assert.deepEqual(rule.headers, [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }]);
  const re = new RegExp(`^${rule.source}$`);
  for (const file of ['/early.js', '/logo-128.webp', '/logo-256.webp', '/logo-512.webp', '/gelo.webp', '/gelo-96.webp', '/gelo-192.webp']) assert.match(file, re, file);
});
