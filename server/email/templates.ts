// E-mails de pedido e pagamento, de promoção e de alerta. Mesmo layout de todos os outros (server/mailLayout.ts): aqui só o texto.
//
// Regras de conteúdo (valem para todos): assunto claro e igual ao que o e-mail diz, sem MAIÚSCULAS gritantes nem promessa que a loja não
// controla, só links https do próprio site, e NENHUM dado pessoal além do necessário (o e-mail de pedido mostra o bairro, nunca o endereço
// inteiro nem o telefone: o endereço de e-mail digitado num pedido pode não ser do cliente).
import type { Brand } from '../mailBrand.js';
import type { Message } from '../mail.js';
import { renderEmail } from '../mailLayout.js';
import type { Block } from '../mailLayout.js';
import { greetingName } from '../mailTemplates.js';

export const brl = (value: number): string => `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type OrderKind = 'order_received' | 'order_confirmed' | 'order_out_for_delivery' | 'order_delivered' | 'order_cancelled' | 'payment_confirmed' | 'payment_refunded';

export type OrderMail = {
  kind: OrderKind;
  to: string;
  name: string;
  number: number;
  lines: { qty: number; name: string; total: number }[];
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  delivery: 'delivery' | 'pickup';
  neighborhood: string | null;
  paymentLabel: string;
  paymentStatus: 'pending' | 'paid' | 'refunded';
  trackUrl: string;
  // Link das preferências deste endereço (parar de receber e-mails de pedidos).
  prefsUrl: string;
  // Exemplo mandado pelo painel: "[Teste]" no assunto e a faixa de aviso (o pedido é inventado).
  sample?: boolean;
};

const REASON = 'Você recebeu este e-mail porque este endereço foi informado num pedido feito na loja.';

function summary(o: OrderMail): Block[] {
  const rows = [{ label: 'Subtotal', value: brl(o.subtotal) }];
  if (o.deliveryFee > 0) rows.push({ label: 'Taxa de entrega', value: brl(o.deliveryFee) });
  if (o.discount > 0) rows.push({ label: 'Desconto', value: `− ${brl(o.discount)}` });
  const strong = { label: 'Total', value: brl(o.total), strong: true as const };
  return [{ kind: 'order', number: String(o.number), lines: o.lines.map((l) => ({ qty: l.qty, name: l.name, total: brl(l.total) })), rows: [...rows, strong] }];
}

function facts(o: OrderMail, withTotal = true): Block {
  const rows = [
    { label: o.delivery === 'delivery' ? 'Entrega' : 'Retirada', value: o.delivery === 'delivery' ? (o.neighborhood ? `no bairro ${o.neighborhood}` : 'no endereço do pedido') : 'na loja' },
    { label: 'Pagamento', value: o.paymentLabel },
  ];
  if (withTotal) rows.push({ label: 'Total', value: brl(o.total) });
  return { kind: 'facts', rows };
}

const notMine: Block = { kind: 'notice', text: '**Não fez este pedido?** Fale com a loja pelos contatos abaixo. Se este endereço não é seu, use o link no fim deste e-mail para não receber mais mensagens de pedidos aqui.' };

export function orderMessage(brand: Brand, o: OrderMail): Message {
  const hi = greetingName(o.name);
  const greeting = hi ? `Olá, **${hi}**!` : 'Olá!';
  const pickup = o.delivery === 'pickup';
  const n = `#${o.number}`;
  const track: Block = { kind: 'button', label: 'Acompanhar meu pedido', url: o.trackUrl };
  const base = {
    to: o.to,
    greeting,
    reason: REASON,
    footerLinks: [{ label: 'Não quero e-mails sobre pedidos neste endereço', url: o.prefsUrl }],
    ...(o.sample ? { banner: 'Mensagem de teste enviada pelo painel. O pedido é de exemplo: nada foi comprado.' } : {}),
  };
  const subject = (text: string) => `${o.sample ? '[Teste] ' : ''}${text} – ${brand.name}`;

  switch (o.kind) {
    case 'order_received':
      return renderEmail(brand, {
        ...base,
        subject: subject(`Pedido ${n} recebido`),
        preheader: `Recebemos o seu pedido ${n}. Total ${brl(o.total)}.`,
        eyebrow: 'Pedido recebido',
        title: 'Recebemos o seu pedido',
        blocks: [
          { kind: 'text', text: `Seu pedido **${n}** foi recebido e a loja já vai cuidar dele. Você pode acompanhar cada etapa pelo botão abaixo.` },
          ...summary(o),
          facts(o, false),
          track,
          notMine,
        ],
      });
    case 'order_confirmed':
      return renderEmail(brand, {
        ...base,
        subject: subject(`Pedido ${n} confirmado`),
        preheader: `A loja confirmou o pedido ${n}.`,
        eyebrow: 'Pedido confirmado',
        title: 'A loja confirmou o seu pedido',
        blocks: [{ kind: 'text', text: `O pedido **${n}** foi confirmado e a loja está preparando tudo.` }, facts(o), track, notMine],
      });
    case 'order_out_for_delivery':
      return renderEmail(brand, {
        ...base,
        subject: subject(pickup ? `Pedido ${n} pronto para retirar` : `Pedido ${n} saiu para entrega`),
        preheader: pickup ? `O pedido ${n} está pronto para retirar na loja.` : `O pedido ${n} saiu para entrega.`,
        eyebrow: pickup ? 'Pronto para retirar' : 'A caminho',
        title: pickup ? 'Seu pedido está pronto' : 'Seu pedido saiu para entrega',
        blocks: [
          { kind: 'text', text: pickup ? `O pedido **${n}** está pronto. É só passar na loja para retirar.` : `O pedido **${n}** saiu para entrega e logo chega até você.` },
          facts(o),
          track,
          notMine,
        ],
      });
    case 'order_delivered':
      return renderEmail(brand, {
        ...base,
        subject: subject(pickup ? `Pedido ${n} retirado` : `Pedido ${n} entregue`),
        preheader: pickup ? `Pedido ${n} retirado. Obrigado!` : `Pedido ${n} entregue. Obrigado!`,
        eyebrow: pickup ? 'Pedido retirado' : 'Pedido entregue',
        title: 'Obrigado pelo seu pedido!',
        blocks: [
          { kind: 'text', text: pickup ? `O pedido **${n}** foi retirado. Esperamos que você curta!` : `O pedido **${n}** foi entregue. Esperamos que você curta!` },
          { kind: 'text', tone: 'muted', text: 'Se alguma coisa não saiu como deveria, fale com a loja pelos contatos abaixo.' },
          track,
          notMine,
        ],
      });
    case 'order_cancelled':
      return renderEmail(brand, {
        ...base,
        subject: subject(`Pedido ${n} cancelado`),
        preheader: `O pedido ${n} foi cancelado.`,
        eyebrow: 'Pedido cancelado',
        title: 'Seu pedido foi cancelado',
        blocks: [
          { kind: 'text', text: `O pedido **${n}** foi cancelado.` },
          { kind: 'text', tone: 'muted', text: 'Se não foi você quem pediu o cancelamento, ou se ficou alguma dúvida, fale com a loja pelos contatos abaixo.' },
          notMine,
        ],
      });
    case 'payment_confirmed':
      return renderEmail(brand, {
        ...base,
        subject: subject(`Pagamento do pedido ${n} confirmado`),
        preheader: `Recebemos o pagamento de ${brl(o.total)} do pedido ${n}.`,
        eyebrow: 'Pagamento confirmado',
        title: 'Recebemos o seu pagamento',
        blocks: [
          { kind: 'text', text: `O pagamento de **${brl(o.total)}** do pedido **${n}** foi confirmado e o pedido já seguiu para a loja.` },
          ...summary(o),
          facts(o, false),
          track,
          notMine,
        ],
      });
    case 'payment_refunded':
      return renderEmail(brand, {
        ...base,
        subject: subject(`Reembolso do pedido ${n} registrado`),
        preheader: `A loja registrou o reembolso do pedido ${n}.`,
        eyebrow: 'Reembolso registrado',
        title: 'Reembolso registrado',
        blocks: [
          { kind: 'text', text: `A loja registrou o reembolso de **${brl(o.total)}** do pedido **${n}**.` },
          { kind: 'text', tone: 'muted', text: 'O prazo para o valor aparecer depende do seu banco ou da forma como você pagou. Em caso de dúvida, fale com a loja pelos contatos abaixo.' },
          notMine,
        ],
      });
  }
}

// ---- Promoção ------------------------------------------------------------------------------------------

export type CampaignMail = {
  to: string;
  subject: string;
  preheader: string | null;
  title: string;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  // Página de preferências e endereço do "cancelar com um clique" (RFC 8058).
  preferencesUrl: string;
  oneClickUrl: string;
  sample?: boolean;
};

export function campaignMessage(brand: Brand, o: CampaignMail): Message {
  const paragraphs = o.body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 14);
  const blocks: Block[] = paragraphs.map((text) => ({ kind: 'text', text }) as Block);
  if (o.ctaLabel && o.ctaUrl) blocks.push({ kind: 'button', label: o.ctaLabel, url: o.ctaUrl });
  return renderEmail(brand, {
    to: o.to,
    subject: `${o.sample ? '[Teste] ' : ''}${o.subject}`,
    preheader: o.preheader ?? paragraphs[0]?.slice(0, 140) ?? o.title,
    eyebrow: 'Novidades da loja',
    title: o.title,
    banner: o.sample ? 'Mensagem de teste enviada pelo painel. Ninguém mais recebeu este e-mail.' : undefined,
    blocks,
    footerLinks: [
      { label: 'Cancelar inscrição', url: o.preferencesUrl },
      { label: 'Preferências de e-mail', url: o.preferencesUrl },
    ],
    reason: `Você recebe este e-mail porque pediu para receber novidades e promoções de ${brand.name}.`,
    // Descadastro com um clique: o provedor de caixa de entrada (Gmail, Yahoo) mostra o botão "Cancelar inscrição" e faz um POST neste endereço.
    headers: { 'List-Unsubscribe': `<${o.oneClickUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
}

// ---- Alerta para a equipe --------------------------------------------------------------------------------

export type AlertLine = { severity: 'info' | 'warning' | 'critical'; title: string; detail: string; hint: string };

export function alertMessage(brand: Brand, o: { to: string; name: string; alerts: AlertLine[]; panelUrl: string }): Message {
  const hi = greetingName(o.name);
  const critical = o.alerts.some((a) => a.severity === 'critical');
  return renderEmail(brand, {
    to: o.to,
    subject: `${critical ? 'Atenção' : 'Aviso'}: o envio de e-mails da loja precisa de você – ${brand.name}`,
    preheader: o.alerts[0] ? `${o.alerts[0].title}. ${o.alerts[0].detail}` : 'Há um alerta nos e-mails da loja.',
    eyebrow: 'Entregabilidade',
    title: critical ? 'Há um problema com os e-mails da loja' : 'Um aviso sobre os e-mails da loja',
    greeting: hi ? `Olá, **${hi}**!` : 'Olá!',
    blocks: [
      { kind: 'text', text: 'O sistema encontrou o que está abaixo ao acompanhar os envios de e-mail da loja.' },
      ...o.alerts.slice(0, 6).map((a) => ({ kind: 'notice', text: `**${a.title}.** ${a.detail} ${a.hint}` }) as Block),
      { kind: 'button', label: 'Abrir E-mails e Entregabilidade', url: o.panelUrl },
    ],
    reason: 'Esta mensagem foi enviada porque você é dono da loja no painel.',
  });
}

// ---- Aviso da operação para os donos (estoque e rotina automática) ------------------------------------------

export type OpsMail = {
  to: string;
  name: string;
  low: { name: string; stock: number; limit: number }[];
  out: { name: string }[];
  job: { problem: 'failed' | 'stale'; lastRun: string; detail: string | null } | null;
  stockUrl: string;
  systemUrl: string;
};

const MAX_LISTED = 15;

export function opsAlertMessage(brand: Brand, o: OpsMail): Message {
  const hi = greetingName(o.name);
  const parts: string[] = [];
  if (o.low.length) parts.push(o.low.length === 1 ? '1 produto com estoque baixo' : `${o.low.length} produtos com estoque baixo`);
  if (o.out.length) parts.push(o.out.length === 1 ? '1 produto esgotado' : `${o.out.length} produtos esgotados`);
  if (o.job) parts.push('rotina automática com problema');
  const blocks: Block[] = [{ kind: 'text', text: 'O sistema encontrou o que está abaixo ao acompanhar o estoque e as rotinas da loja.' }];
  if (o.job) {
    blocks.push({
      kind: 'notice',
      text:
        o.job.problem === 'failed'
          ? `**A rotina automática falhou na última execução** (${o.job.lastRun}). Ela encerra o Pix vencido, devolve o estoque do pedido não pago e manda a fila de e-mails. ${o.job.detail ? `Motivo: ${o.job.detail}. ` : ''}Veja o estado em Configurações → Painel → Estado do sistema.`
          : `**A rotina automática não roda há mais de um dia** (última vez: ${o.job.lastRun}). Confira a variável CRON_SECRET na Vercel e as execuções do cron. Enquanto isso, o Pix vencido só é encerrado de passagem, quando entra movimento.`,
    });
  }
  if (o.low.length) {
    blocks.push({ kind: 'text', text: '**Estoque baixo**' });
    blocks.push({ kind: 'facts', rows: o.low.slice(0, MAX_LISTED).map((p) => ({ label: p.name, value: `${p.stock} un. (aviso com até ${p.limit})` })) });
    if (o.low.length > MAX_LISTED) blocks.push({ kind: 'text', text: `E mais ${o.low.length - MAX_LISTED} produto(s).`, tone: 'muted' });
  }
  if (o.out.length) {
    blocks.push({ kind: 'text', text: '**Esgotados**' });
    blocks.push({ kind: 'facts', rows: o.out.slice(0, MAX_LISTED).map((p) => ({ label: p.name, value: 'esgotado' })) });
    if (o.out.length > MAX_LISTED) blocks.push({ kind: 'text', text: `E mais ${o.out.length - MAX_LISTED} produto(s).`, tone: 'muted' });
  }
  blocks.push({ kind: 'button', label: o.low.length || o.out.length ? 'Abrir o estoque' : 'Abrir o painel', url: o.low.length || o.out.length ? o.stockUrl : o.systemUrl });
  return renderEmail(brand, {
    to: o.to,
    subject: `Aviso: ${parts.join(' e ')} – ${brand.name}`,
    preheader: parts.join(' · '),
    eyebrow: 'Operação da loja',
    title: o.job ? 'Há algo para olhar na loja' : 'Estoque para repor',
    greeting: hi ? `Olá, **${hi}**!` : 'Olá!',
    blocks,
    reason: 'Você recebe este aviso porque é dono da loja no painel. Mandamos no máximo um por dia, só quando a situação muda. O aviso de estoque se desliga em Estoque → "Avisar por e-mail".',
  });
}
