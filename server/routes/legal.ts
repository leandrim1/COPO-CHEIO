// Páginas de termos e políticas com texto editável pelo dono (termos de uso, cancelamento e trocas, entrega e retirada, pagamento e reembolso).
// Público: lê o texto. Painel (só o owner): edita o texto e marca quando o texto foi revisado juridicamente. O texto é só texto (nunca HTML): o site o desenha.
import { audit } from '../audit.js';
import { one, query } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Router } from '../http.js';

export const LEGAL_SLUGS = ['termos', 'trocas-e-cancelamentos', 'entrega', 'pagamento-e-reembolso', 'contato-e-responsavel'] as const;
const isSlug = (value: unknown): value is (typeof LEGAL_SLUGS)[number] => typeof value === 'string' && (LEGAL_SLUGS as readonly string[]).includes(value);

const PUBLIC = 'slug, title, body, updated_at';
const ADMIN = 'slug, title, body, reviewed_at, reviewed_by, updated_at';

// Texto puro: sem NUL nem caracteres de controle (exceto quebra de linha), quebras de linha unificadas, no máximo 20.000 letras.
const cleanBody = (value: unknown): string => {
  if (typeof value !== 'string') throw new HttpError(400, 'Texto: texto inválido.');
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (text.length < 20) throw new HttpError(400, 'Texto: escreva pelo menos 20 letras.');
  if (text.length > 20000) throw new HttpError(400, 'Texto: use no máximo 20.000 letras.');
  return text;
};

export function registerLegal(r: Router) {
  r.get('/api/legal/:slug', 'public', async (ctx) => {
    if (!isSlug(ctx.params.slug)) throw new HttpError(404, 'Página não encontrada.');
    const page = await one<Row>(`select ${PUBLIC} from legal_pages where slug = $1`, [ctx.params.slug]);
    if (!page) throw new HttpError(404, 'Página não encontrada.');
    return json({ page }, 200, { 'cache-control': 'public, max-age=0, s-maxage=30, stale-while-revalidate=120' });
  });

  r.get('/api/admin/legal', 'owner', async () => json({ pages: await query<Row>(`select ${ADMIN} from legal_pages order by array_position(array['termos','trocas-e-cancelamentos','entrega','pagamento-e-reembolso','contato-e-responsavel'], slug)`) }));

  r.put('/api/admin/legal/:slug', 'owner', async (ctx) => {
    if (!isSlug(ctx.params.slug)) throw new HttpError(404, 'Página não encontrada.');
    const body = await readJson(ctx.req, 40 * 1024);
    const title = typeof body.title === 'string' ? body.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    if (title.length < 3 || title.length > 80) throw new HttpError(400, 'Título: use de 3 a 80 letras.');
    const text = cleanBody(body.body);
    const before = await one<Row>('select body, title from legal_pages where slug = $1', [ctx.params.slug]);
    if (!before) throw new HttpError(404, 'Página não encontrada.');
    const changed = before.body !== text || before.title !== title;
    // Mudou o texto → deixa de valer a revisão jurídica anterior (quem revisou, revisou o texto antigo).
    const page = await one<Row>(
      `update legal_pages set title = $2, body = $3, updated_by = $4,
              reviewed_at = case when $5::boolean then null else reviewed_at end,
              reviewed_by = case when $5::boolean then null else reviewed_by end
        where slug = $1 returning ${ADMIN}`,
      [ctx.params.slug, title, text, ctx.admin!.id, changed],
    );
    if (changed) await audit(ctx, { action: 'legal.update', summary: `Editou a página “${title}” (${ctx.params.slug}); a revisão jurídica anterior deixou de valer`, entity: 'legal', details: { slug: ctx.params.slug } });
    return json({ page });
  });

  // "Revisado por [nome] em [hoje]": um registro de que alguém conferiu o texto vigente. Não é parecer jurídico: só uma anotação da loja.
  r.post('/api/admin/legal/:slug/review', 'owner', async (ctx) => {
    if (!isSlug(ctx.params.slug)) throw new HttpError(404, 'Página não encontrada.');
    const body = await readJson(ctx.req, 1024);
    const who = typeof body.reviewed_by === 'string' ? body.reviewed_by.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    if (who.length < 2 || who.length > 120) throw new HttpError(400, 'Revisado por: informe o nome de quem revisou (2 a 120 letras).');
    const page = await one<Row>(`update legal_pages set reviewed_at = now(), reviewed_by = $2 where slug = $1 returning ${ADMIN}`, [ctx.params.slug, who]);
    if (!page) throw new HttpError(404, 'Página não encontrada.');
    await audit(ctx, { action: 'legal.review', summary: `Marcou a página ${ctx.params.slug} como revisada por ${who}`, entity: 'legal', details: { slug: ctx.params.slug } });
    return json({ page });
  });
}
