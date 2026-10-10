// Layout dos e-mails da Copo Cheio: UM cabeçalho, UM rodapé, UMA paleta e UMA tipografia para todos.
//
// Cada e-mail só descreve o seu conteúdo (título, texto, código, botão...) em `EmailContent`; este arquivo monta o HTML e a
// versão em texto simples. Para criar um e-mail novo, veja `mailTemplates.ts` (e a seção "E-mails" do README).
//
// O HTML segue o que os leitores de e-mail aceitam: tabelas, estilos inline (sem a abreviação `font:`, que o Outlook ignora),
// nada de JavaScript, uma única imagem (a logo, por endereço público) e nenhum pixel de rastreamento. Já funciona sem CSS
// embutido; o <style> só acrescenta o modo escuro e o ajuste para celular nos leitores que o entendem.
import type { Brand } from './mailBrand.js';
import type { Message } from './mail.js';

// ---- Conteúdo ------------------------------------------------------------------------------------------

export type Block =
  // Parágrafo centralizado. **negrito** vira <strong>.
  | { kind: 'text'; text: string; tone?: 'normal' | 'muted' }
  // Código em destaque (só dígitos/letras), com rótulo e uma observação (validade) logo abaixo.
  | { kind: 'code'; label: string; value: string; note?: string }
  // Botão principal.
  | { kind: 'button'; label: string; url: string }
  // "Se o botão não funcionar...": texto + o endereço por extenso, para copiar e colar. Na versão em texto simples o endereço já
  // aparece na linha do botão, então `plainText` (se existir) substitui texto + endereço repetido.
  | { kind: 'link'; text: string; url: string; plainText?: string }
  // Faixa discreta (segurança, aviso).
  | { kind: 'notice'; text: string };

export type EmailContent = {
  to: string;
  subject: string;
  // Texto que aparece ao lado do assunto na lista da caixa de entrada.
  preheader: string;
  eyebrow?: string;
  title: string;
  // Saudação logo abaixo do título (o nome entra com **negrito**).
  greeting?: string;
  blocks: Block[];
  // Por que a pessoa recebeu este e-mail (linha pequena no rodapé).
  reason: string;
  // Faixa de aviso no topo do cartão (usada só nos e-mails de teste).
  banner?: string;
};

// ---- Identidade visual ---------------------------------------------------------------------------------

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',ui-monospace,Menlo,Consolas,'Roboto Mono','Liberation Mono',monospace";

// Azul e preto da logo (os mesmos do site); o resto é um cinza-azulado neutro.
const C = {
  page: '#EAEFF8',
  card: '#FFFFFF',
  line: '#E3E8F3',
  header: '#050505',
  blue: '#145CFF',
  ink: '#0B1020',
  body: '#3B4560',
  muted: '#5F6B87',
  panel: '#EEF3FF',
  panelLine: '#CFDDFF',
  panelLabel: '#4A66AD',
  soft: '#F4F7FC',
  bannerBg: '#FFF6DB',
  bannerLine: '#F2DFA2',
  bannerInk: '#7A5A00',
};

// Modo escuro (Apple Mail, Outlook.com/aplicativo, Samsung...). O Gmail ignora estas regras e escurece sozinho a partir
// das cores claras acima, que foram escolhidas para continuar legíveis quando isso acontece.
const DARK = {
  page: '#090C12',
  card: '#10151F',
  line: '#1E2736',
  ink: '#F4F7FC',
  body: '#C3CCDD',
  muted: '#94A1B9',
  panel: '#0E1B3D',
  panelLine: '#25407F',
  panelLabel: '#9DB6F2',
  digits: '#8DB0FF',
  accent: '#7FA2FF',
  soft: '#0C1118',
  bannerBg: '#2A2208',
  bannerLine: '#5A4710',
  bannerInk: '#F5D77A',
};

// Só para os testes (contraste das cores).
export const PALETTE = { light: C, dark: DARK };

const STYLE = `
:root{color-scheme:light dark;supported-color-schemes:light dark}
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{mso-table-lspace:0;mso-table-rspace:0}
img{-ms-interpolation-mode:bicubic}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
@media (max-width:520px){
.px{padding-left:22px!important;padding-right:22px!important}
.h1{font-size:26px!important;line-height:32px!important}
.code{font-size:34px!important;line-height:42px!important}
.pad-hdr{padding-top:28px!important;padding-bottom:26px!important}
}
@media (prefers-color-scheme:dark){
.c-page{background-color:${DARK.page}!important}
.c-card{background-color:${DARK.card}!important;border-color:${DARK.line}!important}
.c-line{border-color:${DARK.line}!important}
.c-ink{color:${DARK.ink}!important}
.c-body{color:${DARK.body}!important}
.c-muted{color:${DARK.muted}!important}
.c-accent{color:${DARK.accent}!important}
.c-panel{background-color:${DARK.panel}!important;border-color:${DARK.panelLine}!important}
.c-plabel{color:${DARK.panelLabel}!important}
.c-digits{color:${DARK.digits}!important}
.c-soft{background-color:${DARK.soft}!important}
.c-banner{background-color:${DARK.bannerBg}!important;border-color:${DARK.bannerLine}!important;color:${DARK.bannerInk}!important}
}
[data-ogsc] .c-ink{color:${DARK.ink}!important}
[data-ogsc] .c-body{color:${DARK.body}!important}
[data-ogsc] .c-muted{color:${DARK.muted}!important}
[data-ogsc] .c-accent{color:${DARK.accent}!important}
[data-ogsc] .c-plabel{color:${DARK.panelLabel}!important}
[data-ogsc] .c-digits{color:${DARK.digits}!important}
[data-ogsb] .c-page{background-color:${DARK.page}!important}
[data-ogsb] .c-card{background-color:${DARK.card}!important}
[data-ogsb] .c-panel{background-color:${DARK.panel}!important}
[data-ogsb] .c-soft{background-color:${DARK.soft}!important}
`.replace(/\n/g, '');

// ---- Peças ---------------------------------------------------------------------------------------------

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// **negrito** → <strong> (depois de escapar, então nenhum HTML de fora passa).
const rich = (value: string) =>
  esc(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:700;">$1</strong>')
    // "e-mail" não quebra no hífen (ficava "e-" numa linha e "mail" na outra).
    .replace(/e-mail/gi, '<span style="white-space:nowrap;">$&</span>');
const plain = (value: string) => value.replace(/\*\*(.+?)\*\*/g, '$1');
const upper = (value: string) => value.toLocaleUpperCase('pt-BR');
// "Copo Cheio Disk Bebidas" (sem espaço sobrando quando a loja não tem slogan).
const signature = (brand: Brand) => [brand.name, brand.tagline].filter(Boolean).join(' ');
// Só endereços http(s) viram link.
const safeUrl = (url: string) => (/^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : '');

// Fonte por extenso (family/size/line-height/weight): o Outlook para Windows ignora a abreviação `font:`.
const font = (weight: number, size: number, line: number, family = FONT) => `font-family:${family};font-size:${size}px;line-height:${line}px;font-weight:${weight};`;

const row = (inner: string, padding = '0 40px 24px') => `<tr><td class="px" align="center" style="padding:${padding};">${inner}</td></tr>`;

function paragraph(text: string, tone: 'normal' | 'muted' = 'normal', size?: { px: number; line: number }): string {
  const muted = tone === 'muted';
  const { px, line } = size ?? (muted ? { px: 13, line: 20 } : { px: 16, line: 25 });
  return `<p class="${muted ? 'c-muted' : 'c-body'}" style="margin:0 auto;max-width:440px;${font(400, px, line)}color:${muted ? C.muted : C.body};text-align:center;text-wrap:balance;">${rich(text)}</p>`;
}

function codeBlock(b: Extract<Block, { kind: 'code' }>): string {
  const note = b.note ? `<p class="c-muted" style="margin:14px 0 0;${font(400, 14, 21)}color:${C.muted};text-align:center;text-wrap:balance;">${rich(b.note)}</p>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="c-panel" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.panelLine};border-radius:20px;">
<tr><td align="center" class="c-plabel" style="padding:20px 16px 4px;${font(700, 11, 14)}letter-spacing:.16em;color:${C.panelLabel};">${esc(upper(b.label))}</td></tr>
<tr><td align="center" class="c-digits code" style="padding:2px 16px 24px;${font(800, 44, 52, MONO)}letter-spacing:.3em;text-indent:.3em;color:${C.blue};"><span style="white-space:nowrap;">${esc(b.value)}</span></td></tr>
</table>${note}`;
}

// Botão "à prova de Outlook": no Outlook para Windows vira um retângulo arredondado em VML; nos demais, um link com
// fundo e cantos arredondados. Se o Outlook ignorar o VML, o texto continua clicável.
function button(b: Extract<Block, { kind: 'button' }>): string {
  const url = esc(safeUrl(b.url));
  const width = Math.max(220, Math.min(420, b.label.length * 10 + 88));
  return `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${C.blue}" style="border-radius:999px;background:${C.blue};">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:52px;v-text-anchor:middle;width:${width}px;" arcsize="50%" stroke="f" fillcolor="${C.blue}"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${esc(b.label)}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${url}" target="_blank" style="display:inline-block;padding:16px 38px;${font(700, 16, 20)}color:#FFFFFF;text-decoration:none;border-radius:999px;background:${C.blue};">${esc(b.label)}</a><!--<![endif]-->
</td></tr></table>`;
}

function linkBlock(b: Extract<Block, { kind: 'link' }>): string {
  const url = safeUrl(b.url);
  return `${paragraph(b.text, 'muted')}<p style="margin:10px 0 0;${font(400, 12, 18, MONO)}text-align:center;word-break:break-all;"><a href="${esc(url)}" target="_blank" class="c-accent" style="color:${C.blue};text-decoration:underline;">${esc(url)}</a></p>`;
}

function notice(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="c-soft" bgcolor="${C.soft}" style="background:${C.soft};border-radius:14px;border-left:3px solid ${C.blue};"><tr><td class="c-body" align="left" style="padding:14px 16px;${font(400, 13, 20)}color:${C.body};text-align:left;">${rich(text)}</td></tr></table>`;
}

const divider = () =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="c-line" style="border-top:1px solid ${C.line};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table><div style="height:22px;line-height:22px;font-size:0;">&nbsp;</div>`;

function renderBlock(block: Block): string {
  if ((block.kind === 'button' || block.kind === 'link') && !safeUrl(block.url)) return '';
  switch (block.kind) {
    case 'text':
      return row(paragraph(block.text, block.tone), '0 40px 22px');
    case 'code':
      return row(codeBlock(block), '0 40px 28px');
    case 'button':
      return row(button(block), '0 40px 30px');
    case 'link':
      return row(divider() + linkBlock(block), '0 40px 26px');
    case 'notice':
      return row(notice(block.text), '0 40px 36px');
  }
}

function footerHtml(brand: Brand, reason: string): string {
  const link = (url: string, text: string) => `<a href="${esc(url)}" target="_blank" class="c-accent" style="color:${C.blue};text-decoration:none;font-weight:600;">${text}</a>`;
  // Um contato por linha: funciona em qualquer largura de tela, sem quebrar no meio de um número.
  const lines = [
    ...brand.contacts.filter((c) => c.url).map((c) => `<span class="c-muted" style="color:${C.muted};">${esc(c.label)}</span>&nbsp; ${link(c.url!, esc(c.text))}`),
    `<span class="c-muted" style="color:${C.muted};">Site</span>&nbsp; ${link(brand.siteUrl, esc(brand.siteHost))}`,
  ];
  const place = brand.contacts.find((c) => !c.url);
  // O endereço quebra só nas vírgulas (nunca no meio do CEP ou do número).
  const placeHtml = place ? place.text.split(', ').map((part) => `<span style="white-space:nowrap;">${esc(part)}</span>`).join(', ') : '';
  return `<tr><td class="c-soft c-line px" align="center" bgcolor="${C.soft}" style="padding:28px 40px 30px;background:${C.soft};border-top:1px solid ${C.line};border-radius:0 0 24px 24px;">
<p class="c-ink" style="margin:0;${font(800, 15, 20)}color:${C.ink};">${esc(brand.name)}</p>
${brand.tagline ? `<p class="c-muted" style="margin:3px 0 0;${font(700, 10, 14)}letter-spacing:.2em;color:${C.muted};">${esc(upper(brand.tagline))}</p>` : ''}
<p style="margin:16px 0 0;${font(400, 13, 24)}">${lines.join('<br>')}</p>
${place ? `<p class="c-muted" style="margin:10px 0 0;${font(400, 12, 18)}color:${C.muted};">${placeHtml}</p>` : ''}
<p class="c-muted" style="margin:18px 0 0;${font(400, 11, 17)}color:${C.muted};">${esc(reason)}<br>© ${brand.year} ${esc(signature(brand))}</p>
</td></tr>`;
}

// ---- HTML ----------------------------------------------------------------------------------------------

export function renderHtml(brand: Brand, content: EmailContent): string {
  // Espaço "invisível" depois do resumo, para a lista da caixa de entrada não puxar texto do corpo do e-mail.
  const filler = '&#847;&zwnj;&nbsp;'.repeat(60);
  return `<!doctype html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(content.subject)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>${STYLE}</style>
</head>
<body id="body" class="c-page" style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${esc(content.preheader)}${filler}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="c-page" bgcolor="${C.page}" style="background:${C.page};">
<tr><td align="center" style="padding:28px 12px 36px;">
<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="c-card" bgcolor="${C.card}" style="max-width:560px;background:${C.card};border:1px solid ${C.line};border-radius:24px;overflow:hidden;box-shadow:0 12px 32px rgba(11,16,32,.08);">
<tr><td class="pad-hdr" align="center" bgcolor="${C.header}" style="padding:36px 24px 32px;background:${C.header};border-radius:24px 24px 0 0;"><a href="${esc(brand.siteUrl)}" target="_blank" style="text-decoration:none;"><img src="${esc(brand.logoUrl)}" width="128" height="128" alt="${esc(brand.name)}" style="display:block;margin:0 auto;width:128px;height:128px;border:0;outline:none;border-radius:64px;${font(800, 22, 28)}color:#FFFFFF;text-align:center;"></a></td></tr>
<tr><td height="4" bgcolor="${C.blue}" style="height:4px;line-height:4px;font-size:4px;background:${C.blue};">&nbsp;</td></tr>
${content.banner ? `<tr><td class="c-banner px" align="center" bgcolor="${C.bannerBg}" style="padding:12px 40px;background:${C.bannerBg};border-bottom:1px solid ${C.bannerLine};${font(600, 13, 19)}color:${C.bannerInk};text-align:center;">${esc(content.banner)}</td></tr>` : ''}
<tr><td class="px" align="center" style="padding:40px 40px ${content.greeting ? 0 : 18}px;">
${content.eyebrow ? `<p class="c-accent" style="margin:0 0 10px;${font(700, 12, 16)}letter-spacing:.16em;color:${C.blue};">${esc(upper(content.eyebrow))}</p>` : ''}
<h1 class="c-ink h1" style="margin:0;${font(800, 30, 36)}letter-spacing:-.02em;color:${C.ink};">${esc(content.title)}</h1>
</td></tr>
${content.greeting ? row(paragraph(content.greeting, 'normal', { px: 17, line: 26 }), '14px 40px 14px') : ''}
${content.blocks.map(renderBlock).join('\n')}
${footerHtml(brand, content.reason)}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

// ---- Texto simples -------------------------------------------------------------------------------------

export function renderText(brand: Brand, content: EmailContent): string {
  const out: string[] = [];
  const identity = `${brand.name}${brand.tagline ? ` · ${brand.tagline}` : ''}`;
  out.push(identity, '');
  if (content.banner) out.push(`[${content.banner}]`, '');
  if (content.eyebrow) out.push(upper(content.eyebrow));
  out.push(content.title, '');
  if (content.greeting) out.push(plain(content.greeting), '');
  for (const block of content.blocks) {
    if ((block.kind === 'button' || block.kind === 'link') && !safeUrl(block.url)) continue;
    switch (block.kind) {
      case 'text':
        out.push(plain(block.text), '');
        break;
      case 'code':
        out.push(`${upper(block.label)}:`, '', `    ${block.value}`, '');
        if (block.note) out.push(plain(block.note), '');
        break;
      case 'button':
        out.push(`${block.label}:`, safeUrl(block.url), '');
        break;
      case 'link':
        if (block.plainText) out.push(plain(block.plainText), '');
        else out.push(plain(block.text), safeUrl(block.url), '');
        break;
      case 'notice':
        out.push(plain(block.text), '');
        break;
    }
  }
  out.push('--', identity);
  for (const c of brand.contacts) out.push(c.url ? `${c.label}: ${c.text} – ${c.url}` : `${c.label}: ${c.text}`);
  out.push(`Site: ${brand.siteUrl}`, '', content.reason, `© ${brand.year} ${signature(brand)}`);
  return out.join('\n');
}

// Monta o e-mail pronto para o envio (assunto, HTML e texto).
export function renderEmail(brand: Brand, content: EmailContent): Message {
  return { to: content.to, subject: content.subject, html: renderHtml(brand, content), text: renderText(brand, content) };
}
