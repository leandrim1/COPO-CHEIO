import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

// Medição de visitas (GA4): opcional, só com consentimento, sem dados pessoais (src/lib/analytics.ts). O navegador é simulado com o mínimo necessário.
// O módulo guarda estado (script já carregado, última página): cada teste pede uma cópia nova.
const fresh = () => load('src/lib/analytics.ts');
const pure = await fresh();

function fakeBrowser() {
  const store = new Map();
  const scripts = [];
  const cookies = new Map([['_ga', 'GA1.1.1'], ['_ga_ABC', 'x'], ['sessao', 'abc']]);
  globalThis.window = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    location: { origin: 'https://loja.example' },
  };
  globalThis.document = {
    title: 'Bebidas – Copo Cheio',
    head: { appendChild: (el) => scripts.push(el) },
    createElement: () => ({}),
    get cookie() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(text) {
      const [pair, ...attrs] = text.split(';');
      const [name, value] = pair.split('=');
      if (attrs.some((x) => x.trim() === 'Max-Age=0')) cookies.delete(name.trim());
      else cookies.set(name.trim(), value);
    },
  };
  return { store, scripts, cookies };
}
const events = () => window.dataLayer.filter((x) => x && x[0] === 'event').map((x) => [x[1], x[2]]);

test('identificador: só o formato G-XXXXXXXX vale', () => {
  const a = pure;
  assert.equal(a.isMeasurementId('G-ABCD1234'), true);
  for (const bad of ['', 'UA-123456-1', 'g-abcd1234', 'G-', 'G-<script>', 'G-ABCD1234 ', null, undefined, 42]) assert.equal(a.isMeasurementId(bad), false, String(bad));
});

test('o endereço medido nunca leva código de pedido, token, conta, painel ou tela do cartão', () => {
  const a = pure;
  assert.equal(a.sanitizePath('/'), '/');
  assert.equal(a.sanitizePath('/bebidas'), '/bebidas');
  assert.equal(a.sanitizePath('/checkout'), '/checkout');
  assert.equal(a.sanitizePath('/termos'), '/termos');
  assert.equal(a.sanitizePath('/pedido/ABCD-EFGH-1234'), '/pedido');
  assert.equal(a.sanitizePath('/acompanhar-pedido/ABCD-EFGH-1234'), '/acompanhar-pedido');
  assert.equal(a.sanitizePath('/conta/redefinir/token-secreto'), '/conta');
  assert.equal(a.sanitizePath('/conta/pedidos/42'), '/conta');
  assert.equal(a.sanitizePath('/conta/emails/segredo'), '/conta');
  for (const secret of ['/admin', '/admin/pedidos', '/pagar/TOKEN', '/../etc', '/a/b/c', '/?x=1']) assert.equal(a.sanitizePath(secret), null, secret);
});

test('sem identificador: nada é carregado nem medido, mesmo com "Aceitar"', async () => {
  const a = await fresh();
  const b = fakeBrowser();
  a.initAnalytics(null);
  assert.equal(a.analyticsConfigured(), false);
  a.setConsent('granted');
  a.trackPage('/bebidas');
  assert.equal(b.scripts.length, 0);
  assert.equal(window.dataLayer, undefined);
});

test('com identificador, mas sem consentimento: nenhum script do Google', async () => {
  const a = await fresh();
  const b = fakeBrowser();
  a.setConsent('denied');
  a.initAnalytics('G-TEST1234');
  assert.equal(a.analyticsConfigured(), true);
  assert.equal(b.scripts.length, 0);
  assert.equal(a.readConsent(), 'denied');
  a.trackPage('/bebidas');
  assert.equal(window.dataLayer, undefined);
});

test('depois do "Aceitar": carrega o script com o identificador, sem anúncios, e mede uma visita por troca de página', async () => {
  const a = await fresh();
  const b = fakeBrowser();
  a.setConsent('granted');
  a.initAnalytics('G-TEST1234');
  assert.equal(b.scripts.length, 1);
  assert.equal(b.scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=G-TEST1234');
  const config = window.dataLayer.map((x) => Array.from(x)).find((x) => x[0] === 'config');
  assert.equal(config[1], 'G-TEST1234');
  assert.equal(config[2].send_page_view, false);
  assert.equal(config[2].allow_google_signals, false);
  assert.equal(config[2].allow_ad_personalization_signals, false);
  window.gtag = function () {
    window.dataLayer.push(['event', ...Array.from(arguments).slice(1)]);
  };
  a.trackPage('/bebidas');
  a.trackPage('/bebidas'); // o modo estrito do React roda o efeito de novo: não conta de novo
  a.trackPage('/pedido/CODIGO-SECRETO-1');
  a.trackPage('/admin/pedidos');
  a.trackPage('/pagar/TOKEN');
  const sent = events();
  assert.deepEqual(sent.map(([name, p]) => `${name} ${p.page_path}`), ['page_view /bebidas', 'page_view /pedido']);
  assert.ok(JSON.stringify(sent).indexOf('SECRETO') === -1, 'o código do pedido não vai na medição');
});

test('begin_checkout e purchase: uma vez só, só valores', async () => {
  const a = await fresh();
  fakeBrowser();
  a.setConsent('granted');
  a.initAnalytics('G-TEST1234');
  window.gtag = function () {
    window.dataLayer.push(['event', ...Array.from(arguments).slice(1)]);
  };
  const before = events().length;
  a.trackOnce('begin_checkout', 'begin_checkout', { value: 37.5 });
  a.trackOnce('begin_checkout', 'begin_checkout', { value: 37.5 });
  a.trackOnce('purchase:7', 'purchase', { value: 42, transaction_id: '7', payment_type: 'pix' });
  a.trackOnce('purchase:7', 'purchase', { value: 42, transaction_id: '7', payment_type: 'pix' });
  const sent = events().slice(before);
  assert.deepEqual(sent.map(([n]) => n), ['begin_checkout', 'purchase']);
  assert.deepEqual(sent[1][1], { currency: 'BRL', value: 42, transaction_id: '7', payment_type: 'pix' });
});

test('"Recusar" depois de aceitar: para de medir e apaga os cookies _ga', async () => {
  const a = await fresh();
  const b = fakeBrowser();
  a.setConsent('granted');
  a.initAnalytics('G-OTHER567');
  window.gtag = function () {
    window.dataLayer.push(['event', ...Array.from(arguments).slice(1)]);
  };
  a.setConsent('denied');
  assert.equal(window['ga-disable-G-OTHER567'], true);
  assert.deepEqual([...b.cookies.keys()], ['sessao'], 'só os cookies da medição saem');
  const before = events().length;
  a.trackOnce('purchase:99', 'purchase', { value: 10 });
  assert.equal(events().length, before, 'sem consentimento nada é enviado');
});
