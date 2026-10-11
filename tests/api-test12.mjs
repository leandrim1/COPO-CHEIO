// Permissões e histórico de atividades, edição simultânea das configurações, privacidade (LGPD) e HTML para robôs (SEO).
import { execFileSync } from 'node:child_process';
import { BASE, Client, check, clearMail, mailsTo, registerVerified, section, summary } from './lib.mjs';

const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-c', sql], { encoding: 'utf8' }).trim();
const psqlFails = (sql) => {
  try {
    execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-c', sql], { encoding: 'utf8', stdio: 'pipe' });
    return false;
  } catch (error) {
    return String(error.stderr || error.message);
  }
};
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const STRONG = 'Caixa#Segura-2026';

const owner = new Client(undefined, '198.51.100.1');
await owner.login();
const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
await owner.patch('/api/admin/store', { opening_hours: allDays });
await owner.post('/api/admin/admins', { email: 'comum@copocheio.local', name: 'Atendente Comum', password: STRONG, role: 'admin' });
const staff = new Client(undefined, '198.51.100.2');
await staff.login('comum@copocheio.local', STRONG);

// ------------------------------------------------------------------------------------------------
section('1. SEG-04: o que um administrador comum NÃO pode fazer');
const customer = new Client(undefined, '198.51.100.50');
await registerVerified(customer, { name: 'Clara Cliente', email: 'clara@exemplo.com', phone: '34 98888-7777', password: 'Clara!Senha-2026' });
const custId = (await owner.get('/api/admin/customers?q=clara')).data.customers[0].id;
{
  const link = await staff.post(`/api/admin/customers/${custId}/reset-link`);
  check('comum não gera link de nova senha de cliente (403)', link.status === 403, link.data);
  check('comum não vê o histórico de atividades (403)', (await staff.get('/api/admin/audit')).status === 403);
  check('comum não exclui contas de clientes (403)', (await staff.del(`/api/admin/customers/${custId}`)).status === 403);
  check('comum não gerencia a equipe nem o e-mail de teste (403)', (await staff.get('/api/admin/admins')).status === 403 && (await staff.post('/api/admin/mail/test')).status === 403);
  check('comum não anonimiza dados (403)', (await staff.post('/api/admin/privacy/anonymize', { email: 'clara@exemplo.com' })).status === 403);
  check('comum continua operando pedidos e produtos', (await staff.get('/api/admin/orders')).status === 200 && (await staff.get('/api/admin/products')).status === 200);

  await clearMail();
  const ok = await owner.post(`/api/admin/customers/${custId}/reset-link`);
  check('o owner gera o link (201) e a resposta diz que o cliente foi avisado', ok.status === 201 && typeof ok.data.token === 'string' && ok.data.notified === true, ok.data);
  const notice = (await mailsTo('clara@exemplo.com')).filter((m) => /senha/i.test(m.subject));
  check('o cliente recebe um e-mail avisando (ninguém toma a conta em silêncio)', notice.length === 1, (await mailsTo('clara@exemplo.com')).map((m) => m.subject));
  check('o e-mail de aviso NÃO traz o link nem o código de redefinição', !notice[0].text.includes(ok.data.token), 'token no e-mail!');
  const used = await new Client(undefined, '198.51.100.51').post('/api/account/reset', { token: ok.data.token, password: 'Nova!Senha-Clara-2026' });
  check('o link funciona uma vez', used.status === 200);
  check('...e não de novo', (await new Client(undefined, '198.51.100.52').post('/api/account/reset', { token: ok.data.token, password: 'Outra!Senha-Clara-2026' })).status === 400);
}

// ------------------------------------------------------------------------------------------------
section('2. SEG-04: histórico de atividades');
{
  const cat = (await owner.post('/api/admin/categories', { name: 'Histórico' })).data.category;
  const p = (await owner.post('/api/admin/products', { name: 'Vodka 1L', price: 45, category_id: cat.id })).data.product;
  await staff.patch(`/api/admin/products/${p.id}`, { price: 52.9 });
  await staff.patch(`/api/admin/products/${p.id}`, { active: false });
  await owner.patch('/api/admin/store', { delivery_fee: 7 });
  await owner.patch('/api/admin/store', { orders_paused: true });
  await owner.patch('/api/admin/store', { orders_paused: false });
  await owner.patch('/api/admin/site', { cta_title: 'Deu sede mesmo?', cta_highlight: 'sede' });
  await owner.patch('/api/admin/payments/pix', { details: 'chave-pix-teste' });
  const zone = (await owner.post('/api/admin/zones', { name: 'Bairro Novo', fee: 6 })).data.zone;
  await owner.patch(`/api/admin/zones/${zone.id}`, { fee: 9 });
  await staff.patch(`/api/admin/customers/${custId}`, { active: false });
  await staff.patch(`/api/admin/customers/${custId}`, { active: true });

  const log = (await owner.get('/api/admin/audit?limit=200')).data;
  const text = log.entries.map((e) => e.summary).join('\n');
  check('registra quem mudou o preço, de quanto para quanto', log.entries.some((e) => e.actor_name === 'Atendente Comum' && /preço: R\$ 45,00 → R\$ 52,90/.test(e.summary)), text.slice(0, 400));
  check('registra desativar produto', log.entries.some((e) => /ativo no site: sim → não/.test(e.summary)));
  check('registra taxa de entrega e pausa dos pedidos', /taxa de entrega: R\$ 5,00 → R\$ 7,00/i.test(text) && /pedidos pausados: não → sim/i.test(text) || /pausa/i.test(text), text.slice(0, 600));
  check('registra mudança nos textos do site', log.entries.some((e) => e.action === 'site.update'));
  check('registra a chave PIX trocada, sem gravar o valor da chave', log.entries.some((e) => e.action === 'payment.update') && !JSON.stringify(log.entries).includes('chave-pix-teste'));
  check('registra bairro (criar e mudar taxa)', log.entries.some((e) => e.entity === 'zone' && /9,00/.test(e.summary)));
  check('registra desativar/reativar conta de cliente', log.entries.filter((e) => e.action === 'customer.update').length === 2);
  check('cada entrada tem data, autor, IP e uma frase pronta', log.entries.every((e) => e.created_at && e.summary) && log.entries.some((e) => e.ip) && log.entries.some((e) => e.actor_email === 'comum@copocheio.local'));
  check('nada de senha, token ou código nas frases', !/senha[^ ]*:|token|[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/.test(text.replace(/Entrou no painel|Trocou a própria senha|Gerou um link de nova senha/g, '')));

  const onlyStaff = (await owner.get(`/api/admin/audit?actor=${log.entries.find((e) => e.actor_email === 'comum@copocheio.local').actor_id}`)).data;
  check('filtra por pessoa', onlyStaff.entries.length >= 3 && onlyStaff.entries.every((e) => e.actor_email === 'comum@copocheio.local'));
  check('filtra por assunto', (await owner.get('/api/admin/audit?entity=zone')).data.entries.every((e) => e.entity === 'zone'));
  check('busca por palavra do resumo (e trata % e _ como texto)', (await owner.get('/api/admin/audit?q=Vodka')).data.entries.length >= 2 && (await owner.get('/api/admin/audit?q=%25')).data.entries.every((e) => /%/.test(e.summary + (e.actor_name ?? ''))));
  const page1 = (await owner.get('/api/admin/audit?limit=3')).data;
  const page2 = (await owner.get(`/api/admin/audit?limit=3&before=${page1.entries.at(-1).id}`)).data;
  check('paginação: 3 por vez, "has_more" e cursor sem repetir', page1.entries.length === 3 && page1.has_more === true && page2.entries.every((e) => e.id < page1.entries.at(-1).id));
  check('filtro com valor estranho não quebra', (await owner.get('/api/admin/audit?entity=%27%3B--&actor=nao-uuid&before=abc&limit=9999')).status === 200);

  const e1 = psqlFails("update audit_log set summary = 'adulterado' where id = (select min(id) from audit_log)");
  check('o banco recusa ALTERAR o registro', e1 && /não pode ser alterado/.test(e1), e1);
  const e2 = psqlFails('delete from audit_log where id = (select min(id) from audit_log)');
  check('o banco recusa APAGAR registros recentes', e2 && /só pode ser apagado depois de 2 anos/.test(e2), e2);
  check('apagar registro com mais de 2 anos é permitido (retenção)', psql("insert into audit_log (action, summary, created_at) values ('teste.velho', 'antigo', now() - interval '3 years') returning 1") === '1' && psql("delete from audit_log where action = 'teste.velho' returning 1") === '1');
  check('a limpeza automática remove só o que passou de 2 anos', (psql("insert into audit_log (action, summary, created_at) values ('teste.velho2', 'antigo', now() - interval '3 years') returning 1"), psql('select purge_expired_data()'), psql("select count(*) from audit_log where action = 'teste.velho2'") === '0' && Number(psql('select count(*) from audit_log')) > 10));
}

// ------------------------------------------------------------------------------------------------
section('3. ADM-04: duas telas de configurações abertas ao mesmo tempo');
{
  const a = new Client(undefined, '198.51.100.60');
  await a.login();
  const b = new Client(undefined, '198.51.100.61');
  await b.login('comum@copocheio.local', STRONG);
  const seenByA = (await a.get('/api/admin/settings')).data.store;
  const seenByB = (await b.get('/api/admin/settings')).data.store;
  const first = await a.patch('/api/admin/store', { delivery_time: '20 a 30 min', expected_updated_at: seenByA.updated_at });
  check('quem salva primeiro, com a versão certa, consegue', first.status === 200 && first.data.store.delivery_time === '20 a 30 min', first.data);
  const second = await b.patch('/api/admin/store', { orders_paused: true, expected_updated_at: seenByB.updated_at });
  check('a tela antiga é recusada (409 stale_settings) e recebe os dados atuais', second.status === 409 && second.data.code === 'stale_settings' && second.data.store.delivery_time === '20 a 30 min', second.data);
  check('a pausa dos pedidos NÃO foi aplicada por engano', (await a.get('/api/admin/settings')).data.store.orders_paused === false);
  const retry = await b.patch('/api/admin/store', { orders_paused: true, expected_updated_at: second.data.store.updated_at });
  check('com a versão nova, a segunda pessoa também consegue', retry.status === 200 && retry.data.store.orders_paused === true);
  await a.patch('/api/admin/store', { orders_paused: false });
  check('sem expected_updated_at (versões antigas do painel) continua funcionando', (await a.get('/api/admin/settings')).data.store.orders_paused === false);
  const base = (await a.get('/api/admin/settings')).data.store.updated_at;
  const race = await Promise.all([a.patch('/api/admin/store', { delivery_time: 'A', expected_updated_at: base }), b.patch('/api/admin/store', { delivery_time: 'B', expected_updated_at: base })]);
  check('duas gravações ao mesmo tempo com a mesma versão: uma passa e a outra recebe 409', race.map((r) => r.status).sort().join() === '200,409', race.map((r) => r.status));
  check('data inválida em expected_updated_at é ignorada, não vira erro 500', (await a.patch('/api/admin/store', { delivery_time: 'C', expected_updated_at: 'ontem' })).status === 200);
}

// ------------------------------------------------------------------------------------------------
section('4. WEB-01: pedidos de privacidade (LGPD) e anonimização');
{
  const visitor = new Client(undefined, '203.0.115.10');
  const good = await visitor.post('/api/privacy/request', { kind: 'deletion', name: 'Pedro Titular', contact: '(34) 97777-1234', message: 'Quero apagar meus dados.' });
  check('qualquer pessoa (sem conta) pede pelo site: 201', good.status === 201, good.data);
  check('contato por e-mail também vale', (await visitor.post('/api/privacy/request', { kind: 'access', name: 'Paula Titular', contact: 'PAULA@Exemplo.com' })).status === 201);
  check('contato inválido: 400', (await visitor.post('/api/privacy/request', { kind: 'access', name: 'Sem Contato', contact: '123' })).status === 400);
  check('assunto inventado: 400', (await visitor.post('/api/privacy/request', { kind: 'hackear', name: 'Fulano Tal', contact: '34977771234' })).status === 400);
  const trap = await visitor.post('/api/privacy/request', { kind: 'other', name: 'Robô Teste', contact: '34966660000', website: 'http://spam' });
  check('robô que preenche o campo escondido recebe "ok", mas nada é gravado', trap.status === 201 && psql("select count(*) from privacy_requests where name = 'Robô Teste'") === '0');
  check('o e-mail é gravado em minúsculas e o telefone só com números', psql("select contact from privacy_requests where name = 'Paula Titular'") === 'paula@exemplo.com' && psql("select contact from privacy_requests where name = 'Pedro Titular'") === '34977771234');
  const spam = [];
  for (let i = 0; i < 6; i++) spam.push((await visitor.post('/api/privacy/request', { kind: 'other', name: `Teste ${i}`, contact: '34911112222' })).status);
  check('limite por rede: depois de 5 por hora vem 429', spam.includes(429), spam);

  check('sem login o painel não lista (401)', (await visitor.get('/api/admin/privacy')).status === 401);
  const list = await staff.get('/api/admin/privacy');
  check('administrador comum vê a lista, com os abertos primeiro e a contagem', list.status === 200 && list.data.requests.length >= 2 && list.data.requests[0].status === 'open' && list.data.open >= 2, list.data.open);
  const dash = await staff.get('/api/admin/dashboard');
  check('o dashboard avisa quantos pedidos esperam resposta', dash.data.privacy_open >= 2);
  const one = list.data.requests.find((r) => r.name === 'Pedro Titular');
  const done = await staff.patch(`/api/admin/privacy/${one.id}`, { status: 'done', handled_note: 'Respondido por WhatsApp' });
  check('marcar como atendido guarda quem, quando e a observação', done.status === 200 && psql(`select handled_by_name || '|' || handled_note || '|' || (handled_at is not null) from privacy_requests where id = ${lit(one.id)}`) === 'Atendente Comum|Respondido por WhatsApp|true');
  check('reabrir limpa quem atendeu', (await staff.patch(`/api/admin/privacy/${one.id}`, { status: 'open' })).status === 200 && psql(`select handled_by is null from privacy_requests where id = ${lit(one.id)}`) === 't');
  check('a ação ficou no histórico', (await owner.get('/api/admin/audit?entity=privacy_request')).data.entries.length >= 2);

  // Anonimização: visitante que comprou sem conta
  const cat = (await owner.post('/api/admin/categories', { name: 'Privacidade' })).data.category;
  const prod = (await owner.post('/api/admin/products', { name: 'Refri Privacidade', price: 6, category_id: cat.id })).data.product;
  const place = (extra) =>
    new Client(undefined, `203.0.116.${Math.floor(Math.random() * 200) + 1}`).post('/api/orders', {
      customer_name: 'Pedro Titular',
      customer_phone: '34977771234',
      customer_email: 'pedro@exemplo.com',
      delivery_type: 'delivery',
      address: 'Rua Secreta',
      address_number: '77',
      neighborhood: 'Bairro Novo',
      complement: 'Fundos',
      reference: 'Perto do mercado',
      notes: 'Deixar com o porteiro',
      payment_method: 'pix',
      items: [{ product_id: prod.id, quantity: 2 }],
      ...extra,
    });
  const o1 = await place({});
  const o2 = await place({});
  const other = await place({ customer_name: 'Outra Pessoa', customer_phone: '34955550000', customer_email: 'outra@exemplo.com' });
  check('pedidos criados', [o1, o2, other].every((r) => r.status === 201), [o1.data, o2.data]);
  const t1 = o1.data.token;
  const wipe = await owner.post('/api/admin/privacy/anonymize', { phone: '(34) 97777-1234', email: '' });
  check('o owner anonimiza pelo telefone: 2 pedidos', wipe.status === 200 && wipe.data.orders === 2, wipe.data);
  const row = psql(`select customer_name || '|' || customer_phone || '|' || coalesce(customer_email, 'NULL') || '|' || coalesce(address, 'NULL') || '|' || coalesce(complement, 'NULL') || '|' || coalesce(reference, 'NULL') || '|' || coalesce(notes, 'NULL') || '|' || total from orders where order_number = ${o1.data.order.order_number}`);
  check('nome, telefone, e-mail, endereço, complemento, referência e observação saem; o valor fica', row === 'Cliente removido|0000000000|NULL|Removido|NULL|NULL|NULL|21.00', row);
  check('os itens e o valor continuam no histórico da loja', psql(`select sum(quantity) from order_items i join orders o on o.id = i.order_id where o.order_number = ${o1.data.order.order_number}`) === '2');
  check('o link de acompanhamento deixa de abrir', (await new Client().get(`/api/tracking/${t1}`)).status === 404);
  check('o pedido de outra pessoa não foi tocado', psql(`select customer_name from orders where order_number = ${other.data.order.order_number}`) === 'Outra Pessoa');
  const byMail = await owner.post('/api/admin/privacy/anonymize', { email: 'outra@exemplo.com' });
  check('também funciona pelo e-mail', byMail.status === 200 && byMail.data.orders === 1);
  const acct = await owner.post('/api/admin/privacy/anonymize', { email: 'clara@exemplo.com' });
  check('apaga também a conta do cliente', acct.status === 200 && acct.data.customers === 1 && psql("select count(*) from customers where email = 'clara@exemplo.com'") === '0', acct.data);
  check('sem telefone nem e-mail: 400', (await owner.post('/api/admin/privacy/anonymize', {})).status === 400);
  check('telefone curto demais não apaga ninguém por engano', (await owner.post('/api/admin/privacy/anonymize', { phone: '123' })).status === 400);
  const logText = JSON.stringify((await owner.get('/api/admin/audit?entity=privacy')).data.entries);
  check('o histórico registra a anonimização SEM repetir os dados pessoais', /Anonimizou/.test(logText) && !/97777|pedro@|Pedro Titular/.test(logText), logText.slice(0, 300));
}

// ------------------------------------------------------------------------------------------------
section('5. WEB-02: HTML para robôs (WhatsApp, Facebook, Google) e páginas inexistentes');
{
  const bot = (path, ua = 'WhatsApp/2.23.20.0 A') => fetch(`${BASE}${path}`, { headers: { 'user-agent': ua } });
  await owner.patch('/api/admin/site', { seo_title: 'Copo Cheio – Bebidas geladas em Uberlândia', seo_description: 'Peça bebidas geladas pelo site: entrega rápida.' });
  await owner.patch('/api/admin/store', { whatsapp: '5534991283384', address: 'Rua das Flores, 100', city: 'Uberlândia', state: 'MG', cep: '38400000' });
  const home = await bot('/');
  const html = await home.text();
  check('robô recebe HTML pronto da função (200, text/html)', home.status === 200 && /text\/html/.test(home.headers.get('content-type')) && html.includes('<div id="root">'));
  check('título e descrição vêm do painel', html.includes('<title>Copo Cheio – Bebidas geladas em Uberlândia</title>') && html.includes('content="Peça bebidas geladas pelo site: entrega rápida."'));
  check('tem og:title, og:description, og:url, og:image absoluta, og:site_name e twitter:card', ['og:title', 'og:description', 'og:url', 'og:image', 'og:site_name'].every((p) => html.includes(`property="${p}"`)) && /og:image" content="https?:\/\//.test(html) && html.includes('twitter:card'));
  check('tem endereço canônico', /<link rel="canonical" href="http:\/\/127\.0\.0\.1:4180"/.test(html), html.match(/<link rel="canonical"[^>]*>/)?.[0]);
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  const data = ld ? JSON.parse(ld) : null;
  check('dados estruturados schema.org/Store com telefone, endereço e horários da loja', data?.['@type'] === 'Store' && data.telephone === '+5534991283384' && data.address?.addressLocality === 'Uberlândia' && Array.isArray(data.openingHoursSpecification) && data.openingHoursSpecification.length === 7, data);
  check('mantém os scripts e estilos do site (o robô que executa JavaScript vê o mesmo app)', /<script type="module" crossorigin src="\/assets\/index-[^"]+\.js"/.test(html));
  const humans = await (await fetch(`${BASE}/`, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130 Safari/537.36' } })).text();
  check('pessoas continuam recebendo o index.html estático (sem passar pela função)', !humans.includes('application/ld+json') && humans.includes('<div id="root">'));
  for (const ua of ['facebookexternalhit/1.1', 'Twitterbot/1.0', 'Googlebot/2.1', 'TelegramBot (like TwitterBot)', 'Slackbot-LinkExpanding 1.0', 'LinkedInBot/1.0', 'bingbot/2.0']) {
    check(`robô "${ua.split('/')[0]}" também recebe`, (await (await bot('/bebidas', ua)).text()).includes('property="og:title"'));
  }
  const beb = await (await bot('/bebidas')).text();
  check('/bebidas: título da página no título e canonical próprio', /<title>Bebidas – /.test(beb) && beb.includes('href="http://127.0.0.1:4180/bebidas"'));

  const missing = await bot('/pagina-que-nao-existe');
  const mhtml = await missing.text();
  check('endereço inexistente: 404 de verdade para o robô, com noindex', missing.status === 404 && /noindex/.test(mhtml) && /noindex/.test(missing.headers.get('x-robots-tag') ?? ''), missing.status);
  for (const path of ['/xyz/abc', '/bebidas/x', '/index.php', '/wp-login.php', '/admin/../etc']) check(`${path} → 404 para robô`, (await bot(path)).status === 404);
  const priv = await bot('/pedido/ABCDE-ABCDE-ABCDE-ABCDE');
  check('páginas pessoais existem, mas com noindex e sem cache', priv.status === 200 && /noindex/.test(await priv.text()) && /no-store/.test(priv.headers.get('cache-control')) && /noindex/.test(priv.headers.get('x-robots-tag')));
  check('/privacidade e /bebidas são indexáveis e com cache curto de borda', /s-maxage=60/.test((await bot('/privacidade')).headers.get('cache-control')) && !/noindex/.test(await (await bot('/privacidade')).text()));
  check('a resposta varia pelo User-Agent (cache não mistura robô com gente)', /User-Agent/i.test(home.headers.get('vary') ?? ''));

  // Texto malicioso no painel nunca vira HTML
  await owner.patch('/api/admin/site', { seo_title: 'Loja "</title><script>alert(1)</script>', seo_description: 'a"><img src=x onerror=alert(1)>' });
  await owner.patch('/api/admin/store', { store_name: 'Cia </script><b>x' });
  const evil = await (await bot('/')).text();
  check('título e descrição vindos do painel são escapados (sem script, sem tag)', !evil.includes('<script>alert(1)') && !evil.includes('<img src=x') && evil.includes('&lt;/title&gt;'));
  const evilLd = evil.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '';
  check('dados estruturados: "<" sai escapado (nada fecha a tag antes da hora) e o JSON continua válido', !evilLd.includes('</script') && JSON.parse(evilLd).name === 'Cia </script><b>x');
  await owner.patch('/api/admin/site', { seo_title: 'Copo Cheio – Bebidas geladas em Uberlândia', seo_description: 'Peça bebidas geladas pelo site: entrega rápida.' });
  await owner.patch('/api/admin/store', { store_name: 'Copo Cheio' });

  const direct = await new Client().get('/api/__page?__from=//evil.example/x');
  check('a rota técnica com endereço malicioso cai em "não encontrado"', direct.status === 404, direct.status);
  const noHost = await fetch(`${BASE}/api/__page?__from=/bebidas`, { headers: { 'x-forwarded-host': 'evil.example' } });
  check('cabeçalhos forjados não mudam os endereços do HTML', !(await noHost.text()).includes('evil.example'));
}

// ------------------------------------------------------------------------------------------------
section('6. TEC-04: relatórios de erro do navegador e estado do sistema');
{
  const anon = new Client();
  const ok = await anon.post('/api/client-error', { kind: 'render', message: 'Cannot read x of null', page: '/pedido/SEGREDO', stack: 'at /pedido/SEGREDO2' });
  check('relato de erro do navegador é aceito (202)', ok.status === 202, ok);
  check('JSON inválido: 400', (await anon.req('POST', '/api/client-error', '{"não é json', { raw: true, headers: { 'content-type': 'application/json' } })).status === 400);
  check('relato gigante: 413', (await anon.req('POST', '/api/client-error', 'x'.repeat(20_000), { raw: true, headers: { 'content-type': 'application/json' } })).status === 413);
  const csp = await anon.req('POST', '/api/csp-report', JSON.stringify({ 'csp-report': { 'blocked-uri': 'https://x.test', 'violated-directive': 'script-src' } }), { raw: true, headers: { 'content-type': 'application/csp-report' } });
  check('relatório de CSP: 204 sem corpo', csp.status === 204);
  const health = await anon.get('/api/health');
  check('/api/health local mostra se está de pé', health.status === 200 && health.data.ok === true && health.data.database === 'ok');
  const adm = await staff.get('/api/admin/health');
  check('/api/admin/health (logado) traz banco, imagens, e-mail e endereço do site', adm.status === 200 && adm.data.database === 'ok' && adm.data.blob === 'ok' && adm.data.mail === 'ok' && Array.isArray(adm.data.missing), adm.data);
  check('...e exige login', (await anon.get('/api/admin/health')).status === 401);
  const withReq = await anon.get('/api/products');
  const rid = withReq.headers.get('x-request-id');
  const custom = await fetch(`${BASE}/api/products`, { headers: { 'x-request-id': 'meu-id-123' } });
  check('X-Request-Id é gerado pelo servidor (não repete o que o cliente manda)', rid && custom.headers.get('x-request-id') !== 'meu-id-123');
}

summary();
