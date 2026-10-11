// Rotas técnicas do site público:
//
//  • GET  /api/__page       HTML da página para ROBÔS (a Vercel manda para cá só quem se apresenta como WhatsApp, Facebook,
//                           Google etc.; veja o vercel.json). Entrega o mesmo site, mas com título, descrição, imagem de
//                           compartilhamento, endereço canônico e dados estruturados do painel já escritos no <head>, e com
//                           404 de verdade para endereços que não existem. Pessoas continuam recebendo o index.html estático.
//  • POST /api/csp-report   relatório de bloqueio da política de segurança (CSP): só vai para o log do servidor.
//  • POST /api/client-error erros do site no navegador (tela branca, falha inesperada): só vão para o log do servidor.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batch } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readBytes } from '../http.js';
import type { Router } from '../http.js';
import { siteUrl } from '../mailBrand.js';

// ---- Que páginas existem ----------------------------------------------------------------------------

type PageInfo = { known: boolean; indexable: boolean; title: string };

// Espelha o roteador do site (pageOf em src/App.tsx) e o painel. Endereço fora desta lista é "não encontrado".
export function describePath(path: string): PageInfo {
  const token = '[^/]{1,200}';
  if (path === '/') return { known: true, indexable: true, title: '' };
  if (path === '/bebidas') return { known: true, indexable: true, title: 'Bebidas' };
  if (path === '/privacidade') return { known: true, indexable: true, title: 'Política de privacidade' };
  if (path === '/checkout') return { known: true, indexable: false, title: 'Finalizar pedido' };
  if (new RegExp(`^/pedido/${token}$`).test(path)) return { known: true, indexable: false, title: 'Seu pedido' };
  if (path === '/acompanhar-pedido' || new RegExp(`^/acompanhar-pedido/${token}$`).test(path)) return { known: true, indexable: false, title: 'Acompanhar pedido' };
  if (path === '/conta' || path === '/conta/pedidos' || /^\/conta\/pedidos\/\d{1,12}$/.test(path) || path === '/conta/recuperar') return { known: true, indexable: false, title: 'Minha conta' };
  if (/^\/conta\/(redefinir|verificar)\/[0-9A-Za-z_-]{20,100}$/.test(path)) return { known: true, indexable: false, title: 'Minha conta' };
  if (path === '/admin' || path.startsWith('/admin/')) return { known: true, indexable: false, title: 'Painel' };
  return { known: false, indexable: false, title: 'Página não encontrada' };
}

// Só caminhos de página, sem nada estranho (o valor vem da reescrita do vercel.json, mas quem chama /api/__page direto também chega aqui).
function cleanPath(raw: string | null): string {
  const value = (raw ?? '/').split(/[?#]/)[0];
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 300 || /[\\\u0000-\u001f]/.test(value) || value.split('/').some((s) => s === '.' || s === '..')) return '/__invalido';
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

// ---- HTML ----------------------------------------------------------------------------------------------

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// O index.html que o build gera (com os scripts e estilos de cada versão). Vem do pacote da função (vercel.json → includeFiles).
let shellCache: string | null = null;
function loadShell(): string | null {
  if (shellCache) return shellCache;
  const candidates = [
    process.env.SHELL_HTML_FILE,
    join(process.cwd(), 'dist/index.html'),
    fileURLToPath(new URL('../dist/index.html', import.meta.url)),
    fileURLToPath(new URL('../../dist/index.html', import.meta.url)),
    '/var/task/dist/index.html',
  ].filter((file): file is string => Boolean(file));
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const html = readFileSync(file, 'utf8');
        if (/<\/head>/i.test(html) && /<div id="root"/i.test(html)) return (shellCache = html);
      }
    } catch {
      /* tenta o próximo */
    }
  }
  return null;
}

const DAYS: [string, string][] = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
];

// Dados estruturados da loja (schema.org). Só entra o que a loja cadastrou; nada é inventado.
function structuredData(base: string, store: Row | null, site: Row | null, image: string): string | null {
  if (!store) return null;
  const data: Row = { '@context': 'https://schema.org', '@type': 'Store', name: store.store_name, url: base, image };
  if (site?.seo_description) data.description = site.seo_description;
  if (store.whatsapp) data.telephone = `+${store.whatsapp}`;
  if (store.address || store.city) {
    data.address = { '@type': 'PostalAddress', streetAddress: store.address ?? undefined, addressLocality: store.city ?? undefined, addressRegion: store.state ?? undefined, postalCode: store.cep ?? undefined, addressCountry: 'BR' };
  }
  const hours = store.opening_hours as Record<string, { open: boolean; start: string; end: string }> | null;
  if (hours) {
    data.openingHoursSpecification = DAYS.filter(([key]) => hours[key]?.open).map(([key, day]) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: day, opens: hours[key].start, closes: hours[key].end }));
  }
  // "<" nunca aparece cru dentro do script (nada consegue fechar a tag antes da hora).
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function render(shell: string, tags: string, favicon: string | null): string {
  let html = shell.replace(/<title>[\s\S]*?<\/title>\s*/i, '').replace(/<meta\s+name="description"[^>]*>\s*/i, '');
  if (favicon) html = html.replace(/(<link\s+rel="icon"[^>]*\shref=")[^"]*(")/i, `$1${esc(favicon)}$2`);
  return html.replace(/<\/head>/i, `${tags}\n  </head>`);
}

export function registerSeo(r: Router) {
  r.get('/api/__page', 'public', async (ctx) => {
    const path = cleanPath(ctx.url.searchParams.get('__from'));
    const info = describePath(path);
    const status = info.known ? 200 : 404;
    const shell = loadShell();
    // Sem o index.html no pacote (ou sem o endereço do site) o robô recebe o index.html estático, como antes desta rota existir.
    let base: string;
    try {
      base = siteUrl(ctx.req);
    } catch {
      base = '';
    }
    if (!shell || !base) return new Response(null, { status: 302, headers: { location: '/index.html', 'cache-control': 'no-store' } });

    let store: Row | null = null;
    let site: Row | null = null;
    try {
      const [s, t] = await batch([
        ['select store_name, whatsapp, address, city, state, cep, opening_hours from store_settings where id = 1'],
        ['select seo_title, seo_description, og_image_url, favicon_url, logo_url from site_settings where id = 1'],
      ]);
      store = s[0] ?? null;
      site = t[0] ?? null;
    } catch {
      /* banco fora do ar: segue com o que o index.html já traz */
    }

    const abs = (url: string | null | undefined) => (url ? (url.startsWith('/') ? `${base}${url}` : url) : `${base}/logo.png`);
    const siteTitle = (site?.seo_title as string | undefined) || 'COPO CHEIO – Disk Bebidas';
    const title = info.title ? `${info.title} – ${siteTitle}` : siteTitle;
    const description = (site?.seo_description as string | null | undefined) || '';
    const image = abs((site?.og_image_url as string | null) || (site?.logo_url as string | null));
    const canonical = `${base}${path === '/' ? '' : path}`;

    const tags = [
      `<title>${esc(title)}</title>`,
      description ? `<meta name="description" content="${esc(description)}" />` : '',
      info.indexable ? `<link rel="canonical" href="${esc(canonical || base + '/')}" />` : '<meta name="robots" content="noindex, nofollow" />',
      `<meta property="og:site_name" content="${esc((store?.store_name as string | undefined) ?? 'Copo Cheio')}" />`,
      '<meta property="og:locale" content="pt_BR" />',
      '<meta property="og:type" content="website" />',
      `<meta property="og:title" content="${esc(title)}" />`,
      description ? `<meta property="og:description" content="${esc(description)}" />` : '',
      `<meta property="og:url" content="${esc(info.known ? canonical || base + '/' : base + '/')}" />`,
      `<meta property="og:image" content="${esc(image)}" />`,
      '<meta name="twitter:card" content="summary_large_image" />',
    ];
    if (info.indexable && (path === '/' || path === '/bebidas')) {
      const ld = structuredData(base, store, site, image);
      if (ld) tags.push(`<script type="application/ld+json">${ld}</script>`);
    }
    const html = render(shell, tags.filter(Boolean).map((t) => `    ${t}`).join('\n'), (site?.favicon_url as string | null) || null);
    return new Response(html, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        vary: 'User-Agent',
        'cache-control': info.indexable ? 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' : 'no-store',
        ...(info.indexable ? {} : { 'x-robots-tag': 'noindex, nofollow' }),
      },
    });
  });

  // Relatório de bloqueio da política de segurança (o navegador manda sozinho). Vai só para o log do servidor.
  const windowStart = { at: 0, count: 0 };
  const budget = () => {
    const now = Date.now();
    if (now - windowStart.at > 60_000) Object.assign(windowStart, { at: now, count: 0 });
    return ++windowStart.count <= 20;
  };
  r.post('/api/csp-report', 'public', async (ctx) => {
    if (budget()) {
      try {
        const body = new TextDecoder().decode(await readBytes(ctx.req, 8 * 1024));
        const report = (JSON.parse(body) as Row)['csp-report'] as Row | undefined;
        if (report) {
          const pick = (key: string) => String(report[key] ?? '').slice(0, 200);
          console.warn(JSON.stringify({ level: 'warn', msg: 'csp-bloqueio', page: pick('document-uri'), directive: pick('violated-directive'), blocked: pick('blocked-uri'), source: pick('source-file') }));
        }
      } catch {
        /* relatório malformado: ignora */
      }
    }
    return new Response(null, { status: 204 });
  });

  // Erro que aconteceu no navegador de alguém (a tela de erro do site também manda por aqui).
  r.post('/api/client-error', 'public', async (ctx) => {
    if (!budget()) return new Response(null, { status: 204 });
    const bytes = await readBytes(ctx.req, 8 * 1024); // grande demais: 413
    let body: Row;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as Row;
    } catch {
      throw new HttpError(400, 'Os dados enviados são inválidos.');
    }
    // Endereços com código de acompanhamento ou de redefinição de senha nunca vão para o log (o site já os mascara; aqui é a segunda trava).
    const clip = (value: unknown, max: number) =>
      String(value ?? '')
        .replace(/(\/(?:pedido|acompanhar-pedido|conta\/redefinir|conta\/verificar)\/)[^/?#\s"']+/g, '$1:codigo')
        .slice(0, max);
    console.error(JSON.stringify({ level: 'error', msg: 'erro-no-navegador', kind: clip(body.kind, 30), message: clip(body.message, 300), page: clip(body.page, 200), stack: clip(body.stack, 800), agent: clip(ctx.req.headers.get('user-agent'), 150) }));
    return json({ ok: true }, 202);
  });
}
