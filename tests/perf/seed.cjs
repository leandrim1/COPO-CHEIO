// Cardápio SINTÉTICO para medir desempenho com um volume realista: 9 categorias, 90 produtos com foto (8 favoritos, 3 esgotados, promoções),
// 3 banners no cardápio, 2 na capa e 5 bairros. As fotos são geradas no Chromium pelo MESMO caminho do painel (canvas → WebP q0,88 até 1200 px;
// miniaturas de 400 e 720 px de largura com a qualidade do painel) a partir das 3 fotos de bebida do site, mudando matiz e posição para cada URL ser
// um arquivo DIFERENTE (cada uma com o seu cache). Ele ZERA produtos, categorias, banners e bairros do banco de TESTE: nunca aponte para um banco real.
//
//   node tests/perf/seed.cjs images             gera as fotos em tests/perf/.data/img/bench (uma vez)
//   node tests/perf/seed.cjs sql [--no-thumbs]   grava o cardápio no banco de teste (127.0.0.1:5433/copocheio_test; PGDATABASE para outro) com as miniaturas
//   node tests/perf/seed.cjs install <dist>     copia as fotos para <dist>/img/bench (o build apaga a pasta: repita depois de cada `npm run build`)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium, root } = require('./lib.cjs');

const DATA = path.join(__dirname, '.data', 'img', 'bench');
const [, , COMMAND, ARG] = process.argv;
const THUMBS = !process.argv.includes('--no-thumbs');
const N = 90;

async function images() {
  fs.mkdirSync(DATA, { recursive: true });
  const SRC = ['energetico-azul', 'frozen-chocolate', 'frozen-rosa'].map((n) => 'data:image/webp;base64,' + fs.readFileSync(path.join(root, 'public/img', `${n}.webp`)).toString('base64'));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  const result = await page.evaluate(
    async ({ SRC, N }) => {
      const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
      const imgs = await Promise.all(SRC.map(load));
      const toB64 = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
      const out = {};
      const canvas = document.getElementById('c');
      const webp = (q) => new Promise((r) => canvas.toBlob(r, 'image/webp', q));
      // Produtos: 1200 × 1200 (transparência preservada) + as miniaturas de 400 e 720 px.
      for (let i = 0; i < N; i++) {
        canvas.width = 1200; canvas.height = 1200;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 1200, 1200);
        ctx.filter = `hue-rotate(${(i * 37) % 360}deg) saturate(${1 + (i % 5) * 0.05})`;
        const s = 1200 * (0.96 + (i % 7) * 0.006);
        ctx.drawImage(imgs[i % 3], (1200 - s) / 2 + (i % 5) * 2, (1200 - s) / 2, s, s);
        const key = `p-${String(i).padStart(2, '0')}`;
        out[`${key}.webp`] = await toB64(await webp(0.88));
        const full = await createImageBitmap(canvas);
        for (const w of [400, 720]) {
          const c = document.createElement('canvas'); c.width = w; c.height = w;
          const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(full, 0, 0, w, w);
          out[`${key}-${w}.webp`] = await toB64(await new Promise((r) => c.toBlob(r, 'image/webp', 0.86)));
        }
      }
      // Banners: fotos "reais" têm textura; ruído leve deixa o peso parecido com o de uma foto.
      const banner = async (name, w, h, hue) => {
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, `hsl(${hue},80%,35%)`); g.addColorStop(1, `hsl(${(hue + 60) % 360},85%,18%)`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
        for (let k = 0; k < 40; k++) { ctx.fillStyle = `hsla(${(hue + k * 9) % 360},70%,60%,0.12)`; ctx.beginPath(); ctx.arc(((k * 733) % w), ((k * 389) % h), 40 + ((k * 53) % (h / 2)), 0, 7); ctx.fill(); }
        ctx.filter = `hue-rotate(${hue}deg)`;
        const d = h * 0.9; ctx.drawImage(imgs[hue % 3], w * 0.55, (h - d) / 2, d, d); ctx.filter = 'none';
        ctx.fillStyle = '#fff'; ctx.font = `900 ${Math.round(h * 0.2)}px sans-serif`; ctx.fillText('PROMOÇÃO', w * 0.06, h * 0.5);
        const data = ctx.getImageData(0, 0, w, h);
        for (let p = 0; p < data.data.length; p += 4) { const n = (((p * 2654435761) >>> 0) % 22) - 11; data.data[p] += n; data.data[p + 1] += n; data.data[p + 2] += n; }
        ctx.putImageData(data, 0, 0);
        out[name] = await toB64(await webp(0.88));
      };
      await banner('cover-1-d.webp', 2000, 500, 210); await banner('cover-1-m.webp', 1200, 540, 210);
      await banner('cover-2-d.webp', 2000, 500, 20); await banner('cover-2-m.webp', 1200, 540, 20);
      await banner('menu-1-d.webp', 1600, 610, 140); await banner('menu-1-m.webp', 1000, 750, 140);
      await banner('menu-2-d.webp', 1600, 610, 300); await banner('menu-2-m.webp', 1000, 750, 300);
      await banner('menu-3-d.webp', 1600, 610, 60); await banner('menu-3-m.webp', 1000, 750, 60);
      return out;
    },
    { SRC, N },
  );
  let total = 0;
  for (const [name, b64] of Object.entries(result)) {
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(path.join(DATA, name), buf);
    total += buf.length;
  }
  console.log(`${Object.keys(result).length} arquivos em ${DATA} (${(total / 1048576).toFixed(1)} MB)`);
  await browser.close();
}

function sql() {
  const cats = ['Cervejas', 'Refrigerantes', 'Sucos e energéticos', 'Destilados', 'Vinhos', 'Copões', 'Combos', 'Gelo e carvão', 'Petiscos'];
  const names = ['Skol Lata', 'Brahma Duplo Malte', 'Heineken Long Neck', 'Original 600ml', 'Coca-Cola 2L', 'Guaraná Antarctica 2L', 'Fanta Laranja 2L', 'Monster Energy', 'Red Bull 250ml', 'Suco Del Valle', 'Vodka Smirnoff 998ml', 'Whisky Red Label', 'Gin Tanqueray', 'Vinho Tinto Suave', 'Copão Monster Mango', 'Copão Frozen', 'Combo Vodka + Energético', 'Combo Cerveja 12 latas', 'Gelo 5kg', 'Carvão 4kg', 'Amendoim', 'Batata Ruffles', 'Água com gás', 'Tônica Schweppes'];
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const out = ['delete from products; delete from categories; delete from banners; delete from delivery_zones;'];
  cats.forEach((c, i) => out.push(`insert into categories (name, position) values (${q(c)}, ${i});`));
  for (let i = 0; i < N; i++) {
    const cat = cats[i % cats.length];
    const name = `${names[i % names.length]} ${Math.floor(i / names.length) + 1}`.slice(0, 80);
    const price = (3 + ((i * 7.3) % 117)).toFixed(2);
    const promo = i % 15 === 4 ? (Number(price) * 0.85).toFixed(2) : null;
    const desc = i % 5 === 0 ? null : `Gelada e pronta para entrega. ${'Aproveite com os amigos. '.repeat(1 + (i % 3))}`.trim().slice(0, 200);
    const key = `/img/bench/p-${String(i).padStart(2, '0')}`;
    out.push(
      `insert into products (category_id, name, description, price, promo_price, image_url, image_sm_url, image_md_url, featured, sold_out, position, stock) values ((select id from categories where name = ${q(cat)}), ${q(name)}, ${desc ? q(desc) : 'null'}, ${price}, ${promo ?? 'null'}, '${key}.webp', ${THUMBS ? `'${key}-400.webp', '${key}-720.webp'` : 'null, null'}, ${i % 11 === 3}, ${i % 31 === 7}, ${Math.floor(i / cats.length)}, 100);`,
    );
  }
  const banner = (placement, n, title, pos) => `insert into banners (placement, title, subtitle, image_desktop_url, image_mobile_url, position) values ('${placement}', ${title ? q(title) : 'null'}, ${title ? q('Só hoje, para você') : 'null'}, '/img/bench/${placement}-${n}-d.webp', '/img/bench/${placement}-${n}-m.webp', ${pos});`;
  out.push(banner('cover', 1, null, 0), banner('cover', 2, null, 1), banner('menu', 1, 'Promoção da semana', 0), banner('menu', 2, 'Combo de sexta', 1), banner('menu', 3, null, 2));
  ['Centro', 'Jardim América', 'Vila Nova', 'Bairro Alto', 'Distrito'].forEach((z, i) => out.push(`insert into delivery_zones (name, fee, position) values (${q(z)}, ${3 + i}, ${i});`));
  const open = { open: true, start: '00:00', end: '00:00' };
  out.push(`update store_settings set orders_paused = false, delivery_fee = 5, opening_hours = '${JSON.stringify(Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, open])))}'::jsonb where id = 1;`);
  execFileSync('psql', ['-q', '-h', process.env.PGHOST ?? '127.0.0.1', '-p', process.env.PGPORT ?? '5433', '-U', 'postgres', '-d', process.env.PGDATABASE ?? 'copocheio_test', '-v', 'ON_ERROR_STOP=1'], { input: out.join('\n'), stdio: ['pipe', 'inherit', 'inherit'] });
  console.log(`cardápio de teste gravado: ${N} produtos${THUMBS ? ' com miniaturas' : ' SEM miniaturas'}, 5 banners, 5 bairros`);
}

function install(dist) {
  if (!dist) throw new Error('informe a pasta do build: node tests/perf/seed.cjs install dist');
  fs.mkdirSync(path.join(dist, 'img', 'bench'), { recursive: true });
  for (const f of fs.readdirSync(DATA)) fs.copyFileSync(path.join(DATA, f), path.join(dist, 'img', 'bench', f));
  console.log(`fotos copiadas para ${path.join(dist, 'img', 'bench')}`);
}

(async () => {
  if (COMMAND === 'images') await images();
  else if (COMMAND === 'sql') sql();
  else if (COMMAND === 'install') install(ARG);
  else {
    console.error('uso: node tests/perf/seed.cjs images | sql [--no-thumbs] | install <pasta-do-build>');
    process.exit(1);
  }
})();
