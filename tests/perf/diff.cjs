// Compara duas pastas de capturas (shots.cjs): diferença média por pixel, % de pixels que mudaram (mais de 8/255 em algum canal) e a maior
// diferença. Com --heatmap <pasta>, grava também uma imagem por arquivo com os pixels diferentes em vermelho (e as faixas de altura onde estão).
// usage: node tests/perf/diff.cjs <pasta-A> <pasta-B> [--heatmap <pasta>]
const fs = require('fs');
const { launch, arg } = require('./lib.cjs');

const [, , A, B] = process.argv;
const HEAT = arg('heatmap');
if (!A || !B) {
  console.error('uso: node tests/perf/diff.cjs <pasta-A> <pasta-B> [--heatmap <pasta>]');
  process.exit(1);
}
if (HEAT) fs.mkdirSync(HEAT, { recursive: true });

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setContent('<canvas id=a></canvas><canvas id=b></canvas>');
  const out = [];
  for (const f of fs.readdirSync(A).filter((x) => x.endsWith('.png')).sort()) {
    if (!fs.existsSync(`${B}/${f}`)) {
      out.push(`${f}: falta na pasta B`);
      continue;
    }
    const r = await page.evaluate(
      async ({ a, b, heat }) => {
        const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + s; });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        if (ia.width !== ib.width || ia.height !== ib.height) return { size: [ia.width, ia.height, ib.width, ib.height] };
        const get = (img, id) => { const c = document.getElementById(id); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height); };
        const A_ = get(ia, 'a'), B_ = get(ib, 'b');
        const da = A_.data, db = B_.data;
        const map = heat ? new ImageData(A_.width, A_.height) : null;
        let sum = 0, changed = 0, max = 0;
        for (let i = 0; i < da.length; i += 4) {
          const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
          sum += (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])) / 3;
          if (d > 8) changed++;
          if (d > max) max = d;
          if (map) {
            if (d > 8) { map.data[i] = 255; map.data[i + 1] = 0; map.data[i + 2] = 0; }
            else map.data[i] = map.data[i + 1] = map.data[i + 2] = ((da[i] + da[i + 1] + da[i + 2]) / 3) * 0.25;
            map.data[i + 3] = 255;
          }
        }
        const n = da.length / 4;
        let png = null;
        if (map) {
          const c = document.createElement('canvas'); c.width = A_.width; c.height = A_.height; c.getContext('2d').putImageData(map, 0, 0);
          png = c.toDataURL('image/png').split(',')[1];
        }
        return { mean: +(sum / n).toFixed(4), changedPct: +((changed / n) * 100).toFixed(3), max, png };
      },
      { a: fs.readFileSync(`${A}/${f}`).toString('base64'), b: fs.readFileSync(`${B}/${f}`).toString('base64'), heat: Boolean(HEAT) },
    );
    if (r.png) fs.writeFileSync(`${HEAT}/${f}`, Buffer.from(r.png, 'base64'));
    out.push(`${f.padEnd(26)} ${r.size ? 'TAMANHOS DIFERENTES ' + r.size.join('x') : `diferença média ${r.mean}/255   pixels alterados ${r.changedPct}%   maior diferença ${r.max}`}`);
  }
  console.log(out.join('\n'));
  await browser.close();
})();
