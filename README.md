# COPO CHEIO – Disk Bebidas

Site de delivery + painel administrativo da Copo Cheio.
React, TypeScript, Vite, Tailwind CSS, Lucide e **Supabase** (Auth, Database, Storage e Realtime).

Tudo o que aparece no site — produtos, preços, fotos, categorias, estoque, textos, WhatsApp, Instagram, endereço,
horário, taxa de entrega, formas de pagamento e banners — vem do banco e é editado no painel, sem mexer no código.

```bash
npm install
npm run dev      # servidor de desenvolvimento
npm run build    # verifica os tipos e gera a versão de produção
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
| `/admin/login`                                 | Entrar com e-mail e senha (Supabase Auth)                   |
| `/admin/dashboard`                             | Pedidos e faturamento do dia/semana/mês, gráficos, recentes |
| `/admin/pedidos` · `/admin/pedidos/:numero`    | Pedidos em tempo real, filtros, busca, status, impressão    |
| `/admin/produtos` · `/novo` · `/:id`           | Cadastrar, editar, duplicar, excluir, destacar, esgotar     |
| `/admin/categorias`                            | Criar, editar, ordenar, ativar/desativar                    |
| `/admin/estoque`                               | + adicionar / − retirar; 0 = ESGOTADO automático            |
| `/admin/site`                                  | Logo, nome, Hero, textos das seções, SEO                    |
| `/admin/banners`                               | Banners (desktop e celular) da página Bebidas               |
| `/admin/configuracoes`                         | Loja, horários, entrega, pagamento, som, administradores    |

Qualquer `/admin/*` sem login vai para `/admin/login`. O código do painel só é baixado quando alguém abre `/admin`,
e nenhum dado administrativo sai do banco para quem não é administrador (as regras ficam no banco — RLS).

## Colocar no ar (uma vez)

1. **Crie um projeto** em [supabase.com](https://supabase.com).
2. **Banco de dados** — aplique as migrations de `supabase/migrations`, **na ordem dos nomes**:
   - pelo navegador: *SQL Editor* → cole e rode cada arquivo, do `…120000_schema.sql` ao `…120400_initial_content.sql`; ou
   - pela linha de comando: `npx supabase login`, `npx supabase link --project-ref SEU_PROJETO` e `npx supabase db push`.

   Elas criam tabelas, regras de segurança, funções de pedido/estoque/dashboard, o bucket de imagens `media`,
   o tempo real dos pedidos e o conteúdo inicial (os mesmos textos que o site já tinha). Nenhum produto, preço ou
   categoria é inventado.
3. **Login** — *Authentication → Sign In / Providers*: desligue **Allow new users to sign up** (ninguém cria conta pelo site).
   Em *URL Configuration*, coloque o endereço do site em **Site URL**.
4. **Dono da loja** — *Authentication → Users → Add user* (e-mail + senha, marcando *Auto Confirm*). Depois, no *SQL Editor*:

   ```sql
   insert into public.admin_users (user_id, name, email, role)
   select id, 'Seu nome', email, 'owner' from auth.users where email = 'seu@email.com';
   ```

   Outros administradores: crie o usuário do mesmo jeito e adicione pelo painel em *Configurações → Administradores*.
5. **Vercel** — *Settings → Environment Variables*: `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`
   (em *Project Settings → API* do Supabase: Project URL e a chave **anon / publishable**). Faça um novo deploy.
   O `vercel.json` já faz todas as rotas (`/admin`, `/checkout`, `/pedido/...`) abrirem direto.
6. Entre em `/admin`, configure **WhatsApp, Instagram, endereço, horário, entrega e pagamento** em *Configurações*
   e cadastre (ou importe) os produtos.

> **Nunca** use a chave `service_role` / secret no site ou na Vercel. Só a URL e a chave anon/publishable vão para o navegador.

## Migrar o cardápio antigo

*Produtos → Importar*: escolha (ou cole) o JSON dos produtos, no formato do antigo `produtos.json`:

```json
[
  { "name": "Coca-Cola 2L", "price": 12.0, "category": "Refrigerantes", "description": "…", "image": "https://…", "featured": true, "available": true }
]
```

Aceita também `nome`, `preco`, `categoria`, `descricao`, `imagem`, `destaque`. As categorias que não existirem são criadas;
produtos com o mesmo nome e categoria não são duplicados; `available: false` entra como ESGOTADO. Imagens com link
público continuam funcionando — para guardá-las no Supabase Storage, abra o produto e envie a foto.

## Como funciona

- **Pedido**: o checkout chama a função `create_order` no banco, que confere tudo de novo — preço (sempre o do banco,
  inclusive promocional), produto ativo, esgotado, estoque, horário de funcionamento, pausa de pedidos, entrega/retirada,
  bairro e taxa, pedido mínimo, forma de pagamento e troco. Os produtos ficam travados durante a compra, então dois
  clientes ao mesmo tempo nunca levam a mesma última unidade. O número do pedido é sequencial (começa em **#1001**).
- **Itens**: nome e preço são gravados no pedido. Mudar o produto depois não altera pedidos antigos.
- **WhatsApp**: só depois que o pedido está salvo, a página do pedido mostra o botão com a mensagem pronta para o número
  configurado no painel.
- **Status**: NOVO → CONFIRMADO → EM PREPARO → SAIU PARA ENTREGA → ENTREGUE, ou CANCELADO. Cada mudança fica em
  `order_status_history` (de → para, data e administrador). Cancelar devolve o estoque; pedido cancelado não reabre.
  O painel altera só status e pagamento — itens e valores ficam como o cliente fechou.
- **Tempo real**: o painel escuta os pedidos pelo Supabase Realtime: aviso "🔔 NOVO PEDIDO", som (liga/desliga por aparelho),
  contador no menu e no título da aba, listas e dashboard atualizados sem recarregar.
- **Estoque**: vazio = não controla. Com controle, cada pedido desconta; chegou a 0, vira ESGOTADO; repôs, volta a vender.
- **Entrega**: taxa única, ou taxa por bairro (*Configurações → Entrega → Taxa por bairro*). Com bairros cadastrados,
  o cliente escolhe o bairro numa lista.
- **Pagamento**: PIX, dinheiro (com troco) e cartão na entrega, cada um liga/desliga. Ainda não há pagamento online;
  a chave PIX (opcional) aparece para o cliente depois do pedido.
- **Site sempre em dia**: o site lê o banco ao abrir e de novo quando a pessoa volta para a aba; guarda uma cópia no
  navegador para abrir rápido.
- **Textos sem quebrar o layout**: cada texto tem limite de tamanho (no painel e no banco). O "trecho em azul" de cada
  título precisa estar escrito igual no título.

### Segurança (Row Level Security)

| Quem                       | Pode                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------- |
| Visitante                  | ler produtos/categorias/banners **ativos** e as configurações públicas; criar pedido pela função; ver o próprio pedido pelo código secreto do link |
| Conta logada sem cadastro em `admin_users` | nada além do visitante                                                  |
| Admin ativo                | produtos, categorias, estoque, banners, conteúdo, configurações, pedidos, dashboard   |
| Owner                      | tudo do admin + gerenciar administradores (a loja nunca fica sem owner)                |

Estoque, SKU e caminhos internos dos produtos não são expostos ao público. Uploads no bucket `media` só por
administradores, apenas imagens, até 5 MB (o painel já reduz e converte fotos para WebP).

## Desenvolvimento local

Com Docker instalado:

```bash
npx supabase start                # sobe Postgres, Auth, REST, Realtime e Storage e aplica as migrations
cp .env.example .env.local        # use a API URL e a anon key que o comando acima mostrou
npm run dev
```

`npx supabase db reset` recria o banco local do zero com as migrations.

## Observação sobre SEO

Título, descrição, imagem de compartilhamento e favicon editados no painel são aplicados quando a página carrega
(é o que o Google lê). A prévia de links no WhatsApp/Facebook usa os dados fixos do `index.html`, porque esses robôs
não executam JavaScript.

## Estrutura

```
supabase/migrations/   banco: tabelas, RLS, funções, storage, realtime, conteúdo inicial
src/App.tsx            site: Hero, Bebidas, Contato, chamada final, rotas
src/site/              dados do site (Supabase), carrinho, checkout e página do pedido
src/lib/               cliente Supabase público, tipos, formatação, horários, rotas
src/admin/             painel (carregado só em /admin)
```
