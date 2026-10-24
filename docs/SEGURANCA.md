# Auditoria de segurança do COPO CHEIO

Auditoria de ponta a ponta feita sobre o código desta versão (20/10/2026). Cada linha diz **o que foi verificado, onde, como se testa** e **o que ficou fora**. Regra do projeto: o navegador não é barreira de segurança — toda operação privilegiada é conferida no **servidor** (e o que é regra de negócio, no **banco**).

> Limite desta auditoria: foi feita lendo o código e rodando os testes automáticos num PostgreSQL local, com o ViaCEP, o Blob e o e-mail **simulados**. Nada foi testado contra produção ou por um profissional de segurança independente. Não é um teste de invasão (pentest).

## 1. Resumo

| Área | Estado |
| --- | --- |
| Autenticação e autorização (painel e cliente) | **Aprovado** |
| Separação cliente × administrador, permissões por papel (owner/admin) | **Aprovado** |
| Acesso a pedido de terceiros (IDOR) | **Aprovado** |
| SQL injection | **Aprovado** (consultas parametrizadas; só constantes entram em texto de SQL) |
| XSS | **Aprovado** (React escapa; CSP `script-src 'self'`; nenhum `innerHTML` com dado de usuário) |
| CSRF | **Aprovado** (cookie `SameSite` + conferência de `Origin` nas escritas) |
| SSRF | **Aprovado** (sem URL vinda do usuário; hosts de saída fixos) |
| Upload de arquivos | **Aprovado** |
| Limites de requisição / abuso | **Aprovado** (46 pontos de limite no servidor, contados no banco) |
| Webhooks (e-mail, opcional) | **Aprovado** no que o simulador cobre |
| Sessões, recuperação de senha, 2 etapas | **Aprovado** |
| Variáveis de ambiente / segredos | **Aprovado** (nenhum segredo no repositório, nada vai ao navegador) |
| Cabeçalhos de segurança e CORS | **Aprovado** |
| Dependências | **Aprovado em produção** (0 vulnerabilidades); **5 "altas" só em ferramentas de desenvolvimento** (veja 5) |
| Dados pessoais, logs e trilha de auditoria | **Aprovado** |
| CAPTCHA | **Não implementado, por decisão** (veja 8) |
| Teste de invasão por terceiro | **Pendente** (recomendado antes de divulgar em larga escala) |

## 2. Autenticação, autorização e separação de papéis

* **Painel:** senha (scrypt, `server/auth.ts`; mínimo 10 caracteres, lista de senhas comuns, sem sequências, sem e-mail/nome — `server/passwordPolicy.ts`) **+ código de 6 dígitos enviado ao e-mail da conta a cada entrada** (`server/adminLoginCode.ts`) **+ aplicativo autenticador (TOTP) opcional** (`server/totp.ts`). A sessão é um valor aleatório opaco; **só o hash fica no banco**; cookie `HttpOnly`, `Secure`, `SameSite=Strict`; expira, gira e morre no logout.
* **Cliente:** conta opcional; e-mail confirmado antes de valer; código por e-mail a cada login (`server/loginCode.ts`); cookie `HttpOnly`, `SameSite=Lax`. Cookie de cliente **nunca** abre o painel e vice-versa (testado).
* **Toda rota é classificada** em `server/index.ts` como `public`, `admin` ou `owner`, e o roteador recusa (401/403) antes de chamar o código da rota. `tests/api-test25.mjs` lê **todas** as rotas registradas no código e prova: sem cookie, com cookie inventado, com sessão expirada, com administrador desativado, com sessão de cliente e com token de cliente no cookie do painel → **todas** as rotas protegidas respondem 401. Rota pública nova precisa de uma linha explícita nesse teste (decisão consciente).
* **owner × admin:** o que mexe em dinheiro, cupons, termos e políticas, exportação de clientes, equipe e configurações sensíveis é `owner` (servidor). `tests/api-test12.mjs` cobre as permissões e o histórico.
* **Cadastro de administrador:** só o owner cria; nunca existe usuário padrão; `scripts/create-admin.mjs` pede a senha por variável de ambiente.

## 3. Acesso a dados de outras pessoas (IDOR) e manipulação de valores

* **Pedido:** o acompanhamento exige o **código de acompanhamento** (20 letras/números, só o hash no banco) ou a sessão do dono da conta; erro e "não existe" respondem igual e contam como tentativa (`server/tracking.ts`, `tests/api-test4.mjs`). Cancelar, avaliar, pagar e ver cobrança usam o mesmo caminho: **um cliente nunca age sobre pedido de outro** (`tests/api-test28.mjs`, `tests/api-test34.mjs`, `tests/api-test22.mjs`).
* **Endereços da conta:** `where customer_id = $1` em toda consulta (`server/routes/addresses.ts`); limite de 4 extras garantido por gatilho do banco.
* **Preço, desconto, taxa e total:** o navegador só diz *o que* o cliente escolheu; **preço, estoque, taxa, cupom, frete grátis, agendamento e total são recalculados dentro do banco** (`create_order`, `coupon_apply`, `schedule_check`) e o pedido é recusado se o total visto pelo cliente não bate (`expected_total`). Cupom: um por pedido, desconto nunca maior que os itens elegíveis, mensagem genérica para código inválido e limite de tentativas errôneas (`tests/api-test29.mjs`, `tests/api-test30.mjs`).
* **Pontos (fidelidade):** o saldo é a soma de um extrato **só de acréscimo** (o banco recusa `update`); crédito e estorno por pedido são únicos (índices parciais) e feitos por gatilho do banco, nunca pelo navegador; a troca trava a conta (`for update`), confere o saldo, debita e cria o cupom na mesma transação (6 cliques simultâneos gastam só o saldo — `api-test38`); o cupom de troca é **pessoal** (`coupons.customer_id`) e para qualquer outra pessoa responde igual a um cupom inexistente; acerto manual só do owner, com motivo, sem deixar o saldo negativo e na trilha de atividades.
* **Bebida alcoólica:** a declaração de maioridade é exigida **no banco** (`create_order`); a entrega só conclui com a conferência do documento registrada (`admin_set_order_status`). Pedido feito direto à API sem a declaração é recusado (`tests/api-test28.mjs`).

## 4. Injeção e scripts

* **SQL:** todas as consultas usam parâmetros (`$1…`). Os poucos textos de SQL montados com `${}` contêm apenas constantes do próprio código (lista de colunas, nomes de papéis), nunca dado de usuário — conferido por busca no código. Valores numéricos/UUID são validados antes (`server/validate.ts`).
* **XSS:** o site é React (escapa por padrão). Há só dois `dangerouslySetInnerHTML`, ambos com **SVG de QR Code gerado localmente** (Pix e autenticador), nunca texto de usuário. Os textos das políticas (`legal_pages`) são **texto puro** desenhado pelo site (nunca HTML). O CSP não permite script de terceiros (`script-src 'self'`).
* **Planilhas (CSV):** a exportação neutraliza `=`, `+`, `-`, `@` no início da célula (apóstrofo) — `server/csv.ts`, `tests/unit/csv.test.mjs`.
* **HTML dos e-mails:** montado no servidor com escape de tudo que vem do cliente (`server/mailLayout.ts`).

## 5. Dependências

* `npm audit --omit=dev` (o que vai para a Vercel): **0 vulnerabilidades**.
* `npm audit` (inclui ferramentas de desenvolvimento): **5 de severidade alta**, todas na mesma cadeia **`tailwindcss` 3.x → `chokidar`/`fast-glob`/`micromatch` → `braces`** (uso de CPU excessivo com padrões maliciosos). É código que roda **só no build**, em ambiente nosso, com entradas nossas; **não existe no site publicado nem na função**. A correção proposta pelo `npm` é migrar para Tailwind 4 (mudança incompatível) — **não foi feita**: pela regra do projeto, trocar de tecnologia exige autorização. Recomendação: tratar numa janela própria.
* Nenhuma dependência nova foi adicionada nesta rodada (Etapas A a F). Imagens e o ícone de 192 px foram gerados localmente.
* O pacote `tests/` tem as próprias dependências (Playwright) e **não** vai para produção.

## 6. CSRF, CORS, cabeçalhos

* **CSRF:** cookies `SameSite` (Strict no painel, Lax no cliente) **e** `foreignOrigin()` em `server/index.ts`: escrita (`POST/PUT/PATCH/DELETE`) com `Origin` de outro site → 403. Os webhooks são a única exceção a "mesma origem" e usam **assinatura HMAC** (veja 7).
* **CORS:** não há. A API só responde ao próprio site; nenhum `Access-Control-Allow-Origin`.
* **Cabeçalhos (`vercel.json`, testados em `tests/api-test10.mjs`):** `Content-Security-Policy` restritiva (`default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests`, relatório em `/api/csp-report`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` (câmera, microfone, localização, pagamento, USB desligados), `Strict-Transport-Security`. Pedido, acompanhamento, conta e painel: `no-store`, `noindex`, `Referrer-Policy: no-referrer`.  A CSP vale igual para todas as páginas (a antiga tela do cartão, `/pagar/`, que tinha uma CSP própria, foi retirada junto com o pagamento online).
* **Cache público:** só dados do cardápio/loja e textos de políticas (curto, `s-maxage` de 30 a 60 s); nada de pedido, conta ou painel. O service worker (PWA) só guarda arquivos estáticos (`docs/PWA-SEO-ANALYTICS.md`).

## 7. Webhooks

* **E-mail (Resend, opcional):** assinatura Svix verificada (`server/email/svix.ts`, `tests/api-test21.mjs`).
* O webhook de pagamento (ValidaPay) **não existe mais**: `/api/payments/webhook` responde 404 (`api-test39`).

## 8. Abuso, robôs e CAPTCHA

Limites (contados no banco, atômicos — `server/auth.ts → reserve`): login do painel e do cliente (por rede, por e-mail e por par), código de login, reenvio de código, cadastro, recuperação de senha, verificação de e-mail, 2 etapas, pedidos (60 tentativas e 20 pedidos por 10 min por rede), cancelamento, avaliação, cupom (consulta e erros), CEP, endereços, pagamento (Pix e cartão), pedido de devolução, exportações (20/hora), pedidos de privacidade, e-mails de teste.

* **Checkout:** campo-isca escondido (`website`), tempo mínimo de preenchimento, limites por rede e **chave de idempotência** (reenviar não duplica o pedido). Dois pedidos iguais seguidos devolvem o **mesmo** pedido.
* **Rotas públicas que poderiam revelar quem tem cadastro** (cadastro, recuperação de senha, login) devolvem a **mesma resposta, com o mesmo cookie e no mesmo tempo** para e-mail cadastrado ou não; quem erra demais é barrado sem saber se o endereço tem conta (comentários e lógica em `server/routes/account.ts`; testes em `tests/api-test5.mjs`, `tests/api-test23.mjs`, `tests/api-test26.mjs`).
* **CAPTCHA: não implementado, de propósito.** Hoje cada ponto sensível já tem confirmação por e-mail, código de uso único, limite por rede/conta e isca; um CAPTCHA prejudicaria clientes legítimos no checkout, acrescentaria um script de terceiro (e uma abertura na CSP) e, sem sinal de abuso real, não traz benefício mensurável. **Gatilho para adotar:** pedidos falsos em massa, cadastros em massa ou envio de códigos por e-mail sendo explorado (aparece em *Configurações → Painel → Estado do sistema* e nos alertas de e-mail). **Opção recomendada** nesse caso: Cloudflare Turnstile (gratuito, sem imagem para o cliente), só em cadastro/recuperação de senha, **com fallback** (se o serviço cair, a rota continua protegida pelos limites atuais). Exige liberar `challenges.cloudflare.com` na CSP (decisão do proprietário).

## 9. Upload de arquivos

`POST /api/admin/upload` (só painel): tamanho máximo, **tipo decidido pela estrutura do arquivo** (cabeçalho mágico JPEG/PNG/WebP, `server/images.ts`), nunca pelo nome nem pelo `Content-Type` enviado; pasta de destino numa lista fixa; nome gerado pelo servidor. `GET /api/admin/image-source` (só admin, com limite de uso) só lê o endereço que **já está cadastrado como foto de algum produto** (o endereço tem de ser igual ao `image_url` de um produto): https, porta 443, sem usuário/senha, sem seguir redirecionamento, 8 s de espera, até 4 MB, e o conteúdo precisa ser JPEG/PNG/WebP de verdade (cabeçalho mágico). Para fotos que não estão no Blob da loja (cardápio importado) o servidor resolve o nome do site e **recusa endereços não públicos** (127.x, 10.x, 172.16–31.x, 192.168.x, 169.254.x/metadados de nuvem, 100.64.x, `localhost`, `*.local`, `*.internal`, IPv6 local/privado/mapeado) — **não é proxy aberto** e não serve para sondar a rede interna (SSRF). Texto do cliente nunca vira endereço consultado: o endereço precisa ter sido cadastrado por um admin como foto de produto. Testes: `tests/api-test27.mjs` (inclui as recusas de endereços internos). Testes: `tests/api-test10.mjs`, `tests/api-test27.mjs`.

## 10. SSRF

O servidor só faz requisições de saída para destinos **fixos no código**: ViaCEP (`viacep.com.br`), API do Resend (opcional) e o Blob da própria loja. Nenhum endereço vem do usuário. **Única exceção controlada:** a leitura, pelo painel, da foto de um produto cadastrada com endereço de outro site (`GET /api/admin/image-source`, descrita acima). As variáveis `CEP_API_URL`, `RESEND_API_URL` e `FAKE_*` existem só para os testes e são **ignoradas em produção** (`VERCEL_ENV=production`).

## 11. Segredos e variáveis de ambiente

* Nenhum segredo no repositório (varredura por padrões de chave, token, URL de banco e chave privada em todos os arquivos versionados e novos: nada encontrado; `.env*` está no `.gitignore`, só `.env.example`, sem valores).
* Variáveis do servidor não começam com `VITE_` → **nunca chegam ao navegador**. A única que chega é `GA_MEASUREMENT_ID` (identificador público da medição de visitas), e é exposta de propósito por `/api/site`, validada por formato.
* As respostas de erro não trazem pilha, SQL nem variável; o servidor registra o detalhe no log e devolve mensagem genérica. Falta de configuração vira `503` que diz *qual* variável falta, sem o valor.
* Não há segredo de cobrança: o sistema não fala com operadora de pagamento. Os segredos que restam (`CRON_SECRET`, SMTP, Resend, Blob) ficam em variáveis da Vercel, nunca no banco nem na tela.

## 12. Dados pessoais, logs e auditoria

* **Minimização:** não guardamos documento nem data de nascimento (só "declarou 18+" e "quem conferiu e quando"); o site **não coleta dados de cartão** (o cartão é pago na entrega); avaliações não guardam nome nem telefone; o CEP digitado não é gravado no pedido.
* **Logs:** o servidor não registra senha, código, token, cartão nem corpo de requisição; erros do navegador e relatórios de CSP vão para o log do servidor com limite de volume e sem dado pessoal (`server/routes/seo.ts`).
* **Retenção e LGPD:** prazos em `docs/OPERACAO.md` (seção 7); pedido de acesso/correção/exclusão e anonimização em `/privacidade` e no painel; `purge_expired_data()` apaga o vencido (e roda na rotina automática — `docs/OPERACAO.md`).
* **Trilha de auditoria:** `Configurações → Atividades` (só owner) registra quem fez o quê e quando (produtos, preços, cupons, política, estorno, exportação, equipe, moderação de avaliação…), sem segredos.
* **Exportação CSV:** só owner (pedidos e clientes) ou painel (estoque); cada exportação é registrada na trilha e limitada a 20 por hora.

## 13. Pontos de atenção e recomendações

1. **Teste de invasão por terceiro** antes de divulgar em larga escala.
2. **Mantenha `CRON_SECRET`, `SITE_URL` e as credenciais como *Sensitive* na Vercel**; troque-as se houver suspeita de vazamento.
3. **Dependências:** rodar `npm audit` a cada deploy relevante; planejar a migração do Tailwind 3 → 4 (corrige os 5 alertas de desenvolvimento).
4. **Backups:** o Neon guarda o histórico (ponto no tempo); faça o exercício de restauração de `docs/OPERACAO.md` uma vez.
5. **Autenticação de e-mail (SPF/DKIM/DMARC)** depende de domínio próprio — ver `docs/EMAIL-RELATORIO.md`.
