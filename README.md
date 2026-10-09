# COPO CHEIO – Disk Bebidas

Site de delivery + painel administrativo da Copo Cheio.

**React + TypeScript + Vite + Tailwind** no navegador · **Funções da Vercel** (`/api`) no servidor ·
**Neon PostgreSQL** (`copocheio-db`) para os dados · **Vercel Blob** (`copocheio-uploads`) para as imagens.

```
                    COPO CHEIO
                         │
                   SITE PÚBLICO  /  PAINEL /admin
                         │
                         ▼
                 API  (Vercel Function: api/index.ts)
                  /                         \
                 ▼                           ▼
        NEON  copocheio-db             VERCEL BLOB  copocheio-uploads
        produtos, pedidos, textos,     fotos de produtos, banners,
        configurações, administradores Hero, logo (no Neon fica só a URL)
```

O navegador só fala com `/api/*`. `DATABASE_URL` e a credencial do Blob existem apenas no servidor.
Tudo o que aparece no site — produtos, preços, fotos, estoque, textos, WhatsApp, Instagram, endereço, horário,
taxa de entrega, formas de pagamento e banners — vem do Neon e é editado no painel, sem mexer no código.

```bash
npm install
vercel env pull .env.local   # DATABASE_URL e BLOB_READ_WRITE_TOKEN do projeto
npm run dev                  # site + API em http://localhost:5173
npm run build                # confere os tipos (site e servidor) e gera a versão de produção
```

## Páginas

| Site                | O que é                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `/`                 | Hero, Contato, chamada final ("Deu sede?") e rodapé                          |
| `/bebidas`          | Cardápio: banners, busca, categorias, favoritos, ESGOTADO                    |
| `/checkout`         | Dados do cliente, entrega ou retirada, endereço, pagamento, observações      |
| `/pedido/:codigo`   | Confirmação: "Pedido recebido!", andamento, link de acompanhamento, WhatsApp |
| `/acompanhar-pedido`            | Sem login: acompanhar sem cadastro (número + código) ou entrar na conta. Com login: só os pedidos em andamento da conta |
| `/acompanhar-pedido/:codigo`    | Link permanente do pedido: andamento ao vivo, itens, pagamento     |
| `/conta` · `/conta/pedidos` · `/conta/pedidos/:numero` | Conta (opcional): dados, "Meus pedidos", detalhe e "pedir de novo" |
| `/conta/recuperar` · `/conta/redefinir/:codigo`        | Esqueci a senha                                      |

| Painel (só administradores)                    | O que faz                                                   |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `/admin/login`                                 | Entrar com e-mail e senha                                   |
| `/admin/dashboard`                             | Pedidos e faturamento do dia/semana/mês, gráficos, recentes |
| `/admin/pedidos` · `/admin/pedidos/:numero`    | Pedidos ao vivo, filtros (status, data, conta/visitante), busca, status, histórico, link de acompanhamento, impressão |
| `/admin/clientes`                              | Contas de clientes: link de nova senha, desativar, excluir  |
| `/admin/produtos` · `/novo` · `/:id`           | Cadastrar, editar, duplicar, excluir, destacar, esgotar     |
| `/admin/categorias`                            | Criar, editar, ordenar, ativar/desativar                    |
| `/admin/estoque`                               | + adicionar / − retirar; 0 = ESGOTADO automático            |
| `/admin/site`                                  | Logo, nome, Hero, textos das seções, SEO                    |
| `/admin/banners`                               | Banners (desktop e celular) da página Bebidas               |
| `/admin/configuracoes`                         | Loja, horários, entrega, pagamento, painel, administradores |

Qualquer `/admin/*` sem login vai para `/admin/login`, e o servidor confere a sessão em **toda** chamada
administrativa: esconder a tela no navegador não é a proteção. O código do painel só é baixado quando alguém abre `/admin`.

## Colocar no ar (uma vez)

O projeto `copocheio` na Vercel já está ligado ao Neon `copocheio-db` e ao Blob `copocheio-uploads`.

1. **Variáveis** — em *Settings → Environment Variables* do projeto confirme que existem `DATABASE_URL`
   (integração Neon) e a credencial do Blob, marcadas para *Production*. O Blob tem dois jeitos de autenticar, e o
   servidor aceita os dois: o clássico, com `BLOB_READ_WRITE_TOKEN` (ou `<PREFIXO>_READ_WRITE_TOKEN`), e o novo, sem
   token, com `BLOB_STORE_ID` + OIDC da Vercel (as variáveis `BLOB_STORE_ID` e `BLOB_WEBHOOK_PUBLIC_KEY` indicam o modo
   novo; o projeto precisa estar com *OIDC* ligado em *Settings → Security*). O Blob precisa ser **público** (as fotos
   aparecem no site). `GET /api/health` mostra o que está faltando: `{"database":"ok","blob":"ok"}`.
2. **Deploy** — o script `vercel-build` roda `node scripts/migrate.mjs` antes do build: ele cria as tabelas no Neon
   (`db/migrations`) e carrega o conteúdo inicial (os mesmos textos que o site já tinha). Nenhum produto, preço ou
   categoria é inventado. Rodar de novo não faz nada de novo.
3. **Primeiro administrador (owner)** — no seu computador, com as variáveis baixadas (`vercel env pull .env.local`):

   ```bash
   npm run admin:create -- seu@email.com "Seu Nome"
   ```

   Ele pergunta a senha (mínimo de 8 caracteres) sem mostrá-la. A senha é guardada só como hash (scrypt).
   Os outros administradores o owner cria pelo painel, em *Configurações → Administradores*.
4. Entre em `/admin`, configure **WhatsApp, Instagram, endereço, horário, entrega e pagamento** em *Configurações*
   e cadastre (ou importe) os produtos.

## Migrar o cardápio antigo

*Produtos → Importar*: escolha (ou cole) o JSON dos produtos, no formato do antigo `produtos.json`:

```json
[
  { "name": "Coca-Cola 2L", "price": 12.0, "category": "Refrigerantes", "description": "…", "image": "https://…", "featured": true, "available": true }
]
```

Aceita também `nome`, `preco`, `categoria`, `descricao`, `imagem`, `destaque`. As categorias que não existirem são criadas;
produtos com o mesmo nome e categoria não são duplicados; `available: false` entra como ESGOTADO. Imagens com link
público continuam funcionando — para guardá-las no Blob, abra o produto e envie a foto.

## Como funciona

- **Pedido**: o checkout chama `POST /api/orders`; o servidor confere tudo de novo dentro do banco (`create_order`) — preço
  (sempre o do banco, inclusive promocional), produto ativo, esgotado, estoque, horário de funcionamento, pausa de
  pedidos, entrega/retirada, bairro e taxa, pedido mínimo, forma de pagamento e troco. **O preço enviado pelo navegador é
  ignorado.** Os produtos ficam travados durante a compra, então dois clientes ao mesmo tempo nunca levam a mesma última
  unidade. O número do pedido é sequencial (começa em **#1001**).
- **Itens**: nome e preço são gravados no pedido. Mudar o produto depois não altera pedidos antigos.
- **WhatsApp**: só depois que o pedido está salvo, a página do pedido mostra o botão com a mensagem pronta para o número
  configurado no painel.
- **Status**: NOVO → CONFIRMADO → EM PREPARO → SAIU PARA ENTREGA → ENTREGUE, ou CANCELADO. Cada mudança fica em
  `order_status_history` (de → para, data e administrador). Cancelar devolve o estoque; pedido cancelado não reabre.
  O painel altera só status e pagamento — itens e valores ficam como o cliente fechou.
- **Pedido novo no painel**: o painel pergunta ao servidor a cada ~8 segundos (mais devagar com a aba em segundo plano,
  e na hora em que você volta para ela) só o que chegou depois do último pedido visto. Quando chega: aviso
  "🔔 NOVO PEDIDO", som (liga/desliga por aparelho), contador no menu e no título da aba, e listas e dashboard
  atualizados sem recarregar.
- **Imagens**: o painel reduz e converte a foto para WebP, envia para `/api/admin/upload`, o servidor confere que é mesmo
  uma imagem (JPG, PNG, WebP, GIF ou AVIF — SVG nunca) e grava no Blob. O Neon guarda só a URL. Quando uma imagem
  deixa de ser usada (troca, exclusão), o servidor a apaga do Blob; produto duplicado compartilha a imagem até o último
  uso sumir.
- **Estoque**: vazio = não controla. Com controle, cada pedido desconta; chegou a 0, vira ESGOTADO; repôs, volta a vender.
- **Entrega**: taxa única, ou taxa por bairro (*Configurações → Entrega → Taxa por bairro*). Com bairros cadastrados,
  o cliente escolhe o bairro numa lista.
- **Pagamento**: PIX, dinheiro (com troco) e cartão na entrega, cada um liga/desliga (sempre pelo menos um ativo).
  Ainda não há pagamento online; a chave PIX (opcional) aparece para o cliente depois do pedido.
- **Site sempre em dia**: o site lê a API ao abrir e de novo quando a pessoa volta para a aba; guarda uma cópia no
  navegador para abrir rápido.
- **Textos sem quebrar o layout**: cada texto tem limite de tamanho (no painel, na API e no banco). O "trecho em azul" de
  cada título precisa estar escrito igual no título.

## Acompanhamento de pedidos

O cliente **não precisa de conta** para acompanhar o pedido, e o acompanhamento **não depende do navegador**: tudo mora
no Neon.

- **Código de acompanhamento**: ao fechar o pedido o *servidor* gera um código aleatório (100 bits, 20 caracteres sem
  letras que se confundem, ex.: `7K3M9-QX2VB-4HRD6-WTP8N`). No banco fica **só o SHA-256 dele**
  (`order_tracking_tokens`), gravado na mesma transação do pedido; o código aparece uma única vez, para o cliente.
- **Link permanente**: `/acompanhar-pedido/<código>`. Abre em qualquer aparelho, depois de fechar o navegador ou limpar
  os dados, sem login. A página de confirmação mostra o link com botões *Acompanhar meu pedido*, *Copiar link*,
  *Compartilhar pelo WhatsApp* (abre a conversa com a loja com o número do pedido e o link; abrir o WhatsApp não é
  tratado como "enviado") e *Fazer outro pedido*.
- **Perdeu o link?** `/acompanhar-pedido` (rodapé e menu): informe o **número do pedido + o código**, ou entre na conta.
  Quem já entrou na conta não vê a consulta sem cadastro: a página mostra direto os pedidos em andamento dela.
  O número sozinho nunca dá acesso. Também dá para colar o link inteiro no campo do código. Neste aparelho fica uma
  lista de atalhos dos últimos pedidos (só conveniência; pode apagar).
- **Andamento ao vivo**: linha do tempo Novo → Confirmado → Em preparo → Saiu para entrega (Pronto para retirar) →
  Entregue, ou Cancelado, com hora de cada etapa, próxima etapa, situação do pagamento (pendente/pago) e "última
  atualização". A página consulta o servidor a cada 10 s com a aba aberta (60 s em segundo plano ou com o pedido
  finalizado) e na hora em que a aba volta ou a internet reconecta. Sem conexão, continua mostrando o último estado,
  avisa e tenta de novo com intervalo crescente.
- **O cliente só lê**: não existe rota pública que altere pedido; status e pagamento só mudam pelo painel (o servidor
  confere o login). O pedido público nunca traz telefone, e-mail, ids internos nem o código.
- **Limite de consultas**: 30 consultas erradas por IP a cada 15 min (as certas, como o acompanhamento automático, não
  contam). Pedido inexistente, código errado e link vencido dão exatamente a mesma resposta.

### Conta do cliente (opcional)

`/conta`: cadastro (nome, e-mail, telefone), login, "Meus pedidos" (com o pedido em andamento em destaque), detalhe
com andamento ao vivo, **pedir de novo** e dados/endereço guardados que já vêm preenchidos no checkout. Comprar como
visitante continua sempre possível.

- **Vincular um pedido de visitante à conta** exige a prova de posse: o **número + o código de acompanhamento** do
  pedido *e* o telefone (ou e-mail) do pedido iguais aos da conta. Pedido já ligado a outra conta, código errado ou
  vencido recebem a mesma resposta ("não encontramos…"). Vincular não altera o pedido.
- **Esqueci a senha** (não há serviço de e-mail ligado): ou *e-mail + telefone cadastrado + número e código de um
  pedido que já está na conta* (`/conta/recuperar`), ou a loja gera um **link de nova senha** (uso único, vale 24 h) em
  *Painel → Clientes* e envia pelo WhatsApp.
- **Excluir a conta** (pelo cliente em `/conta`, ou pelo owner a pedido do titular): apaga cadastro, endereço guardado e
  sessões; os pedidos ficam na loja, sem ligação com a conta, e o link de acompanhamento deles continua valendo.
- Sessão do cliente: cookie `HttpOnly` + `SameSite=Lax` próprio (`copocheio_cliente`, 30 dias), só o hash no Neon; é
  outro mundo que a sessão do painel (uma não abre a outra). Senha com scrypt. 8 erros por e-mail / 30 por IP a cada 15 min.

### No painel

*Pedidos*: busca por número, nome, telefone ou e-mail; filtros por status, **data** e **conta/visitante**; selo
"Conta"/"Visitante"; detalhe com itens, pagamento (forma e situação), endereço, histórico (de → para, data, quem) e o
cartão **Acompanhamento do cliente**. Como o banco guarda só o hash, o link que o cliente já recebeu não pode ser lido de
volta: o painel **gera um link novo** (para abrir, copiar ou enviar por WhatsApp; os que o cliente já tem continuam
valendo) ou **troca o link** (invalida todos os anteriores, se vazou). Tudo o que o painel muda aparece na página do
cliente na próxima consulta.

### Retenção e privacidade

- O link de acompanhamento vale por **180 dias depois da última atualização do pedido** (*Configurações → Loja →
  Acompanhamento de pedidos*, de 7 a 3650 dias). Depois disso o link deixa de abrir e o hash do código é apagado (30
  dias depois do vencimento). Pedidos de quem tem conta continuam em "Meus pedidos".
- Sessões vencidas, links de redefinição usados/vencidos e registros de tentativas são apagados sozinhos (função
  `purge_expired_data`, chamada de vez em quando por logins, cadastros e pedidos).
- **Os pedidos em si não são apagados automaticamente**: a loja precisa deles como histórico e para obrigações fiscais.
  Prazo de guarda e eventual anonimização de pedidos antigos dependem da sua contabilidade; hoje isso é decisão manual.
- O cliente vê só o necessário para acompanhar a compra: nome, itens, valores, endereço e andamento; a página manda
  `noindex` e `Referrer-Policy: no-referrer` para o link não vazar.

## API

Público: `GET /api/products` · `GET /api/site` · `POST /api/orders` (devolve `{order, token}`) · `GET /api/health`
Acompanhamento (sem login): `GET /api/tracking/:codigo` · `POST /api/tracking/lookup` (`order_number` + `code`)
Conta do cliente: `POST /api/account/register|login|logout|recover|reset` · `GET /api/account/me` ·
`PATCH|DELETE /api/account` · `PATCH /api/account/password` · `GET /api/account/orders[/:numero]` ·
`POST /api/account/orders/claim`
Painel, sessão: `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` · `PATCH /api/auth/password`
Painel (exige login): `/api/admin/dashboard`, `orders` (+ `POST orders/:id/tracking-link`), `live`, `customers`, `products`,
`categories`, `banners`, `settings`, `store`, `site`, `hero`, `payments`, `zones`, `upload`; `/api/admin/admins` só para o owner
(excluir cliente também).

## Segurança

- `DATABASE_URL` e a credencial do Blob só existem no servidor (nenhuma variável `VITE_`); o bundle do navegador não
  contém driver de banco, token nem segredo.
- Login por e-mail e senha: senha com **scrypt**; sessão = código aleatório num cookie `HttpOnly` + `SameSite=Lax` (+ `Secure`
  em https), guardado no Neon só como hash e conferido a cada chamada administrativa. Sair, trocar ou redefinir a senha,
  desativar ou remover a pessoa derruba as sessões. Sem cadastro público: administradores só o owner cria.
- Limites de tentativa: 8 senhas erradas por e-mail e 30 por IP a cada 15 min (painel e conta do cliente); 30 consultas
  de pedido erradas por IP a cada 15 min; 10 cadastros por IP por hora; 5 pedidos por telefone a cada 10 min e 20 por IP.
- Escritas administrativas só aceitam a própria origem do site (defesa extra contra CSRF).
- Toda entrada é validada no servidor (tipos, tamanhos, links `https://`) e o banco repete os limites. Consultas sempre
  parametrizadas.
- O site público nunca recebe estoque, SKU, telefone de cliente ou qualquer dado administrativo. O cliente vê o próprio
  pedido só com o código secreto do link (ou pela própria conta); o código só existe no banco como hash.
- O servidor ignora tudo o que o navegador mandar sobre status, pagamento, valores, desconto, conta ou código do pedido:
  quem decide é o banco (`create_order`) e o login do painel.
- Papéis: **admin** cuida da operação; **owner** também gerencia administradores (a loja nunca fica sem um owner ativo).

## Banco (Neon)

`admins`, `admin_sessions`, `categories`, `products`, `payment_methods`, `orders`, `order_items`, `order_status_history`,
`store_settings`, `delivery_zones`, `site_settings`, `hero_settings`, `banners`, **`order_tracking_tokens`**
(hash dos códigos), **`customers`**, **`customer_sessions`**, **`customer_password_resets`** (+ `rate_limits`,
`schema_migrations`). Cada pedido guarda: id interno, número público (#1001…), data, cliente, endereço, itens com preço
da hora, subtotal, entrega, desconto, total, forma e situação do pagamento, status, histórico, conta (se houver) e
última atualização.

A migration `0004_order_tracking.sql` **preserva os pedidos existentes**: o UUID secreto dos links `/pedido/:id` já
enviados vira hash e continua abrindo o pedido; a coluna em texto puro (`public_token`) deixa de existir. Ela também
mantém, de forma transitória, a compatibilidade com a versão anterior do site (que pode seguir no ar durante um deploy
ou voltar num rollback).
Mudanças de estrutura são arquivos novos em `db/migrations` (cada comando separado por `-- statement-breakpoint`);
`npm run db:migrate` aplica os que faltam. Regras que precisam ser atômicas (criar pedido, mudar status, estoque,
dashboard) são funções do banco chamadas só pelo servidor.

## Limites conhecidos

- A prévia de links no WhatsApp/Facebook usa os dados fixos do `index.html` (esses robôs não executam JavaScript); título,
  descrição e favicon editados no painel valem para o Google e para o navegador.
- Uma função da Vercel aceita até ~4,5 MB por requisição: o painel já reduz as fotos (limite de 4 MB por imagem).
- Neon pode "dormir" quando fica sem uso; a primeira chamada depois disso demora um pouco mais.

## Estrutura

```
api/index.ts      função da Vercel: entrega /api/* para o servidor
server/                servidor: rotas, validação, login, acompanhamento, contas, banco (Neon), imagens (Blob)
db/migrations/         tabelas, funções e conteúdo inicial do Neon
scripts/               migrate.mjs (migrations) · create-admin.mjs (primeiro administrador)
src/App.tsx            site: Hero, Bebidas, Contato, chamada final, rotas
src/site/              dados do site (API), carrinho, checkout
src/site/Tracking.tsx  confirmação, acompanhamento e "Acompanhar pedido" (pacote à parte, junto com Account.tsx)
src/site/Account.tsx   conta do cliente: login, Meus pedidos, recuperar senha
src/lib/               cliente da API, tipos, formatação, horários, rotas
src/admin/             painel (carregado só em /admin)
```
