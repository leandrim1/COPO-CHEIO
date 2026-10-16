// Compatibilidade e segurança dos TEMPLATES de e-mail (todos os tipos): HTML que os leitores de e-mail aceitam, versão em texto igual,
// links só https e sem encurtador, nada de script/formulário/pixel de rastreio, escape de dados de clientes, tamanho abaixo do corte do
// Gmail, cabeçalhos de descadastro nas promoções e só nelas. Sem rede e sem banco. (A prova final é abrir uma mensagem real no Gmail e
// no Outlook: docs/EMAIL.md.)
import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const tpl = await load('server/email/templates.ts');
const mt = await load('server/mailTemplates.ts');

const brand = {
  name: 'Copo Cheio',
  tagline: 'Disk Bebidas',
  siteUrl: 'https://loja.exemplo.com.br',
  siteHost: 'loja.exemplo.com.br',
  logoUrl: 'https://loja.exemplo.com.br/email/logo.png',
  contacts: [
    { label: 'WhatsApp', text: '(34) 99128-3384', url: 'https://wa.me/5534991283384' },
    { label: 'Instagram', text: '@copocheiodisk', url: 'https://instagram.com/copocheiodisk' },
    { label: 'Endereço', text: 'Rua das Flores, 10, Centro, Cidade - MG' },
  ],
  year: 2026,
  timezone: 'America/Sao_Paulo',
};

const order = (over = {}) => ({
  kind: 'order_received',
  to: 'cliente@exemplo.com',
  name: 'Carla Compradora',
  number: 1001,
  lines: [
    { qty: 2, name: 'Heineken Long Neck', total: 17 },
    { qty: 1, name: 'Água com gás (gelo normal)', total: 4 },
  ],
  subtotal: 21,
  deliveryFee: 5,
  discount: 0,
  total: 26,
  delivery: 'delivery',
  neighborhood: 'Centro',
  paymentLabel: 'Dinheiro',
  online: false,
  paymentStatus: 'pending',
  trackUrl: 'https://loja.exemplo.com.br/acompanhar-pedido/ABCDE-FGHIJ-KLMNO-PQRST',
  prefsUrl: 'https://loja.exemplo.com.br/conta/emails/00000000-0000-4000-8000-000000000000_0123456789abcdef0123456789abcdef',
  ...over,
});

const campaign = (over = {}) => ({
  to: 'cliente@exemplo.com',
  subject: 'Sexta com cerveja gelada na Copo Cheio',
  preheader: 'Ofertas só hoje',
  title: 'Sexta de promoção',
  body: 'Hoje tem cerveja gelada com preço especial.\n\nPeça pelo site e receba em casa.',
  ctaLabel: 'Ver ofertas',
  ctaUrl: 'https://loja.exemplo.com.br/bebidas',
  preferencesUrl: 'https://loja.exemplo.com.br/conta/emails/00000000-0000-4000-8000-000000000000_0123456789abcdef0123456789abcdef',
  oneClickUrl: 'https://loja.exemplo.com.br/api/email/unsubscribe/00000000-0000-4000-8000-000000000000_0123456789abcdef0123456789abcdef',
  ...over,
});

const when = new Date('2026-10-14T15:00:00Z');
const ALL = [];
const add = (name, kind, message) => ALL.push({ name, kind, message });

add('confirmação de e-mail', 'transactional', mt.verificationMessage(brand, { to: 'a@exemplo.com', name: 'Ana', code: '123456', link: `${brand.siteUrl}/conta/verificar/TOKENTOKENTOKENTOKENTOKEN`, codeMinutes: 15, linkHours: 24 }));
add('confirmação com aviso de promoções', 'transactional', mt.verificationMessage(brand, { to: 'a@exemplo.com', name: 'Ana', code: '123456', link: `${brand.siteUrl}/conta/verificar/TOKENTOKENTOKENTOKENTOKEN`, codeMinutes: 15, linkHours: 24, marketingNotice: true }));
add('confirmação de teste do painel', 'transactional', mt.verificationMessage(brand, { to: 'a@exemplo.com', name: 'Ana', code: '123456', link: `${brand.siteUrl}/conta`, codeMinutes: 15, linkHours: 24, sample: true }));
add('código para entrar na conta', 'transactional', mt.loginCodeMessage(brand, { to: 'a@exemplo.com', name: 'Ana', code: '654321', codeMinutes: 10 }));
add('código para entrar (teste do painel)', 'transactional', mt.loginCodeMessage(brand, { to: 'a@exemplo.com', name: 'Ana', code: '654321', codeMinutes: 10, sample: true }));
add('você já tem uma conta', 'transactional', mt.alreadyRegisteredMessage(brand, { to: 'a@exemplo.com', name: 'Ana', loginUrl: `${brand.siteUrl}/conta` }));
add('nova senha (link)', 'transactional', mt.passwordResetMessage(brand, { to: 'a@exemplo.com', name: 'Ana', link: `${brand.siteUrl}/conta/redefinir/TOKENTOKENTOKENTOKENTOKEN`, minutes: 30 }));
add('senha alterada', 'transactional', mt.passwordChangedMessage(brand, { to: 'a@exemplo.com', name: 'Ana', loginUrl: `${brand.siteUrl}/conta`, when }));
add('a loja gerou link de nova senha', 'transactional', mt.adminResetLinkNoticeMessage(brand, { to: 'a@exemplo.com', name: 'Ana', when, loginUrl: `${brand.siteUrl}/conta` }));
add('novo acesso ao painel', 'transactional', mt.newAdminLoginMessage(brand, { to: 'a@exemplo.com', name: 'Ana', when, device: 'Chrome em Windows', ip: '203.0.113.9', panelUrl: `${brand.siteUrl}/admin` }));
for (const kind of ['order_received', 'order_confirmed', 'order_out_for_delivery', 'order_delivered', 'order_cancelled', 'payment_confirmed', 'payment_refunded']) {
  add(`pedido: ${kind} (entrega)`, 'transactional', tpl.orderMessage(brand, order({ kind })));
  add(`pedido: ${kind} (retirada)`, 'transactional', tpl.orderMessage(brand, order({ kind, delivery: 'pickup', neighborhood: null, deliveryFee: 0, total: 21 })));
}
add('pedido: cancelado (Pix online pago)', 'transactional', tpl.orderMessage(brand, order({ kind: 'order_cancelled', online: true, paymentStatus: 'paid', paymentLabel: 'Pix online' })));
add('pedido: cancelado (Pix online não pago)', 'transactional', tpl.orderMessage(brand, order({ kind: 'order_cancelled', online: true, paymentStatus: 'pending', paymentLabel: 'Pix online' })));
add('pedido: com desconto', 'transactional', tpl.orderMessage(brand, order({ discount: 3, total: 23 })));
add('alerta para o dono', 'transactional', tpl.alertMessage(brand, { to: 'dono@exemplo.com', name: 'Dono', alerts: [{ severity: 'critical', title: 'O servidor recusou a senha', detail: 'Nada sai.', hint: 'Confira SMTP_PASS.' }, { severity: 'warning', title: 'Fila parada', detail: '2 mensagens.', hint: 'Processe a fila.' }], panelUrl: `${brand.siteUrl}/admin/emails` }));
add('promoção (com botão)', 'promotional', tpl.campaignMessage(brand, campaign()));
add('promoção (sem botão)', 'promotional', tpl.campaignMessage(brand, campaign({ ctaLabel: null, ctaUrl: null })));
add('promoção (teste)', 'promotional', tpl.campaignMessage(brand, campaign({ sample: true })));
add('nova senha (exemplo do painel)', 'transactional', mt.passwordResetMessage(brand, { to: 'a@exemplo.com', name: 'Ana', link: `${brand.siteUrl}/conta/recuperar`, minutes: 60, sample: true }));
add('pedido: exemplo do painel', 'transactional', tpl.orderMessage(brand, order({ kind: 'payment_confirmed', online: true, paymentStatus: 'paid', paymentLabel: 'Pix online', sample: true })));

const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const SHORTENERS = /(^|\/\/|\.)(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|cutt\.ly|rebrand\.ly|tiny\.cc|buff\.ly|shorturl\.at)(\/|$)/i;

test(`todos os tipos de e-mail foram cobertos (${ALL.length} mensagens)`, () => {
  assert.ok(ALL.length >= 29, String(ALL.length));
});

test('HTML: documento completo, em português, UTF-8, com meta para celular e modo escuro', () => {
  for (const { name, message: m } of ALL) {
    assert.match(m.html, /^<!doctype html>/i, name);
    assert.match(m.html, /<html lang="pt-BR"/, name);
    assert.match(m.html, /<meta charset="utf-8">/i, name);
    assert.match(m.html, /<meta name="viewport" content="width=device-width,initial-scale=1">/, name);
    assert.match(m.html, /<meta name="color-scheme" content="light dark">/, name);
    assert.match(m.html, /@media \(max-width:520px\)/, `${name}: ajuste para celular`);
    assert.match(m.html, /@media \(prefers-color-scheme:dark\)/, `${name}: modo escuro`);
    assert.ok(m.html.includes(`<title>${m.subject.replace(/&/g, '&amp;')}</title>`), `${name}: o título do documento é o assunto`);
  }
});

test('HTML: layout em tabelas com role="presentation" e estilos inline (o que Outlook e Gmail aceitam), largura máxima de 560 px', () => {
  for (const { name, message: m } of ALL) {
    const tables = [...m.html.matchAll(/<table\b[^>]*>/g)].map((t) => t[0]);
    assert.ok(tables.length >= 3, name);
    assert.ok(tables.every((t) => /role="presentation"/.test(t)), `${name}: toda tabela de layout leva role="presentation"`);
    assert.match(m.html, /max-width:560px/, name);
    assert.ok(!/<(div|span|p)[^>]*\sstyle="[^"]*display:\s*(flex|grid)/i.test(m.html), `${name}: sem flex/grid (não funcionam nos leitores de e-mail)`);
    assert.ok(!/\bfont:\s*\d/.test(m.html), `${name}: sem a abreviação "font:" (o Outlook para Windows a ignora)`);
  }
});

test('HTML: nada ativo nem de rastreio — sem script, formulário, iframe, folha de estilo externa, @import, pixel ou imagem de terceiros', () => {
  for (const { name, message: m } of ALL) {
    for (const forbidden of [/<script/i, /<form/i, /<iframe/i, /<object/i, /<embed/i, /<link\b/i, /@import/i, /javascript:/i, /\bon[a-z]+\s*=/i, /<video/i, /<audio/i]) assert.ok(!forbidden.test(m.html), `${name}: ${forbidden}`);
    assert.ok(!/url\(\s*['"]?https?:/i.test(m.html), `${name}: sem imagem de fundo remota`);
    const imgs = [...m.html.matchAll(/<img\b[^>]*>/g)].map((i) => i[0]);
    assert.equal(imgs.length, 1, `${name}: uma única imagem (a logo)`);
    assert.match(imgs[0], new RegExp(`src="${brand.logoUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`), `${name}: a logo vem do próprio site`);
    assert.match(imgs[0], /alt="Copo Cheio"/, `${name}: a logo tem texto alternativo (aparece quando o leitor bloqueia imagens)`);
    assert.match(imgs[0], /width="\d+" height="\d+"/, `${name}: a logo tem tamanho declarado`);
    assert.ok(!/width="1"|height="1"/.test(m.html), `${name}: sem pixel 1×1`);
  }
});

test('links: todos https, do próprio site ou dos contatos da loja, sem encurtador e sem endereço com usuário/senha', () => {
  const allowed = new Set([new URL(brand.siteUrl).host, 'wa.me', 'instagram.com']);
  for (const { name, message: m } of ALL) {
    const links = hrefs(m.html).map((h) => h.replace(/&amp;/g, '&'));
    assert.ok(links.length >= 2, name);
    for (const link of links) {
      const url = new URL(link);
      assert.equal(url.protocol, 'https:', `${name}: ${link}`);
      assert.ok(allowed.has(url.host), `${name}: host inesperado ${url.host}`);
      assert.ok(!url.username && !url.password, `${name}: ${link}`);
      assert.ok(!SHORTENERS.test(link), `${name}: encurtador em ${link}`);
    }
  }
});

test('texto simples: existe, não tem HTML, e traz todos os links do HTML (quem não vê HTML ainda consegue agir)', () => {
  for (const { name, message: m } of ALL) {
    assert.ok(m.text.length > 100, name);
    assert.ok(!/<\/?[a-z][^>]*>/i.test(m.text), `${name}: texto sem tags`);
    assert.ok(!/&(amp|lt|gt|quot|#39);/.test(m.text), `${name}: texto sem entidades HTML`);
    const textLinks = new Set([...m.text.matchAll(/https:\/\/[^\s)]+/g)].map((x) => x[0]));
    const mustHave = hrefs(m.html).map((h) => h.replace(/&amp;/g, '&')).filter((h) => !h.startsWith(`${brand.siteUrl}/api/email/unsubscribe/`));
    for (const link of mustHave) assert.ok(textLinks.has(link), `${name}: o texto não traz ${link}`);
    assert.match(m.text, /Copo Cheio/, name);
  }
});

test('tamanho: o HTML fica bem abaixo dos ~102 KB em que o Gmail corta a mensagem', () => {
  for (const { name, message: m } of ALL) assert.ok(Buffer.byteLength(m.html) < 60_000, `${name}: ${Buffer.byteLength(m.html)} bytes`);
});

test('assunto: claro, sem gritaria, sem "Re:/Fwd:", sem excesso de pontuação e curto o bastante para o celular', () => {
  for (const { name, message: m } of ALL) {
    const subject = m.subject;
    assert.ok(subject.length >= 8 && subject.length <= 90, `${name}: ${subject.length} caracteres`);
    assert.ok(!/^\s*(re|res|fw|fwd|enc)\s*:/i.test(subject), `${name}: ${subject}`);
    const letters = subject.replace(/[^\p{L}]/gu, '');
    assert.ok(letters.replace(/[^\p{Lu}]/gu, '').length / letters.length < 0.5, `${name}: maiúsculas demais`);
    assert.ok((subject.match(/[!?]/g) ?? []).length <= 1, `${name}: pontuação demais`);
    assert.ok(!/[\r\n]/.test(subject), `${name}: quebra de linha no assunto (injeção de cabeçalho)`);
    assert.ok(!/\b(grátis|gratis|ganhe|100% garantido|clique aqui|urgente|dinheiro fácil)\b/i.test(subject), `${name}: palavra de spam clássica`);
  }
});

test('assunto de pedido: número do pedido e nome da loja (reconhecível no meio da caixa de entrada)', () => {
  for (const { name, message: m } of ALL.filter((x) => x.name.startsWith('pedido:'))) {
    assert.match(m.subject, /#1001/, name);
    assert.match(m.subject, /– Copo Cheio$/, name);
  }
});

test('resumo (preheader): existe, é texto da própria mensagem e não passa de ~140 caracteres', () => {
  for (const { name, message: m } of ALL) {
    const pre = /<div style="display:none;[^>]*>([^<]*?)(?:&#847;|&zwnj;|&nbsp;)/.exec(m.html)?.[1];
    assert.ok(pre && pre.length >= 10 && pre.length <= 160, `${name}: ${pre}`);
  }
});

test('segurança do conteúdo: nome, itens, bairro e texto de campanha com HTML/aspas são escapados', () => {
  const evil = '<script>alert(1)</script> "x" & <img src=x onerror=alert(2)>';
  const o = tpl.orderMessage(brand, order({ name: evil, lines: [{ qty: 1, name: evil, total: 1 }], neighborhood: evil, paymentLabel: evil }));
  const c = tpl.campaignMessage(brand, campaign({ title: evil, body: `${evil}\n\n${evil}`, preheader: evil, subject: 'Promo segura' }));
  for (const m of [o, c]) {
    assert.ok(!/<script/i.test(m.html) && !/<img src=x/i.test(m.html) && !/onerror=alert/.test(m.html.replace(/&lt;img src=x onerror=alert\(2\)&gt;/g, '')), 'HTML escapado');
    assert.ok(m.html.includes('&lt;script&gt;'), 'o texto aparece, mas inofensivo');
    assert.equal([...m.html.matchAll(/<img\b/g)].length, 1, 'continua só a logo');
  }
});

test('segurança do conteúdo: botão com endereço que não é https (javascript:, data:, http) nem aparece', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html;base64,AAAA', 'ftp://exemplo.com/x', '//exemplo.com/x', 'exemplo.com/x']) {
    const m = tpl.campaignMessage(brand, campaign({ ctaUrl: bad }));
    assert.ok(!m.html.includes(bad) && !m.text.includes(bad), `${bad} não pode virar link`);
  }
});

test('transacional: SEM cabeçalho de descadastro de promoção; pedido traz o link para não receber avisos de pedido neste endereço', () => {
  for (const { name, kind, message: m } of ALL.filter((x) => x.kind === 'transactional')) {
    assert.ok(!m.headers?.['List-Unsubscribe'] && !m.headers?.['List-Unsubscribe-Post'], name);
  }
  for (const { name, message: m } of ALL.filter((x) => x.name.startsWith('pedido:'))) {
    assert.match(m.html, /Não quero e-mails sobre pedidos neste endereço/, name);
    assert.ok(m.text.includes('/conta/emails/'), `${name}: link também no texto`);
    assert.match(m.text, /Você recebeu este e-mail porque este endereço foi informado num pedido/, name);
  }
});

test('promoção: List-Unsubscribe (https, entre < >) e List-Unsubscribe-Post (RFC 8058), "Cancelar inscrição" no rodapé e o motivo de a pessoa receber', () => {
  for (const { name, message: m } of ALL.filter((x) => x.kind === 'promotional')) {
    assert.match(m.headers['List-Unsubscribe'], /^<https:\/\/loja\.exemplo\.com\.br\/api\/email\/unsubscribe\/[0-9a-f-]{36}_[0-9a-f]{32}>$/, name);
    assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click', name);
    assert.match(m.html, /Cancelar inscrição/, name);
    assert.match(m.text, /Cancelar inscrição: https:\/\/loja\.exemplo\.com\.br\/conta\/emails\//, name);
    assert.match(m.text, /Você recebe este e-mail porque pediu para receber novidades e promoções de Copo Cheio/, name);
    assert.ok(!m.headers['Auto-Submitted'], `${name}: promoção não é e-mail automático`);
  }
});

test('promoção de teste é marcada como teste no assunto e no topo; a real não', () => {
  const real = ALL.find((x) => x.name === 'promoção (com botão)').message;
  const sample = ALL.find((x) => x.name === 'promoção (teste)').message;
  assert.ok(sample.subject.startsWith('[Teste] ') && /Ninguém mais recebeu/.test(sample.text), sample.subject);
  assert.ok(!real.subject.startsWith('[Teste]') && !/Ninguém mais recebeu/.test(real.text));
});

test('textos de pedido: entrega diz "entrega", retirada diz "retirar/retirada"; cancelado por falta de pagamento diz que nada foi cobrado', () => {
  const find = (n) => ALL.find((x) => x.name === n).message;
  assert.match(find('pedido: order_out_for_delivery (entrega)').subject, /saiu para entrega/);
  assert.match(find('pedido: order_out_for_delivery (retirada)').subject, /pronto para retirar/);
  assert.match(find('pedido: order_delivered (entrega)').subject, /entregue/);
  assert.match(find('pedido: order_delivered (retirada)').subject, /retirado/);
  assert.match(find('pedido: cancelado (Pix online não pago)').text, /nada foi cobrado/);
  assert.match(find('pedido: cancelado (Pix online pago)').text, /devolução do valor/);
  assert.ok(!/nada foi cobrado|devolução do valor/.test(find('pedido: order_cancelled (entrega)').text), 'cancelamento comum não promete reembolso nem diz que nada foi cobrado');
});

test('dados mínimos: o e-mail de pedido não leva telefone, endereço completo, troco nem observações — só o bairro', () => {
  for (const { name, message: m } of ALL.filter((x) => x.name.startsWith('pedido:'))) {
    assert.ok(!/\(\d{2}\)\s?\d{4,5}-\d{4}/.test(m.text.replace('(34) 99128-3384', '')), `${name}: telefone do cliente`);
    assert.ok(!/Rua das Flores, 10/.test(m.text.split('--')[0]), `${name}: endereço no corpo`);
    assert.ok(!/troco|observa/i.test(m.text), name);
  }
});

test('valores em reais no formato brasileiro', () => {
  assert.equal(tpl.brl(17), 'R$ 17,00');
  assert.equal(tpl.brl(1234.5), 'R$ 1.234,50');
  assert.equal(tpl.brl(0.3), 'R$ 0,30');
});

test('exemplos do painel (botão "Enviar exemplos para mim"): "[Teste]" no assunto e o aviso no topo; sem "sample", nenhum dos dois', () => {
  const reset = (sample) => mt.passwordResetMessage(brand, { to: 'a@exemplo.com', name: 'Ana', link: `${brand.siteUrl}/conta/recuperar`, minutes: 60, sample });
  const paid = (sample) => tpl.orderMessage(brand, order({ kind: 'payment_confirmed', online: true, paymentStatus: 'paid', paymentLabel: 'Pix online', sample }));
  for (const make of [reset, paid]) {
    const on = make(true);
    const off = make(undefined);
    assert.match(on.subject, /^\[Teste\] /);
    assert.doesNotMatch(off.subject, /\[Teste\]/);
    assert.match(on.text, /Mensagem de teste enviada pelo painel/);
    assert.match(on.html, /Mensagem de teste enviada pelo painel/);
    assert.doesNotMatch(off.text, /Mensagem de teste/);
    assert.doesNotMatch(off.html, /Mensagem de teste/);
  }
  // O exemplo de nova senha aponta para uma página fixa, nunca para um endereço com chave que funcione.
  assert.doesNotMatch(reset(true).html, /\/conta\/redefinir\/[A-Za-z0-9_-]{8,}/);
});

test('taxa paga pelo cliente no e-mail do pedido: "Taxa de serviço do Pix" no Pix, "Taxa de processamento do cartão" no cartão, e nada quando não há taxa', () => {
  const pix = tpl.orderMessage(brand, order({ kind: 'order_received', online: true, paymentLabel: 'Pix online', delivery: 'pickup', neighborhood: null, deliveryFee: 0, subtotal: 25, paymentFee: 0.63, paymentFeeLabel: 'Taxa de serviço do Pix', total: 25.63 }));
  assert.match(pix.html, /Taxa de serviço do Pix/);
  assert.match(pix.html, /R\$ 0,63/);
  assert.match(pix.html, /R\$ 25,63/);
  assert.doesNotMatch(pix.html, /Taxa de processamento do cartão/);
  assert.match(pix.text, /Taxa de serviço do Pix/);
  const card = tpl.orderMessage(brand, order({ kind: 'order_received', online: true, paymentLabel: 'Cartão online', delivery: 'pickup', neighborhood: null, deliveryFee: 0, subtotal: 100, paymentFee: 6.07, total: 106.07 }));
  assert.match(card.html, /Taxa de processamento do cartão/);
  const none = tpl.orderMessage(brand, order({ kind: 'order_received', online: true, paymentLabel: 'Pix online', delivery: 'pickup', neighborhood: null, deliveryFee: 0, subtotal: 21, total: 21 }));
  assert.doesNotMatch(none.html, /Taxa de serviço|Taxa de processamento/);
});

test('código para entrar: o código está no assunto e no texto, vale 10 minutos, avisa "Não foi você?" e NÃO traz botão nem link de acesso', () => {
  const m = mt.loginCodeMessage(brand, { to: 'a@exemplo.com', name: 'ana maria', code: '654321', codeMinutes: 10 });
  assert.match(m.subject, /^654321 é o seu código para entrar – /);
  assert.match(m.text, /654321/);
  assert.match(m.text, /10 minutos/);
  assert.match(m.text, /Não foi você\?/);
  assert.match(m.text, /Olá, Ana!/);
  // Não existe link de "entrar com um clique": o código só vale digitado na tela do site, do mesmo navegador que informou a senha.
  assert.ok(!/\/conta\/(verificar|redefinir)\//.test(m.html), 'sem link de confirmação nem de senha');
  assert.ok(!/<a [^>]*class="[^"]*button/i.test(m.html) && !/role="button"/i.test(m.html), 'sem botão');
  const sample = mt.loginCodeMessage(brand, { to: 'a@exemplo.com', name: 'Ana', code: '123456', codeMinutes: 10, sample: true });
  assert.match(sample.subject, /^\[Teste\] /);
  assert.match(sample.text, /Mensagem de teste enviada pelo painel/);
});
