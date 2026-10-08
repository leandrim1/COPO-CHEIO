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
                 API  (Vercel Function: api/[...route].ts)
                  /                         \
                 ▼                           ▼
        NEON  copocheio-db             VERCEL BLOB  copocheio-uploads
        produtos, pedidos, textos,     fotos de produtos, banners,
        configurações, administradores Hero, logo (no Neon fica só a URL)
```

O navegador só fala com `/api/*`. `DATABASE_URL` e `BLOB_READ_WRITE_TOKEN` existem apenas no servidor.
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
| `/pedido/:id`       | "Pedido recebido!", número do pedido, andamento e botão do WhatsApp          |

| Painel (só administradores)                    | O que faz                                                   |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `/admin/login`                                 | Entrar com e-mail e senha                                   |
| `/admin/dashboard`                             | Pedidos e faturamento do dia/semana/mês, gráficos, recentes |
| `/admin/pedidos` · `/admin/pedidos/:numero`    | Pedidos ao vivo, filtros, busca, status, impressão          |
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
   (integração Neon) e `BLOB_READ_WRITE_TOKEN` (integração Blob), marcadas para *Production*.
   O Blob precisa ser **público** (as fotos aparecem no site). `GET /api/health` mostra o que está faltando:
   `{"database":"ok","blob":"ok"}`.
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

## API

Público: `GET /api/products` · `GET /api/site` · `POST /api/orders` · `GET /api/orders/:codigo` · `GET /api/health`
Sessão: `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` · `PATCH /api/auth/password`
Painel (exige login): `/api/admin/dashboard`, `orders`, `live`, `products`, `categories`, `banners`, `settings`, `store`,
`site`, `hero`, `payments`, `zones`, `upload`; `/api/admin/admins` só para o owner.

## Segurança

- `DATABASE_URL` e `BLOB_READ_WRITE_TOKEN` só existem no servidor (nenhuma variável `VITE_`); o bundle do navegador não
  contém driver de banco, token nem segredo.
- Login por e-mail e senha: senha com **scrypt**; sessão = código aleatório num cookie `HttpOnly` + `SameSite=Lax` (+ `Secure`
  em https), guardado no Neon só como hash e conferido a cada chamada administrativa. Sair, trocar ou redefinir a senha,
  desativar ou remover a pessoa derruba as sessões. Sem cadastro público: administradores só o owner cria.
- Limites de tentativa: 8 senhas erradas por e-mail e 30 por IP a cada 15 min; 5 pedidos por telefone a cada 10 min e
  20 por IP.
- Escritas administrativas só aceitam a própria origem do site (defesa extra contra CSRF).
- Toda entrada é validada no servidor (tipos, tamanhos, links `https://`) e o banco repete os limites. Consultas sempre
  parametrizadas.
- O site público nunca recebe estoque, SKU, telefone de cliente ou qualquer dado administrativo. O cliente vê o próprio
  pedido só com o código secreto do link.
- Papéis: **admin** cuida da operação; **owner** também gerencia administradores (a loja nunca fica sem um owner ativo).

## Banco (Neon)

`admins`, `admin_sessions`, `categories`, `products`, `payment_methods`, `orders`, `order_items`, `order_status_history`,
`store_settings`, `delivery_zones`, `site_settings`, `hero_settings`, `banners` (+ `rate_limits`, `schema_migrations`).
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
api/[...route].ts      função da Vercel: entrega /api/* para o servidor
server/                servidor: rotas, validação, login, banco (Neon), imagens (Blob)
db/migrations/         tabelas, funções e conteúdo inicial do Neon
scripts/               migrate.mjs (migrations) · create-admin.mjs (primeiro administrador)
src/App.tsx            site: Hero, Bebidas, Contato, chamada final, rotas
src/site/              dados do site (API), carrinho, checkout e página do pedido
src/lib/               cliente da API, tipos, formatação, horários, rotas
src/admin/             painel (carregado só em /admin)
```
