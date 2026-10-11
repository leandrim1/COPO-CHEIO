import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const { siteUrl } = await load('server/mailBrand.ts');
// Cada pacote do esbuild leva a própria cópia da classe, então confere pelo nome e pelo conteúdo, não por instanceof.
const isMissing = (error) => error?.constructor?.name === 'MissingConfig' && Array.isArray(error.missing);

const KEYS = ['SITE_URL', 'VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL'];
function withEnv(env, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
const request = (url, headers = {}) => new Request(url, { headers });

test('SITE_URL manda em tudo (e perde barra final, caminho e ganha https)', () => {
  withEnv({ SITE_URL: 'https://www.copocheio.com.br/' }, () => assert.equal(siteUrl(request('https://atacante.test/api/x')), 'https://www.copocheio.com.br'));
  withEnv({ SITE_URL: 'copocheio.com.br/algum/caminho' }, () => assert.equal(siteUrl(request('https://atacante.test/')), 'https://copocheio.com.br'));
});

test('cabeçalhos Host / X-Forwarded-Host forjados NUNCA mudam o endereço', () => {
  const forged = { host: 'atacante.test', 'x-forwarded-host': 'atacante.test', 'x-forwarded-proto': 'https', forwarded: 'host=atacante.test' };
  withEnv({ SITE_URL: 'https://www.copocheio.com.br' }, () => assert.equal(siteUrl(request('https://atacante.test/api/x', forged)), 'https://www.copocheio.com.br'));
  withEnv({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'copocheio-nu.vercel.app' }, () =>
    assert.equal(siteUrl(request('https://atacante.test/api/x', forged)), 'https://copocheio-nu.vercel.app'),
  );
});

test('Vercel sem SITE_URL: produção usa o domínio de produção; preview usa o endereço da implantação', () => {
  withEnv({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'www.copocheio.com.br', VERCEL_URL: 'copocheio-abc123.vercel.app' }, () =>
    assert.equal(siteUrl(request('https://x.test/')), 'https://www.copocheio.com.br'),
  );
  withEnv({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_PROJECT_PRODUCTION_URL: 'www.copocheio.com.br', VERCEL_URL: 'copocheio-abc123.vercel.app' }, () =>
    assert.equal(siteUrl(request('https://x.test/')), 'https://copocheio-abc123.vercel.app'),
  );
});

test('fora da Vercel só o computador local vale; qualquer outro endereço sem SITE_URL falha com o nome da variável', () => {
  withEnv({}, () => assert.equal(siteUrl(request('http://localhost:5173/api/x')), 'http://localhost:5173'));
  withEnv({}, () => assert.equal(siteUrl(request('http://127.0.0.1:4180/api/x')), 'http://127.0.0.1:4180'));
  withEnv({}, () => {
    assert.throws(
      () => siteUrl(request('https://atacante.test/api/x', { host: 'atacante.test' })),
      (error) => isMissing(error) && error.missing.includes('SITE_URL'),
    );
  });
  withEnv({ VERCEL: '1' }, () => {
    assert.throws(() => siteUrl(request('https://atacante.test/')), isMissing);
  });
});

test('SITE_URL inválida (credenciais, protocolo estranho) é ignorada', () => {
  withEnv({ SITE_URL: 'https://user:pass@evil.test', VERCEL: '1', VERCEL_URL: 'copocheio-abc123.vercel.app' }, () =>
    assert.equal(siteUrl(request('https://x.test/')), 'https://copocheio-abc123.vercel.app'),
  );
  withEnv({ SITE_URL: 'javascript:alert(1)', VERCEL: '1', VERCEL_URL: 'copocheio-abc123.vercel.app' }, () => {
    // "javascript:alert(1)" vira https://javascript:alert(1) → inválido
    assert.equal(siteUrl(request('https://x.test/')), 'https://copocheio-abc123.vercel.app');
  });
});
