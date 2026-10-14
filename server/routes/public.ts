// Rotas públicas: o que o site mostra e a criação de pedidos. Nada administrativo sai daqui.
import { refund, reserve } from '../auth.js';
import { customerFromRequest } from '../customer.js';
import { batch, one, query } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Router } from '../http.js';
import { getProvider, isOnlineMethod } from '../payments/provider.js';
import { sweep } from '../payments/service.js';
import { hashToken, newTrackingToken, trackingTokenFromKey } from '../tracking.js';

// Listas públicas (cardápio e conteúdo do site) podem ficar uns segundos na borda da Vercel: muita gente abrindo o site ao mesmo
// tempo vira uma consulta ao banco por poucos segundos, e não uma por pessoa. É curto de propósito: preço, esgotado e "loja aberta"
// mudam em até ~40 s para quem abre o site; o PEDIDO sempre usa os valores de agora, direto do banco.
const PUBLIC_CACHE = { 'cache-control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=30' };

// Tempo mínimo entre abrir o checkout e enviar o pedido: gente leva mais que isso; robôs que disparam o formulário, não.
const MIN_FILL_MS = 600;

export function registerPublic(r: Router) {
  // Produtos e categorias ativos, só com as colunas que o site mostra (estoque e SKU ficam de fora).
  // promo_price é a promoção EM VIGOR agora (fora da janela de datas, ela some e o produto volta ao preço normal).
  r.get('/api/products', 'public', async () => {
    const [categories, products] = await batch([
      // ice_choice_required: os produtos desta categoria só são pedidos com a escolha do gelo (o banco confere de novo ao criar o pedido).
      ['select id, name, position, active, ice_choice_required from categories where active order by position, name'],
      [
        `select p.id, p.category_id, p.name, p.description, p.price,
                effective_promo(p.promo_price, p.promo_starts_at, p.promo_ends_at) as promo_price,
                p.image_url, p.featured,
                (p.sold_out or (p.stock is not null and p.stock <= 0)) as sold_out, p.position,
                p.swap_base_product_id, p.swap_base_price,
                array(select o.option_id from product_swap_options o where o.product_id = p.id order by o.option_id) as swap_option_ids
           from products p
           left join categories c on c.id = p.category_id
          where p.active and (p.category_id is null or c.active)
          order by p.position, p.name`,
      ],
    ]);
    return json({ categories, products }, 200, PUBLIC_CACHE);
  });

  // Textos, loja, entrega, pagamento e banners (os do cardápio em `banners`; os da capa em `cover_banners`).
  // Colunas escolhidas uma a uma (nada de `select *`): uma coluna nova que o painel venha a ter nunca vai parar na internet sem querer.
  r.get('/api/site', 'public', async () => {
    const [store, site, hero, banners, coverBanners, zones, payments] = await batch([
      [
        `select store_name, tagline, whatsapp, instagram, address, cep, city, state, opening_hours, timezone, orders_paused,
                delivery_enabled, pickup_enabled, delivery_fee, min_order, delivery_time, tracking_retention_days
           from store_settings where id = 1`,
      ],
      [
        `select logo_url, bebidas_title, bebidas_highlight, bebidas_subtitle, featured_title, featured_limit, contato_title, contato_highlight,
                contato_subtitle, cta_title, cta_highlight, cta_subtitle, cta_button, seo_title, seo_description, og_image_url, favicon_url
           from site_settings where id = 1`,
      ],
      [
        `select title, title_highlight, subtitle, primary_button_text, secondary_button_text, show_secondary_button, badge_text, show_badge, images
           from hero_settings where id = 1`,
      ],
      [
        `select id, placement, title, subtitle, image_desktop_url, image_mobile_url, button_text, link, position, active
           from banners where active and placement = 'menu' order by position, created_at`,
      ],
      [
        // A capa mostra só a imagem (o título é a descrição dela para leitores de tela) e o link.
        `select id, placement, title, image_desktop_url, image_mobile_url, link, position, active
           from banners where active and placement = 'cover' order by position, created_at`,
      ],
      ['select id, name, fee, position, active from delivery_zones where active order by position, name'],
      // O cartão online leva a taxa (percentual e tarifa fixa) e o Pix online leva a taxa de serviço (percentual) só para a tela mostrar o resumo enquanto a
      // pessoa mexe no pedido; quem cobra de verdade é o banco.
      [
        `select m.code, m.label, m.details,
                case when m.code = 'card_online' then jsonb_build_object('bps', f.card_fee_bps, 'fixed_cents', f.card_fee_fixed_cents) end as card_fee,
                case when m.code = 'pix_online' then jsonb_build_object('bps', f.pix_customer_fee_bps) end as service_fee
           from payment_methods m cross join payment_fee_settings f
          where m.enabled and (m.code <> 'card_online' or f.confirmed_at is not null)
          order by m.position`,
      ],
    ]);
    if (!store[0] || !site[0] || !hero[0]) {
      throw new HttpError(503, 'O banco ainda não tem o conteúdo inicial. Rode as migrations (npm run db:migrate).');
    }
    return json({ store: store[0], site: site[0], hero: hero[0], banners, cover_banners: coverBanners, zones, payments }, 200, PUBLIC_CACHE);
  });

  r.post('/api/orders', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 64 * 1024);

    // Proteção contra pedidos falsos em massa, sem depender de serviço externo:
    //  • "website" é um campo escondido que pessoas não veem nem preenchem; robôs que preenchem tudo caem aqui;
    //  • tempo mínimo de preenchimento (fill_ms, medido no navegador);
    //  • limites por rede, reservados no banco de forma atômica: toda tentativa conta (60 em 10 min) e os pedidos que valem, mais
    //    ainda (20 em 10 min). (Antes só os pedidos que davam certo contavam, e tentativas simultâneas passavam do limite.)
    const wait = 'Muitos pedidos em pouco tempo. Aguarde alguns minutos ou fale com a loja pelo WhatsApp.';
    await reserve('order-try', ctx.ip, 600, 60, wait);
    const trap = typeof body.website === 'string' && body.website.trim() !== '';
    // Quanto tempo a pessoa ficou na tela antes de enviar, medido no navegador dela (não depende do relógio do aparelho).
    const filledMs = typeof body.fill_ms === 'number' ? body.fill_ms : NaN;
    const tooFast = Number.isFinite(filledMs) && filledMs >= 0 && filledMs < MIN_FILL_MS;
    if (trap || tooFast) throw new HttpError(400, 'Não foi possível enviar o pedido. Atualize a página e tente de novo.', { code: 'rejected' });
    // Pagamento online sem operadora configurada neste servidor: não cria um pedido que a pessoa não conseguiria pagar.
    if (isOnlineMethod(body.payment_method) && !getProvider()) {
      throw new HttpError(503, 'O pagamento online não está disponível agora. Escolha outra forma de pagamento.', { code: 'payments_unavailable' });
    }
    await reserve('order', ctx.ip, 600, 20, wait);

    try {
      // Pedido de pagamento online que não foi pago a tempo devolve o estoque antes desta venda (sem agendador: de passagem, no máximo a cada 20 s).
      await sweep({ lookups: false }).catch(() => undefined);
      // Preço, estoque, taxa e regras da loja são conferidos dentro do banco (create_order): o navegador só diz o que o cliente
      // escolheu. O código de acompanhamento nasce aqui, no servidor: só o hash vai para o banco, na mesma transação do pedido.
      // Com chave de idempotência, o código é derivado dela: repetir o envio devolve o MESMO pedido e o mesmo código.
      // A conta (se o cliente estiver logado) vem da sessão, nunca do corpo da requisição.
      const customer = await customerFromRequest(ctx.req);
      const key = typeof body.idempotency_key === 'string' ? body.idempotency_key : null;
      const token = key && /^[A-Za-z0-9_-]{16,64}$/.test(key) ? trackingTokenFromKey(key) : newTrackingToken();
      const { website: _trap, fill_ms: _fill, ...clean } = body;
      const payload = { ...clean, tracking_hash: hashToken(token), customer_id: customer?.id ?? null };
      const row = await one<{ order: { replayed?: boolean } | null }>('select create_order($1::jsonb) as "order"', [JSON.stringify(payload)]);
      const replayed = Boolean(row?.order?.replayed);
      // Reenvio do mesmo pedido não é um pedido novo: devolve a vaga.
      if (replayed) await refund('order', ctx.ip);
      // De vez em quando, apaga dados técnicos vencidos (sessões, tentativas, códigos de pedidos fora do prazo).
      if (Math.random() < 0.02) await query('select purge_expired_data()').catch(() => undefined);
      return json({ order: row?.order, token }, replayed ? 200 : 201);
    } catch (error) {
      // Pedido recusado (loja fechada, produto esgotado, preço mudou...): não gasta a cota de pedidos da pessoa.
      await refund('order', ctx.ip);
      throw error;
    }
  });
}
