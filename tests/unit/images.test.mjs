import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from './load.mjs';

const { inspectImage, MAX_SIDE } = await load('server/images.ts');
const fx = (name) => new Uint8Array(readFileSync(join(fileURLToPath(new URL('../fixtures/', import.meta.url)), name)));

test('imagens de verdade são reconhecidas com o tipo certo', () => {
  assert.equal(inspectImage(fx('a.png'))?.type, 'image/png');
  assert.equal(inspectImage(fx('a.jpg'))?.type, 'image/jpeg');
  assert.equal(inspectImage(fx('a.webp'))?.type, 'image/webp');
  assert.ok(inspectImage(fx('a.png')).width >= 1);
});

test('SVG, texto e arquivo vazio não são imagens', () => {
  assert.equal(inspectImage(fx('evil.svg')), null);
  assert.equal(inspectImage(fx('fake.png')), null);
  assert.equal(inspectImage(new Uint8Array(0)), null);
  assert.equal(inspectImage(new TextEncoder().encode('<script>alert(1)</script>')), null);
});

test('assinatura certa com lixo atrás não passa (o ataque da auditoria)', () => {
  const fakeJpeg = new Uint8Array(400);
  fakeJpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(inspectImage(fakeJpeg), null);
  const fakePng = new Uint8Array(400);
  fakePng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(inspectImage(fakePng), null);
  const fakeWebp = new Uint8Array(400);
  fakeWebp.set(new TextEncoder().encode('RIFF'), 0);
  fakeWebp.set(new TextEncoder().encode('WEBP'), 8);
  assert.equal(inspectImage(fakeWebp), null);
});

test('arquivo cortado no meio não passa', () => {
  for (const name of ['a.png', 'a.jpg']) {
    const whole = fx(name);
    assert.equal(inspectImage(whole.subarray(0, whole.length - 20)), null, `${name} cortado`);
  }
  const webp = fx('a.webp');
  assert.equal(inspectImage(webp.subarray(0, webp.length - 20)), null, 'webp cortado');
});

// PNG mínimo com CRC certo e as dimensões que quisermos (sem pixels: só o que a conferência olha).
function crc32(bytes) {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}
function pngWith(width, height) {
  const out = new Uint8Array(45);
  const view = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(8, 13);
  out.set(new TextEncoder().encode('IHDR'), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  out.set([8, 6, 0, 0, 0], 24);
  view.setUint32(29, crc32(out.subarray(12, 29)));
  view.setUint32(33, 0);
  out.set(new TextEncoder().encode('IEND'), 37);
  view.setUint32(41, 0xae426082);
  return out;
}

test('dimensões plausíveis passam; gigantes e zeradas não', () => {
  assert.deepEqual(inspectImage(pngWith(800, 600)), { type: 'image/png', width: 800, height: 600 });
  assert.equal(inspectImage(pngWith(MAX_SIDE + 1, 10)), null, 'lado acima do limite');
  assert.equal(inspectImage(pngWith(10_000, 10_000)), null, 'pixels demais');
  assert.equal(inspectImage(pngWith(0, 10)), null, 'largura zero');
});

test('CRC do PNG errado não passa', () => {
  const png = pngWith(800, 600);
  png[20] ^= 0x01;
  assert.equal(inspectImage(png), null);
});
