// Design e conteúdo dos e-mails (layout único da marca): estrutura do HTML, dados reais da loja no rodapé, logo,
// e-mail de teste do painel, aviso de conta existente e contraste das cores. Usa o servidor de teste real
// (SMTP de mentira) — o e-mail analisado é exatamente o que o sistema envia.
// usage: bash tests/fresh.sh && node tests/api-test6.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Client, check, clearMail, codeFrom, linkFrom, mailsTo, section, summary } from './lib.mjs';

const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-c', sql], { encoding: 'utf8' }).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const PASS = 'senha-boa-123';
let seq = 0;
const fresh = (prefix = 'design') => `${prefix}${++seq}@exemplo.com`;

const here = fileURLToPath(new URL('.', import.meta.url));
import { writeFileSync } from 'node:fs';
writeFileSync(join(here, 'build/design-entry.ts'), "export * from '../../server/mailLayout.ts';\nexport * from '../../server/mailTemplates.ts';\nexport * from '../../server/mailBrand.ts';\n");
await build({ entryPoints: [join(here, 'build/design-entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(here, 'build/design-bundle.mjs'), logLevel: 'error' });
const { PALETTE, greetingName, verificationMessage, buildBrand, formatWhatsapp } = await import(`./build/design-bundle.mjs?${Date.now()}`);

// ---- análise do HTML -------------------------------------------------------------------------------------
function analyze(html) {
  const VOID = new Set(['meta', 'img', 'br', 'hr', 'input', 'link', 'col', 'area', 'base', 'source']);
  const stack = [];
  const problems = [];
  const tags = {};
  const imgs = [];
  const links = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        tags[name] = (tags[name] ?? 0) + 1;
        if (name === 'img') imgs.push(attrs);
        if (name === 'a') links.push(attrs.href ?? '');
        if (!VOID.has(name)) stack.push(name);
      },
      onclosetag(name, implied) {
        if (VOID.has(name)) return;
        const top = stack.pop();
        if (top !== name) problems.push(`</${name}> fechou, mas o aberto era <${top}>`);
        else if (implied) problems.push(`</${name}> foi fechado sozinho`);
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  if (stack.length) problems.push(`sem fechar: ${stack.join(',')}`);
  return { problems, tags, imgs, links };
}

async function signUp(name = 'leandro silva', email = fresh()) {
  const c = new Client();
  const r = await c.post('/api/account/register', { name, email, phone: '34999990000', password: PASS });
  const list = await mailsTo(email);
  const mail = list[list.length - 1];
  return { c, r, email, mail, code: codeFrom(mail), link: linkFrom(mail) };
}

await clearMail();
const owner = new Client();
await owner.login();
const SITE = 'http://127.0.0.1:4180'; // fora da Vercel só o endereço local vale (http); na Vercel o x-forwarded-proto (https) sempre vem
// Texto visível do e-mail: tags de texto em linha (span, strong, a...) somem sem deixar espaço; as de bloco viram espaço.
const textOf = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(span|strong|a|b|i|em)\b[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&zwnj;|&#847;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

// ------------------------------------------------------------------------------------------------------
section('1. E-mail de verificação: estrutura do HTML (sem dados de contato cadastrados)');
const A = await signUp('leandro silva');
const html = A.mail.html;
const info = analyze(html);
check('cadastro envia 1 e-mail, só para o endereço informado', A.r.status === 202 && (await mailsTo(A.email)).length === 1);
check('HTML bem formado: todas as tags abrem e fecham na ordem certa', info.problems.length === 0, info.problems.slice(0, 5));
check('HTML leve (Gmail corta acima de ~100 KB): menos de 40 KB', Buffer.byteLength(html) < 40_000, Buffer.byteLength(html));
check('sem JavaScript, formulário, iframe, objeto nem fonte/CSS externos', !/<script|<form|<iframe|<object|<embed|<link\b|@import|javascript:|onerror=|onclick=|url\(/i.test(html));
check('uma única imagem: a logo oficial, no endereço público do site, 128×128, com texto alternativo', info.imgs.length === 1 && info.imgs[0].src === `${SITE}/email/logo.png` && info.imgs[0].width === '128' && info.imgs[0].height === '128' && info.imgs[0].alt === 'Copo Cheio', info.imgs);
check('nenhum pixel de rastreamento e nenhum recurso externo além da logo', !/<img[^>]+(width="1"|height="1")/i.test(html) && (html.match(/https?:\/\/[^"'\s)]+\.(png|jpe?g|gif|webp|svg|css|woff2?)/gi) ?? []).every((u) => u === `${SITE}/email/logo.png`));
check('todos os links são http(s) (nenhum mailto:, tel: ou javascript:)', info.links.length >= 3 && info.links.every((l) => /^https?:\/\//.test(l)), info.links);
check('tabelas de layout marcadas como apresentação (acessibilidade) e idioma pt-BR', /<html lang="pt-BR"/.test(html) && (html.match(/role="presentation"/g) ?? []).length >= 6);
check('suporte a modo escuro e a celular declarado (color-scheme + prefers-color-scheme + media query)', /<meta name="color-scheme" content="light dark">/.test(html) && /prefers-color-scheme:dark/.test(html) && /max-width:520px/.test(html));
check('compatível com o Outlook: botão em VML, fonte por extenso (sem "font:" abreviado) e largura fixa por tabela fantasma', /<v:roundrect/.test(html) && !/style="[^"]*[;"\s]font:/.test(html) && /<!--\[if mso\]><table[^>]*width="560"/.test(html));
check('visual claro por padrão (cores inline em todos os blocos) — não depende do <style>', /bgcolor="#FFFFFF"/.test(html) && /bgcolor="#050505"/.test(html) && /bgcolor="#145CFF"/.test(html));
check('texto de pré-visualização da caixa de entrada traz o código e a validade', new RegExp(`Seu código de confirmação é ${A.code}\\. Ele expira em 15 minutos\\.`).test(html));

// ------------------------------------------------------------------------------------------------------
section('2. E-mail de verificação: conteúdo pedido');
const visible = textOf(html);
check('título "Confirme seu e-mail"', /<h1[^>]*>Confirme seu e-mail<\/h1>/.test(html));
check('saudação personalizada com o primeiro nome (capitalizado): "Olá, Leandro! Que bom ter você com a gente."', /Olá, <strong[^>]*>Leandro<\/strong>! Que bom ter você com a gente\./.test(html) && !/Silva/.test(visible));
check('explica que o código confirma o endereço e ativa a conta', /confirmar o seu endereço de <span[^>]*>e-mail<\/span> e ativar a sua conta/.test(html) || /confirmar o seu endereço de e-mail e ativar a sua conta/.test(visible));
check('código em destaque (bloco próprio), com rótulo, e só os 6 dígitos', new RegExp(`class="c-digits code"[^>]*><span[^>]*>${A.code}</span>`).test(html) && /SEU CÓDIGO DE VERIFICAÇÃO/.test(html));
check('validade: 15 minutos e uso único (das regras do sistema)', /expira em <strong[^>]*>15 minutos<\/strong> e só pode ser usado uma vez/.test(html));
check('botão principal "Confirmar meu e-mail" aponta para o link de confirmação', new RegExp(`<a href="${A.link.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[^>]*>Confirmar meu e-mail</a>`).test(html));
check('alternativa manual: copiar o código e digitar no site, ou colar o endereço (24 horas)', /copie o código acima e digite-o na tela de confirmação do site/.test(visible) && /vale por 24 horas/.test(visible) && html.split(A.link).length >= 4);
check('mensagem discreta de segurança', /não compartilhe este código com ninguém/.test(visible) && /nada será ativado/.test(visible));
check('rodapé: nome e slogan da loja, endereço do site, ano e motivo do e-mail', /Copo Cheio/.test(visible) && /DISK BEBIDAS/.test(html) && html.includes(`>127.0.0.1:4180</a>`) && new RegExp(`© ${new Date().getFullYear()} Copo Cheio Disk Bebidas`).test(visible) && /confirmar um cadastro feito com este endereço/.test(visible));
const store0 = psql(`select coalesce(whatsapp,'-') || '|' || coalesce(instagram,'-') || '|' || coalesce(address,'-') from store_settings`).split('|');
check('o rodapé mostra só o que já está cadastrado no banco (aqui: o Instagram do site original; WhatsApp e endereço vazios, então não aparecem)', store0[1] !== '-' && visible.includes(`@${store0[1]}`) && info.links.includes(`https://instagram.com/${store0[1]}`) && (store0[0] !== '-' || !/WhatsApp|wa\.me/.test(html)) && (store0[2] !== '-' || !/Endereço|Rua /.test(visible)), [store0, visible.slice(-260)]);
const text = A.mail.text;
check('versão em texto simples completa: título, saudação, código, validade, link, segurança, rodapé', /Confirme seu e-mail/.test(text) && /Olá, Leandro! Que bom ter você com a gente\./.test(text) && text.includes(`    ${A.code}`) && /15 minutos e só pode ser usado uma vez/.test(text) && text.includes(A.link) && /não compartilhe este código/.test(text) && /© \d{4} Copo Cheio/.test(text));
check('texto simples sem HTML, sem marcação de negrito e sem o endereço repetido', !/<[a-z][^>]*>/i.test(text) && !/\*\*/.test(text) && text.split(A.link).length === 2);
check('assunto com o código e o nome da loja; remetente configurado; e-mail automático', A.mail.subject === `${A.code} é o seu código de confirmação – Copo Cheio` && /loja@copocheio\.test/.test(A.mail.from) && A.mail.headers['auto-submitted'] === 'auto-generated');

// ------------------------------------------------------------------------------------------------------
section('3. Código e link são dinâmicos e continuam funcionando');
const B = await signUp('Maria');
const C2 = await signUp('Carla');
check('cada cadastro recebe o próprio código e o próprio link (nada fixo no template)', A.code !== undefined && B.link !== A.link && B.link !== C2.link && (B.code !== A.code || B.code !== C2.code) && B.mail.html.includes(`>${B.code}</span>`) && !B.mail.html.includes(A.link) && !B.mail.html.includes(`>${A.code}</span>`));
const brand0 = buildBrand('https://site.exemplo.com.br', { store_name: 'Copo Cheio', tagline: 'Disk Bebidas', whatsapp: null, instagram: null, address: null, city: null, state: null, cep: null, logo_url: null });
const greet = (name) => verificationMessage(brand0, { to: 'a@b.com', name, code: '123456', link: 'https://site.exemplo.com.br/conta/verificar/x', codeMinutes: 15, linkHours: 24 }).text.match(/^Olá.*$/m)[0];
check('saudação: primeiro nome com a inicial maiúscula (leandro silva → Leandro; ÉRICA maria → ÉRICA; joão → João)', greetingName('leandro silva') === 'Leandro' && greetingName('  ÉRICA maria ') === 'ÉRICA' && greetingName('joão') === 'João' && greetingName('McDonald x') === 'McDonald');
check('saudação: sem nome → "Olá! Que bom ter você com a gente."; nome com ** não quebra o negrito; nome enorme é cortado', greet('') === 'Olá! Que bom ter você com a gente.' && greet('**') === 'Olá! Que bom ter você com a gente.' && greet('a**b c') === 'Olá, Ab! Que bom ter você com a gente.' && greetingName('x'.repeat(200)).length === 40);
const unit = verificationMessage(brand0, { to: 'a@b.com', name: 'Ana', code: '123456', link: 'javascript:alert(1)', codeMinutes: 15, linkHours: 24 });
check('endereço que não é http(s) nunca vira link no e-mail (botão e texto)', !/javascript:/.test(unit.html) && !/javascript:/.test(unit.text));
check('formatação do WhatsApp: (34) 99999-0000, fixo (34) 3333-4444 e número de fora com +', formatWhatsapp('5534999990000') === '(34) 99999-0000' && formatWhatsapp('553433334444') === '(34) 3333-4444' && formatWhatsapp('14155550123') === '+14155550123');
const viaCode = await A.c.post('/api/account/verify-email', { email: A.email, code: /class="c-digits code"[^>]*><span[^>]*>(\d{6})</.exec(html)[1] });
check('o código que está NO HTML do e-mail confirma a conta', viaCode.status === 200 && viaCode.data.verified === true, viaCode);
const hrefInHtml = /<a href="([^"]+\/conta\/verificar\/[^"]+)"[^>]*>Confirmar meu e-mail<\/a>/.exec(B.mail.html)[1];
const viaLink = await new Client().post('/api/account/verify-link', { token: hrefInHtml.split('/').pop() });
check('o link do BOTÃO do e-mail confirma a conta', viaLink.status === 200 && viaLink.data.verified === true && viaLink.data.email === B.email, viaLink);
check('o banco continua guardando só hash do código e do link (o e-mail novo não mudou isso)', psql(`select count(*) from email_verifications where email = ${lit(A.email)} and code_hash ~ '^[0-9a-f]{64}$' and link_hash = ${lit(sha(A.link.split('/').pop()))}`) === '1');

// ------------------------------------------------------------------------------------------------------
section('4. Rodapé com dados REAIS da loja (painel → Configurações)');
await owner.patch('/api/admin/store', { whatsapp: null, instagram: null, address: null, city: null, state: null, cep: null });
const N = await signUp('Nenhum');
check('sem NENHUM contato cadastrado: o rodapé tem só nome, slogan e o endereço do site (nada inventado)', !/wa\.me|instagram\.com|WhatsApp|Instagram|Rua |\(\d\d\)/i.test(textOf(N.mail.html) + analyze(N.mail.html).links.join(' ') + N.mail.text) && analyze(N.mail.html).problems.length === 0 && !/Endereço:|WhatsApp:|Instagram:/.test(N.mail.text), textOf(N.mail.html).slice(-200));
await owner.patch('/api/admin/store', { whatsapp: '5534988887777', instagram: 'copocheio', address: 'Rua das Flores, 100', city: 'Uberlândia', state: 'MG', cep: '38400000' });
const D = await signUp('Diego');
const dInfo = analyze(D.mail.html);
const dVisible = textOf(D.mail.html);
check('com WhatsApp, Instagram e endereço cadastrados, o rodapé mostra exatamente eles', /WhatsApp\s+<\/span>?|WhatsApp/.test(dVisible) && dVisible.includes('(34) 98888-7777') && dVisible.includes('@copocheio') && dVisible.includes('Rua das Flores, 100, Uberlândia - MG, 38400-000'));
check('...e os links apontam para os endereços reais (wa.me e instagram.com)', dInfo.links.includes('https://wa.me/5534988887777') && dInfo.links.includes('https://instagram.com/copocheio'), dInfo.links);
check('...inclusive no texto simples', /WhatsApp: \(34\) 98888-7777 – https:\/\/wa\.me\/5534988887777/.test(D.mail.text) && /Instagram: @copocheio – https:\/\/instagram\.com\/copocheio/.test(D.mail.text) && /Endereço: Rua das Flores, 100, Uberlândia - MG, 38400-000/.test(D.mail.text));
check('HTML continua bem formado com os contatos', dInfo.problems.length === 0, dInfo.problems);
await owner.patch('/api/admin/store', { whatsapp: null });
const E = await signUp('Elisa');
const eVisible = textOf(E.mail.html);
check('apagou o WhatsApp no painel: ele some do e-mail seguinte (Instagram e endereço ficam)', !/WhatsApp|wa\.me/.test(E.mail.html + E.mail.text) && eVisible.includes('@copocheio') && eVisible.includes('Rua das Flores'));
await owner.patch('/api/admin/store', { store_name: 'Bar do Zé', tagline: 'Gelada e rápida' });
const F = await signUp('Fabio');
check('nome e slogan da loja vêm do painel (assunto, logo/alt, cabeçalho de texto e rodapé)', F.mail.subject.endsWith('– Bar do Zé') && /alt="Bar do Zé"/.test(F.mail.html) && /GELADA E RÁPIDA/.test(F.mail.html) && /^Bar do Zé · Gelada e rápida/.test(F.mail.text) && /© \d{4} Bar do Zé Gelada e rápida/.test(textOf(F.mail.html)), F.mail.subject);
await owner.patch('/api/admin/store', { store_name: 'A<b>&"\'x', tagline: '<i>t</i>' });
const G = await signUp('Gabi');
check('nome/slogan com HTML são escapados (nada vira marcação)', !/<b>&|<i>t<\/i>/.test(G.mail.html) && /A&lt;b&gt;&amp;&quot;&#39;x/.test(G.mail.html) && analyze(G.mail.html).problems.length === 0);
await owner.patch('/api/admin/store', { store_name: 'Copo Cheio', tagline: 'Disk Bebidas' });

// ------------------------------------------------------------------------------------------------------
section('5. Logo: endereço público, formato seguro e arquivo servido pelo site');
const logoRes = await fetch('http://127.0.0.1:4180/email/logo.png');
const logoBytes = Buffer.from(await logoRes.arrayBuffer());
check('/email/logo.png é servido (200, image/png), leve (< 100 KB) e com 256×256 (2x do tamanho exibido)', logoRes.status === 200 && /image\/png/.test(logoRes.headers.get('content-type')) && logoBytes.length < 100_000 && logoBytes.readUInt32BE(16) === 256 && logoBytes.readUInt32BE(20) === 256, [logoRes.status, logoBytes.length]);
check('...e é PNG de 32 bits com transparência de verdade (RGBA; a logo oficial é um disco com cantos transparentes)', logoBytes.subarray(1, 4).toString() === 'PNG' && logoBytes[25] === 6);
const logoOf = async () => analyze((await signUp('Logo')).mail.html).imgs[0].src;
check('sem logo no painel: usa a logo oficial em PNG do site', (await logoOf()) === `${SITE}/email/logo.png`);
psql(`update site_settings set logo_url = 'https://exemplo.public.blob.vercel-storage.com/site/minha-logo.png' where id = 1`);
check('logo trocada no painel em PNG: o e-mail usa a nova', (await logoOf()) === 'https://exemplo.public.blob.vercel-storage.com/site/minha-logo.png');
psql(`update site_settings set logo_url = 'https://exemplo.public.blob.vercel-storage.com/site/minha-logo.webp' where id = 1`);
check('logo trocada em WebP (o Outlook para Windows não abre): cai para a logo oficial em PNG', (await logoOf()) === `${SITE}/email/logo.png`);
psql(`update site_settings set logo_url = 'javascript:alert(1)//.png' where id = 1`);
check('endereço de logo que não é http(s): ignorado', (await logoOf()) === `${SITE}/email/logo.png`);
psql(`update site_settings set logo_url = null where id = 1`);

// ------------------------------------------------------------------------------------------------------
section('6. E-mail de teste do painel (mesmo layout, código de exemplo)');
await clearMail();
const t = await owner.post('/api/admin/mail/test', {});
const tMails = await mailsTo('dono@copocheio.local');
check('owner envia o teste: 200 e o e-mail chega só para ele', t.status === 200 && t.data.to === 'dono@copocheio.local' && tMails.length === 1, t);
const tm = tMails[0];
check('é o e-mail de confirmação de verdade, marcado como teste no assunto e numa faixa no topo', tm.subject === '[Teste] 123456 é o seu código de confirmação – Copo Cheio' && /Mensagem de teste enviada pelo painel/.test(tm.html) && /Mensagem de teste enviada pelo painel/.test(tm.text) && /Confirme seu e-mail/.test(tm.html) && /Dono/.test(tm.text));
check('...com o mesmo layout (logo, rodapé) e HTML bem formado', analyze(tm.html).problems.length === 0 && analyze(tm.html).imgs.length === 1 && /DISK BEBIDAS/.test(tm.html));
check('o botão do teste leva à tela de entrada do site (não a um link inventado)', analyze(tm.html).links.includes(`${SITE}/conta`) && !/verificar\//.test(tm.html));
const fakeTarget = await signUp('Pendente');
const guess = fakeTarget.code === '123456' ? '654321' : '123456';
check('o código de exemplo (123456) não confirma conta nenhuma', (await new Client().post('/api/account/verify-email', { email: fakeTarget.email, code: guess })).status === 400);
const sec = new Client();
await owner.post('/api/admin/admins', { name: 'Admin Comum', email: 'admin.comum@copocheio.local', password: 'outra-senha-123', role: 'admin' });
await sec.login('admin.comum@copocheio.local', 'outra-senha-123');
check('só o owner envia o teste (administrador comum recebe 403)', (await sec.post('/api/admin/mail/test', {})).status === 403);
const statuses = [];
for (let i = 0; i < 10; i++) statuses.push((await owner.post('/api/admin/mail/test', {})).status);
check('limite de 10 testes por hora (o 11º recebe 429)', statuses.slice(0, 8).every((s) => s === 200) && statuses.includes(429), statuses);

// ------------------------------------------------------------------------------------------------------
section('7. Aviso "você já tem uma conta" no mesmo layout');
await clearMail();
const H = await signUp('Helena');
await new Client().post('/api/account/verify-email', { email: H.email, code: H.code });
await new Client().post('/api/account/register', { name: 'Intruso', email: H.email, phone: '34999990000', password: 'outra-senha-9999' });
const hm = (await mailsTo(H.email)).at(-1);
const hInfo = analyze(hm.html);
check('aviso enviado só para o dono do e-mail, com assunto próprio', /^Você já tem uma conta em Copo Cheio$/.test(hm.subject) && hm.to.length === 1 && hm.to[0] === H.email);
check('mesmo cabeçalho/rodapé (logo, azul da marca, contatos), HTML bem formado e leve', hInfo.problems.length === 0 && hInfo.imgs.length === 1 && /DISK BEBIDAS/.test(hm.html) && /Instagram/.test(hm.html) && Buffer.byteLength(hm.html) < 40_000);
check('conteúdo: título, aviso, botão "Entrar na minha conta" (→ /conta), dica da senha e "não foi você?"', /Você já tem uma conta<\/h1>/.test(hm.html) && /Alguém tentou criar uma conta em Copo Cheio/.test(textOf(hm.html)) && hInfo.links.includes(`${SITE}/conta`) && /Entrar na minha conta/.test(hm.html) && /Esqueci minha senha/.test(hm.text) && /Não foi você\?/.test(hm.text));
check('sem código, sem link de confirmação e sem a senha de ninguém', !/verificar\//.test(hm.html + hm.text) && !/\b\d{6}\b/.test(hm.text) && !/outra-senha|senha-boa/.test(hm.html + hm.text));
check('texto simples do aviso completo e sem HTML', /Você já tem uma conta/.test(hm.text) && !/<[a-z][^>]*>/i.test(hm.text) && /© \d{4} Copo Cheio/.test(hm.text));

// ------------------------------------------------------------------------------------------------------
section('8. Contraste das cores (WCAG): texto normal ≥ 4,5:1; números grandes ≥ 3:1');
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const { light: L, dark: Dk } = PALETTE;
const pairs = [
  ['claro: título sobre o cartão', L.ink, L.card, 4.5],
  ['claro: texto sobre o cartão', L.body, L.card, 4.5],
  ['claro: texto secundário sobre o cartão', L.muted, L.card, 4.5],
  ['claro: texto secundário sobre o rodapé', L.muted, L.soft, 4.5],
  ['claro: rótulo do código sobre o bloco do código', L.panelLabel, L.panel, 4.5],
  ['claro: dígitos do código (grandes) sobre o bloco', L.blue, L.panel, 3],
  ['claro: azul dos links sobre o rodapé', L.blue, L.soft, 4.5],
  ['claro: texto do botão (branco) sobre o azul', '#FFFFFF', L.blue, 4.5],
  ['claro: texto do aviso de segurança', L.body, L.soft, 4.5],
  ['claro: faixa de teste', L.bannerInk, L.bannerBg, 4.5],
  ['claro: texto alternativo da logo sobre o cabeçalho', '#FFFFFF', L.header, 4.5],
  ['escuro: título sobre o cartão', Dk.ink, Dk.card, 4.5],
  ['escuro: texto sobre o cartão', Dk.body, Dk.card, 4.5],
  ['escuro: texto secundário sobre o cartão', Dk.muted, Dk.card, 4.5],
  ['escuro: texto secundário sobre o rodapé', Dk.muted, Dk.soft, 4.5],
  ['escuro: rótulo do código sobre o bloco', Dk.panelLabel, Dk.panel, 4.5],
  ['escuro: dígitos do código sobre o bloco', Dk.digits, Dk.panel, 3],
  ['escuro: links sobre o rodapé', Dk.accent, Dk.soft, 4.5],
  ['escuro: links e etiqueta sobre o cartão', Dk.accent, Dk.card, 4.5],
  ['escuro: texto do aviso de segurança', Dk.body, Dk.soft, 4.5],
  ['escuro: faixa de teste', Dk.bannerInk, Dk.bannerBg, 4.5],
];
for (const [name, fg, bg, min] of pairs) check(`${name}: ${ratio(fg, bg).toFixed(1)}:1 (mínimo ${min})`, ratio(fg, bg) >= min, [fg, bg, ratio(fg, bg)]);

summary();
