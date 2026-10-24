# Operação do COPO CHEIO

Guia de quem cuida do site no dia a dia: variáveis de ambiente, deploy e migrations, monitoramento, backup, o que fazer quando
algo quebra e por quanto tempo cada dado é guardado. A parte de desenvolvimento e testes está em [`tests/README.md`](../tests/README.md);
a visão geral do produto, no [`README.md`](../README.md).

> **Importante:** na Vercel, enviar o branch de produção (`claude/copd-cheid-hero-section-ufzva2`) **publica o site**. O build roda
> `node scripts/migrate.mjs && npm run build`, ou seja, **as migrations do banco da loja são aplicadas no deploy de produção**
> (veja [Deploy e migrations](#3-deploy-e-migrations)).

## 1. Variáveis de ambiente

Cadastre em *Vercel → Settings → Environment Variables*. **Nenhuma começa com `VITE_`**: nada disso chega ao navegador. Os valores
nunca vão para o Git (`.env*` está no `.gitignore`; só o `.env.example` é versionado, sem valores).

| Variável | Para quê | Sem ela |
| -------- | -------- | ------- |
| `DATABASE_URL` (ou `POSTGRES_URL`) | Neon PostgreSQL (`copocheio-db`). A integração Neon da Vercel cadastra sozinha | **Site fora do ar**: a API responde `503` e `GET /api/health` devolve `503`. O build avisa e **não** aplica migrations |
| `BLOB_READ_WRITE_TOKEN` (ou `<PREFIXO>_READ_WRITE_TOKEN`) **ou** `BLOB_STORE_ID` | Vercel Blob (`copocheio-uploads`): fotos de produto, banners, logo. O Blob precisa ser **público** | Não dá para enviar imagens (o painel mostra o aviso). Pedidos e o resto do site seguem normais |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | Envio de e-mail (confirmação de conta, "esqueci a senha", aviso de novo acesso ao painel) | **Ninguém cria conta de cliente** (`503 mail_not_configured`); recuperar senha por e-mail e o aviso de aparelho novo ficam desligados. Pedir e acompanhar pedido sem conta continua |
| `SMTP_PORT`, `SMTP_SECURE`, `MAIL_FROM` | Opcionais. `MAIL_FROM` só é obrigatória se `SMTP_USER` não for um e-mail | Usa 465 / `true` / o próprio `SMTP_USER` |
| `CRON_SECRET` | Texto aleatório longo (≥ 16 caracteres). **Liga os crons diários** (`vercel.json` → `/api/cron/email` e `/api/cron/sweep`; a segunda rotina também encerra o Pix/cartão vencido e pode ser chamada com mais frequência por um agendador externo — seção 4): a Vercel o envia como `Authorization: Bearer …` e a rota recusa tudo sem ele. O cron processa a fila de e-mails e faz a limpeza dos dados vencidos | Sem ele, o cron responde `401` (aparece como falha nas execuções do cron na Vercel; o resto funciona). A fila continua andando por atividade (pedidos, painel aberto) |
| `EMAIL_DAILY_LIMIT`, `EMAIL_PROMO_DAILY_LIMIT`, `MAIL_REPLY_TO` | Opcionais: teto de e-mails aceitos em 24 h (`0` = sem teto; padrão **450** com Gmail, sem teto nos outros), parte do teto que as promoções podem usar (padrão 40%, ou 300 sem teto) e endereço de resposta | Valem os padrões |
| `EMAIL_ORDER_NOTICES` | Opcional: `off` **pausa** os e-mails de pedido e pagamento (interruptor de segurança para quando algo estranho aparecer): nada novo sai e cada um fica em **Painel → E-mails → Mensagens** como "Bloqueado: avisos de pedido pausados". Códigos de confirmação, nova senha, avisos de segurança e promoções **não** são afetados. Vale depois de um novo deploy | Ligados |
| `ADMIN_EMAIL_CODE` | **Interruptor de EMERGÊNCIA** do login do painel. O código de 6 dígitos enviado por e-mail é **obrigatório** em todo login de administrador; a ÚNICA forma de pular esse passo é cadastrar `ADMIN_EMAIL_CODE=off` (escrito exatamente assim; qualquer outro valor, vazio ou com erro de digitação, deixa o código LIGADO) e fazer um novo deploy. Use **só** se o e-mail da loja parou e ninguém consegue entrar; conserte o e-mail, **remova a variável** e faça um novo deploy. Enquanto estiver ligado, *Configurações → Painel → Estado do sistema* mostra "Desligado (emergência)" em vermelho e o painel fica só com senha (e aplicativo autenticador, se a conta usa) | Ligado (código obrigatório) |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | **Provedor opcional** com avisos de entrega (Resend): `EMAIL_PROVIDER=resend` troca o SMTP pela API; exige domínio próprio verificado na Resend. Sem `RESEND_WEBHOOK_SECRET` a rota de avisos não existe (404). Veja [`EMAIL.md`](EMAIL.md#9-provedor-opcional-resend-api--avisos-assinados) | Fica no SMTP (padrão) |
| `SITE_URL` | Endereço público do site (ex.: `https://www.seudominio.com.br`) usado **nos links dos e-mails**, na logo dos e-mails e no endereço canônico das páginas | Na Vercel: em produção, o domínio de produção do projeto (`VERCEL_PROJECT_PRODUCTION_URL`); em preview, o endereço do deploy. Fora da Vercel só vale `localhost`; qualquer outro endereço sem `SITE_URL` impede montar o e-mail (`503`) e o painel mostra "Endereço do site: Não configurado" |
| `GA_MEASUREMENT_ID` | Opcional: identificador do Google Analytics 4 (`G-XXXXXXXXXX`; **não é segredo**). Liga a medição de visitas **somente para quem aceitar** o aviso. Para o Google carregar também é preciso liberar os endereços dele na política de segurança do `vercel.json` ([`PWA-SEO-ANALYTICS.md`](PWA-SEO-ANALYTICS.md), seção 3) | Nenhuma medição, nenhum aviso, nenhum script de terceiro |
| `MIGRATE_ON_PREVIEW` | `1` = deploys de teste (preview) também aplicam migrations. **Só** se o ambiente *Preview* usar um banco **separado** | Previews apenas listam as migrations pendentes e **não** mexem no banco |
| `SHELL_HTML_FILE` | Avançado: caminho do `index.html` usado na página para robôs (WhatsApp, Facebook, Google). Os testes usam | Usa `dist/index.html`, que a Vercel inclui na função (`vercel.json` → `includeFiles`) |
| `ADMIN_PASSWORD` | Só para rodar `npm run admin:create` sem digitar (CI, testes). **Não cadastre na Vercel** | O script pergunta a senha |

Definidas pela própria Vercel (não cadastre): `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`.

**Pagamento pelo site (retirado):** o sistema não usa mais a ValidaPay nem nenhuma operadora de pagamento. Se as variáveis `VALIDAPAY_*` ainda estiverem cadastradas na Vercel, **pode apagá-las** (são ignoradas), assim como o webhook que você tenha cadastrado no painel da ValidaPay (`/api/payments/webhook` não existe mais).

**Por que `SITE_URL` importa:** o servidor **nunca** monta o link de um e-mail a partir do que o navegador envia (`Host`,
`X-Forwarded-Host`). Se montasse, quem pedisse "esqueci a senha" com um cabeçalho forjado faria o e-mail da vítima apontar para um
site falso. Por isso o endereço vem de `SITE_URL` → domínio de produção da Vercel → endereço do deploy. Em domínio próprio,
**defina `SITE_URL`** e confirme em *Configurações → Painel → Estado do sistema*.

Para ver o que está faltando sem expor nomes ao público: o endereço público `GET /api/health` responde só `{"ok":true}` (200) ou
`{"ok":false}` (503). Os detalhes (banco, Blob, e-mail, endereço do site e o **nome** das variáveis que faltam) aparecem para
administradores logados em *Configurações → Painel → Estado do sistema* (`GET /api/admin/health`).

## 2. Ambientes e o banco (Preview × Produção)

| Ambiente na Vercel | Banco usado | Migrations no deploy |
| ------------------ | ----------- | -------------------- |
| **Production** | o da loja (`copocheio-db`) | **aplicadas** |
| **Preview** (branches e PRs) | **o que estiver em `DATABASE_URL` do ambiente Preview** | só listadas; aplicadas se `MIGRATE_ON_PREVIEW=1` |
| **Development** (`vercel env pull`) | o que estiver em `.env.local` | você roda `npm run db:migrate` |

**Risco a evitar:** se o ambiente *Preview* usar a mesma `DATABASE_URL` da produção, um deploy de teste lê e escreve **no banco
da loja**. Por isso o script de migrations não aplica nada em preview. O jeito seguro de testar em preview:

1. Crie um banco (ou branch) Neon **só para testes** e cadastre a `DATABASE_URL` dele **apenas** no ambiente *Preview*
   (a de produção continua só em *Production*).
2. Cadastre `MIGRATE_ON_PREVIEW=1` **apenas** no ambiente *Preview*.
3. Crie o primeiro administrador desse banco: `DATABASE_URL=<url do banco de teste> npm run admin:create -- teste@email.com "Teste"`.

Sem um banco separado, deixe o preview como está: ele mostra as migrations pendentes no log do build e o site de preview
provavelmente não funcionará até a migration ir para produção — é o comportamento esperado e seguro.

## 3. Deploy e migrations

**Fluxo:** `git push` no branch de produção → a Vercel roda `vercel-build` → `node scripts/migrate.mjs` aplica o que falta em
`db/migrations` **antes** do build → o site novo entra no ar. Se uma migration falhar, o build falha e **o site anterior continua
no ar**, sem a migration (cada arquivo roda numa transação; dois deploys ao mesmo tempo não aplicam o mesmo arquivo duas vezes).

**Regras para escrever uma migration** (a versão antiga do site continua atendendo clientes durante o deploy e, num rollback, volta
a rodar contra o banco já migrado):

- É sempre um **arquivo novo** `db/migrations/00NN_nome.sql`. Nunca edite um arquivo já aplicado.
- Separe os comandos com `-- statement-breakpoint`.
- Só **acrescente**: tabelas, colunas (com valor padrão ou aceitando nulo), índices, funções novas. Não renomeie nem apague nada que o
  código anterior ainda usa; para remover algo, faça em duas entregas (primeiro o código deixa de usar, depois a migration apaga).
- Teste num banco **limpo** e num banco **com dados** antes de enviar (os testes de `tests/` fazem os dois: `npm run test:api`).

**Conferido para as migrations 0009 a 0012:** o código de antes delas (commit `0709f60`) rodou as suítes de API (cerca de 840
verificações) contra um banco só com as migrations 0001–0008 e contra o banco migrado até a 0012, e os resultados foram os mesmos
(as poucas verificações que falham, nos dois casos, testam comportamentos novos; a única diferença é uma consulta do próprio teste a uma
tabela que só existe no banco novo). Ou seja: nesses fluxos, voltar o código para a versão anterior funciona com o banco novo.

**Exceção conhecida: a escolha do gelo (migrations 0013 e 0022).** A 0013 marcava *categorias* ("Copão" e "Copão com Monster"); a **0022 passou a marca para o
produto** (`products.ice_choice_required`, escolhida em *Produtos* no painel) e, daí em diante, só a marca do produto vale (a da categoria ficou no banco, sem uso). Elas
seguem as regras acima (só acrescentam colunas e trocam funções), com duas ressalvas que você precisa conhecer:

1. A 0013 escreveu **uma linha de dados**: ligou `categories.ice_choice_required` nas categorias chamadas "Copão" e "Copão com Monster" (o nome
   só foi usado nesse momento, sem diferenciar maiúsculas, acentos ou espaços). A **0022** escreve **uma linha de dados** também: marca (`products.ice_choice_required = true`)
   os produtos que estão em categorias com essa marca, para o site **não mudar de comportamento no instante do deploy** (copão continua perguntando o gelo; o pedido nunca
   chega à cozinha sem essa informação). **Depois do deploy, desmarque os produtos que não devem perguntar o gelo** (*Produtos*: botão do floco de neve na linha do produto ou a
   chave **Pedir a escolha do gelo** no formulário; o filtro "Pedem o gelo" lista os marcados). Produto novo nasce sem a marca. Se na loja as categorias tinham outro nome, nada
   é marcado sozinho: marque os produtos no painel (confira depois do deploy, passo 4 do item 8).
2. A regra é conferida **no banco**, então a versão antiga do site (que não sabe perguntar o gelo) é recusada ao pedir produtos dessas
   produtos, com a mensagem "Escolha o tipo de gelo para continuar.". Isso acontece (a) nos poucos minutos entre a migration rodar e o
   site novo entrar no ar e (b) **depois de um rollback do código**. O resto do site (produtos sem a marca) segue normal. Para voltar o código
   sem perder pedidos de copão, desligue a regra no SQL Editor do Neon: `update products set ice_choice_required = false;` (guarde antes quais estavam
   marcados, com `select id, name from products where ice_choice_required;`, para marcar de novo ao voltar ao código novo). Quem estava com o site aberto de antes só precisa recarregar a página.
   Observação do rollback da 0022: o código ANTERIOR à 0022 decide a pergunta pela categoria (a marca antiga continua no banco), mas o banco só exige o gelo dos produtos marcados; o
   que o site antigo perguntar a mais é ignorado pelo banco, sem erro.

**A migration 0024 (login do painel com código por e-mail).** Só acrescenta (a tabela `admin_email_challenges` e cinco funções novas); não toca em `admin_login_challenges` (o desafio do aplicativo autenticador), nenhuma função existente é alterada e nenhum dado é escrito ou apagado. Depois de um rollback do código, o login do painel volta a pedir só a senha (e o aplicativo, se a conta usa). Dados guardados: só hashes (do cookie da tentativa e do código), validade, contagem de erros e de envios. **Antes do deploy, confirme que o envio de e-mail funciona** (item 5 do pós-deploy): sem ele ninguém entra no painel (veja `ADMIN_EMAIL_CODE` na tabela de variáveis, só para emergência).

**A migration 0023 (login do cliente com código por e-mail).** Só acrescenta (a tabela `customer_login_challenges` e cinco funções novas); nenhuma função existente é alterada e nenhum dado é escrito ou apagado. Depois de um rollback do código, o login volta a pedir só a senha (o código novo deixa de ser pedido) e as tentativas gravadas ficam inertes até a limpeza (a própria tabela apaga linhas com mais de 1 dia; excluir a conta apaga as dela). Dados guardados: só hashes (do cookie da tentativa e do código), validade, contagem de erros e de envios; o e-mail da conta já existe em `customers`. Antes do deploy, **confira que o envio de e-mail está funcionando** (item 5 acima): sem ele ninguém entra na conta.

**A migration 0027 (maioridade 18+ e cancelamento pelo cliente).** Acrescenta `products.alcoholic` (**todos os produtos nascem `true`**: o lado seguro), cinco colunas de maioridade em `orders` (`age_required`, `age_declared_at`, `age_declaration_version`, `age_checked_at`, `age_checked_by_name`), `order_status_history.reason` e a função `order_cancel_why`; troca `order_json`, `create_order` e `admin_set_order_status` (a antiga de 3 argumentos é removida e a nova tem os argumentos extras com padrão, então chamadas antigas continuam valendo) e cria `customer_cancel_order`. Nenhum pedido, preço, estoque ou dado é alterado ou apagado. **Exceção ao "voltar o código funciona":** o banco passa a recusar pedido com bebida alcoólica sem `age_confirmed: true`, que o código antigo não envia (veja o item 17 do pós-deploy para a saída de emergência).

**A migration 0028 (devolução de pagamento online).** Só acrescentou a tabela `payment_refunds` e as funções `refund_begin` e `refund_update`. A funcionalidade foi retirada; a tabela fica sem uso.

**A migration 0017 (troca do energético dos combos).** Só acrescenta (duas colunas e funções de apoio) e troca três funções (`create_order`, `restore_order_stock`, `order_json`) por versões iguais para tudo o que já existe: pedido sem troca não muda. Na criação da coluna `products.swap_base_product_id`, ela é **preenchida uma única vez** nos produtos da categoria "Combos", procurando no nome do combo o energético de 2L que ele cita (ex.: "…1 Energético Jack Power 2L"). **Depois do deploy, abra cada combo no painel (Produtos → editar) e confira o campo "Energético que vem neste combo"**: combo sem ele não oferece a troca. Nada mais muda para quem não usa a troca.

**A migration 0018 (valor do energético do combo e lista de energéticos da troca).** Só acrescenta uma coluna (`products.swap_base_price`) e uma tabela (`product_swap_options`) e troca `create_order` por uma versão igual para tudo o que já existe (pedido sem troca e combo com troca "pelo produto" dão o mesmo preço de antes). **Não preenche nada.** Depois do deploy, **abra cada combo no painel (Produtos → editar → "Troca do energético")**: escolha o energético que vem nele (ou deixe "Nenhum" e digite o valor dele, se não é vendido avulso) e marque os energéticos que o cliente pode escolher na troca (sem nenhum marcado, vale qualquer energético de 2L). Combo sem produto e sem valor não oferece a troca.

**A migration 0019 (registro de e-mails, fila, promoções e e-mails de pedido).** Segue as regras acima: só acrescenta tabelas (`email_*`), funções e **dois gatilhos** (um em `order_status_history` e um em
`orders.payment_status`) e troca `anonymize_person` e `purge_expired_data` por versões iguais para tudo o que já existia (mais a limpeza dos registros de e-mail). **Não escreve nenhum dado**, não toca em pedido, cliente
ou produto existentes e **não envia nenhum e-mail** ao ser aplicada. Depois do deploy, **cada pedido novo (e cada mudança de etapa ou de pagamento) passa a gerar o e-mail ao cliente**, quando há e-mail no pedido ou na conta.
Os gatilhos engolem qualquer erro: se a tabela de e-mails falhar, o **pedido entra do mesmo jeito**. Cuidados:

1. **Rollback do código** para antes desta versão: o banco continua enfileirando e-mails de pedido, mas ninguém os envia (ficam "na fila"; a limpeza cancela os que passam de 7 dias). Nada quebra e nenhum pedido é afetado.
   Quem voltar ao código novo depois recebe só o que ainda faz sentido (mensagem de etapa que o pedido já passou é cancelada, não enviada).
2. Antes de publicar, **cadastre `CRON_SECRET`** (item 1) para o cron diário rodar, e confira `MAIL_FROM`/`SITE_URL`. Sem e-mail configurado, nada de pedido é enviado (as mensagens ficam na fila e saem quando o envio voltar).
3. Tudo o que muda para o cliente: e-mail de **pedido recebido/confirmado/saiu para entrega/entregue/cancelado** e **pagamento confirmado/reembolso**; a caixa **opcional** de promoções (desmarcada) no cadastro; a página
   `/conta/emails/…` e o painel de preferências em *Minha conta*. Promoções só saem quando o owner criar e enviar uma campanha.

**As migrations 0014 a 0016, 0020 e 0028 (pagamento online e devolução) e a 0036 (retirada).** As cinco primeiras criaram a integração de pagamento online (tabelas `merchant_accounts`, `payments`, `payment_events`, `payment_refunds`, o status de pedido `awaiting_payment`, o meio `pix_online`/`card_online` e funções); o código dela foi **retirado** do sistema. A 0036 só **desliga** `pix_online` e `card_online` (idempotente) e **não apaga nada**: as tabelas, colunas e funções ficam no banco, sem uso e sem efeito. Voltar o código para antes desta versão não exige desfazer nada; **não ligue** "Pix online" nem "Cartão online" se o painel antigo os listar (o pedido ficaria "aguardando pagamento" sem tela para pagar).

**Ver o que está pendente / aplicar manualmente:** `vercel env pull .env.local` e `npm run db:migrate` (aplica no banco do
`.env.local`; confirme que não é o de produção se estiver testando).

**Voltar atrás (rollback):** na Vercel, *Deployments →* o deploy anterior *→ Promote to Production / Instant Rollback* (o que está
disponível depende do plano). O rollback **só troca o código**; as migrations já aplicadas ficam, e é por isso que elas são
sempre compatíveis com a versão anterior. Nunca "desfaça" uma migration à mão em produção; corrija com uma migration nova.

## 4. Monitoramento

| O que | Como |
| ----- | ---- |
| Site de pé | Configure um monitor de disponibilidade (qualquer serviço de ping HTTP) em `https://<seu site>/api/health`: **200** = banco respondendo, **503** = banco fora. Monitore também `/` |
| Estado das integrações | *Painel → Configurações → Painel → Estado do sistema* (banco, imagens, e-mail, endereço do site: "Funcionando", "Sem resposta" ou "Não configurado", com os nomes das variáveis que faltam) |
| Logs do servidor | *Vercel → Logs*. Os erros saem em **uma linha JSON** (`level`, `msg`, `request_id`, `code`, `error`). Toda resposta da API tem o cabeçalho `x-request-id`; um erro `500` mostra o mesmo `request_id` no corpo: **peça esse número a quem relatou o problema** e busque por ele nos logs |
| Erros no navegador das pessoas | O site envia tela branca/falha inesperada para `/api/client-error`; no log aparece `msg: "erro-no-navegador"` (tipo, mensagem, página, pilha e navegador, sem dados pessoais) |
| Bloqueios da política de segurança (CSP) | `/api/csp-report` registra `msg: "csp-bloqueio"` (página, regra, endereço bloqueado). Se aparecer depois de um deploy, um recurso externo novo foi barrado: veja `vercel.json` → `Content-Security-Policy` |
| **E-mails** | *Painel → E-mails*: o que foi enviado, aceito, falhou ou foi bloqueado; **alertas** (usuário/senha do e-mail recusados, falhas em excesso, fila parada, teto diário, devoluções e spam quando o provedor avisa) que também chegam **por e-mail aos donos**, uma vez por problema. Abra-o depois de cada deploy e quando um cliente disser que não recebeu |
| **Estoque e rotina automática por e-mail** | Os donos recebem um e-mail (tipo "Aviso da operação") quando produtos ficam com estoque baixo/esgotado ou quando a rotina automática falha ou para; no máximo um por dia e só quando a situação muda (`server/opsAlerts.ts`). Aparece em *E-mails → Mensagens* |
| **Rotina automática** (Pix/cartão vencido, fila de e-mails, limpeza) | *Configurações → Painel → Estado do sistema → Rotina automática*: mostra quando rodou pela última vez e se deu certo ("Atrasada" = mais de 26 h sem rodar; "Nunca rodou"; "Falhou"). A Vercel chama `/api/cron/sweep` uma vez por dia (`vercel.json`). Para um monitor externo: `GET /api/cron/status` com `Authorization: Bearer $CRON_SECRET` devolve `{ sweep: { last_run_at, ok, age } }` |
| Atividade no painel | *Configurações → Atividades* (só o owner): quem mudou o quê e quando, entradas de aparelho novo, 2FA, privacidade. Guardado por 2 anos, não editável |

**Sinais que merecem olhar:** `/api/health` em 503; vários `500`/`erro inesperado` seguidos; `not_configured` ou `not_migrated` nos
logs (variável faltando ou migration não aplicada); muitos `429` em login (alguém testando senhas); e-mails de "Novo acesso ao
painel" que você não reconhece.

### Rotina com mais frequência (opcional)

O plano gratuito da Vercel só aceita cron **diário**; o `vercel.json` já agenda `/api/cron/email` (06:23 UTC) e `/api/cron/sweep` (03:47 UTC). Entre uma execução e outra, a fila de e-mails também sai de passagem quando entra movimento
(pedido novo, painel aberto), mas numa loja parada um e-mail que ficou na fila só sai na próxima execução. Para sair em poucos minutos, chame a rotina de fora, **sem custo**:

* **GitHub Actions** (repositório privado: ~2.000 min/mês grátis; cada chamada gasta ~1 min, então use no máximo a cada 30 min; público: ilimitado) ou **cron-job.org** (gratuito): `GET https://<seu site>/api/cron/sweep` com o cabeçalho `Authorization: Bearer <CRON_SECRET>`, a cada 5 a 30 minutos.
* A rotina é **segura de repetir**: o aviso da operação (estoque baixo, rotina com problema) e a limpeza de dados vencidos não duplicam nada, e a fila de e-mails não manda a mesma mensagem duas vezes.
* Nunca coloque o `CRON_SECRET` num arquivo do repositório: use os segredos do serviço (em GitHub Actions: *Settings → Secrets and variables → Actions*).

> A Vercel não avisa sozinha quando `/api/health` cai: é preciso cadastrar o monitor (item acima). Este repositório **não** inclui
> serviço de alertas nem envio de logs para fora da Vercel.

## 5. Backup e restauração

Tudo o que a loja tem mora em **dois lugares**: o banco **Neon** (pedidos, clientes, produtos, textos, configurações,
administradores) e o **Vercel Blob** (os arquivos das imagens; no banco fica só o endereço). Código e migrations ficam no Git.

**Neon.** O Neon guarda histórico para restaurar o banco a um momento anterior; **o tamanho dessa janela depende do plano** e a
restauração é feita no console do Neon (*Backup & Restore* / *Branches* do projeto `copocheio-db`). Confira no console qual é a janela
do seu plano: isso **não pôde ser verificado aqui** e não deve ser a única proteção.

**Cópia própria (recomendado, semanal e antes de mudanças grandes).** No seu computador, com `pg_dump` (versão igual ou mais nova que a
do Neon) e a `DATABASE_URL` do Neon:

```bash
# use a URL direta (sem "-pooler" no nome do servidor)
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file="copocheio-$(date +%F).dump"
```

Restaurar numa base vazia (para conferir, ou para recuperar):

```bash
createdb copocheio_restaurado        # ou crie um banco/branch vazio no Neon
pg_restore --no-owner --no-privileges --exit-on-error --dbname="postgres://usuario@servidor/copocheio_restaurado" copocheio-AAAA-MM-DD.dump
psql "postgres://usuario@servidor/copocheio_restaurado" -c "select count(*) from orders; select count(*) from products; select count(*) from schema_migrations;"
```

Esses dois comandos foram testados contra um PostgreSQL 16 local (25 tabelas, 35 funções e as 12 migrations voltaram idênticas); **não** foram
rodados contra o Neon de verdade. Teste a restauração **antes** de precisar dela.

- O arquivo contém **dados pessoais** (clientes, telefones, endereços): guarde fora do Git, criptografado, com acesso restrito, e
  apague as cópias antigas (uma cópia esquecida num computador também é um vazamento em potencial).
- O **Blob não entra no `pg_dump`.** Se as fotos são insubstituíveis, guarde também uma cópia dos arquivos (o painel permite enviar de
  novo; as URLs dos arquivos ficam no banco).
- Segredos (`DATABASE_URL`, `SMTP_PASS`, token do Blob) **não** estão no backup nem no Git: guarde-os num gerenciador de senhas.

## 6. Quando algo dá errado

| Sintoma | O que fazer |
| ------- | ----------- |
| Site ou painel mostram "serviço indisponível" / `/api/health` = 503 | Veja os logs (`not_configured`, `not_migrated`, erro de conexão). Confirme `DATABASE_URL` no ambiente certo e se o banco Neon está ativo no console. Banco "dormindo" só deixa a primeira chamada mais lenta |
| Painel: "Muitas tentativas de login" (`429`) | Os limites são por e-mail + rede (8 em 15 min), por rede (30 em 15 min) e, para aparelhos novos, por e-mail (40 por hora). **Aguarde ~15 minutos.** Senha certa não conta como tentativa errada. Quem digitou errado de longe só bloqueia a si mesmo, nunca o dono da conta |
| Esqueci a senha do painel | Outro **owner** usa *Configurações → Administradores → Nova senha*. Se só você é owner: no seu computador, `vercel env pull .env.local` e `npm run admin:create -- seu@email.com "Seu Nome"` (pergunta a senha nova, encerra todas as sessões da conta) |
| Perdi o celular do 2FA | Use um dos **códigos de recuperação** na tela do código (cada um vale uma vez). Sem eles: outro owner abre *Configurações → Administradores → Desligar 2 etapas* na sua conta. Se só você é owner: `npm run admin:create -- seu@email.com "Seu Nome" --reset-2fa` (também define uma senha nova e encerra as sessões). Depois ligue o 2FA de novo em *Configurações → Painel* |
| E-mails não chegam | *Estado do sistema*: "Envio de e-mail" deve estar OK; senão cadastre `SMTP_HOST`, `SMTP_USER` e `SMTP_PASS`. Abra **Painel → E-mails**: os alertas dizem o motivo (usuário/senha recusados, teto diário, fila parada). O owner pode usar *Clientes → Enviar e-mail de teste*. Veja o spam. No Gmail confira a senha de app e o limite diário (450 por dia é o teto de segurança do sistema) |
| Cliente diz que não recebeu o e-mail (código, pedido, nova senha) | *E-mails → Mensagens*: busque o e-mail dele. **Aceito pelo servidor** = a loja entregou ao servidor de e-mail (peça para olhar o spam e a aba Promoções; o SMTP comum não avisa a entrega). **Bloqueado** = o motivo aparece na linha (endereço suprimido, pediu para não receber, teto por endereço, domínio inválido). **Falhou** = o motivo técnico aparece. Nada na lista = o endereço não chegou a ser usado (confira se foi digitado no pedido ou na conta) |
| Cliente não consegue entrar: "Código incorreto ou expirado", pede o código toda vez | É assim de propósito: **a cada entrada** o login manda um código de 6 dígitos para o e-mail da conta (vale 5 min, uso único, 5 erros e a tentativa acaba; "Reenviar código" só depois de 60 s). Quem fechou a aba ou demorou mais de 30 min informa e-mail e senha de novo. O código só vale no **mesmo navegador** que digitou a senha (se ele abrir o e-mail no celular, digita o código no navegador onde está entrando). Quem já está com a sessão aberta (30 dias) não precisa de código até sair. Confira em *E-mails → Mensagens* ("Código para entrar na conta") se o e-mail foi aceito pelo servidor. Sem SMTP configurado, ninguém entra (`503 mail_not_configured`); fazer e acompanhar pedido sem conta segue normal |
| **Ninguém consegue entrar no painel** ("O código não chega", `503 mail_failed` ou `mail_not_configured` no login) | O login do painel **exige** o código enviado por e-mail e, sem e-mail, ninguém entra (de propósito). 1) Veja se o e-mail da loja está de pé: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` na Vercel e a caixa de spam do administrador. 2) Se ninguém consegue entrar para ver *Painel → E-mails*: cadastre `ADMIN_EMAIL_CODE=off` na Vercel e faça um novo deploy (emergência: o painel volta a pedir só a senha). 3) Conserte o e-mail, **remova `ADMIN_EMAIL_CODE`** e faça um novo deploy. Perdeu o acesso ao e-mail de um administrador: o owner troca o e-mail da conta em *Configurações → Administradores*; se foi o próprio owner, `npm run admin:create -- novo@email.com "Nome"` no computador (cria/atualiza a conta) |
| Administrador: "Código incorreto ou expirado", "O tempo para digitar o código acabou" | O código vale 5 minutos, é de uso único e só funciona no **mesmo navegador** que digitou a senha; 5 erros inutilizam a tentativa (informe a senha de novo) e "Reenviar código" só libera depois de 60 s (no máximo 4 envios por tentativa e 8 pedidos por hora sem entrar). Confira em *E-mails → Mensagens* ("Código de acesso ao painel") se o e-mail foi aceito pelo servidor |
| Endereço suprimido por engano (ex.: caixa criada depois) | *E-mails → Supressões → Liberar* (owner) |
| Cliente reclama de promoções que não quer | Peça para usar "Cancelar inscrição" no e-mail (ou *Minha conta → E-mails*). Pelo painel: *E-mails → Supressões → adicionar o endereço* (ele não receberá mais nenhum e-mail do sistema, inclusive os de conta e pedido) |
| Fila de e-mails parada / "Mensagens paradas na fila" | *E-mails → Visão geral → Processar fila agora* (owner). Se não resolver, abra uma mensagem e leia o motivo |
| Cron diário com falha `401` | Falta `CRON_SECRET` na Vercel (item 1) |
| O link do e-mail abre o endereço errado | Defina `SITE_URL` com o endereço público e faça um novo deploy |
| Não consigo enviar imagem | *Estado do sistema*: "Armazenamento de imagens". Limites: 4 MB e JPG, PNG, WebP, GIF ou AVIF (SVG nunca) |
| Cliente diz que o pedido "sumiu" | Busque o número em *Pedidos*. Sem o link do acompanhamento, o painel gera um novo (*Pedido → Acompanhamento do cliente*) |
| Cliente diz que não consegue adicionar ou finalizar um copão ("Escolha o tipo de gelo para continuar.") | É a regra da escolha do gelo. No site novo, a pergunta aparece ao tocar em "Adicionar"; se a pessoa está com uma aba aberta de antes do deploy, basta recarregar. Confira em *Produtos* quais produtos têm o selo "Pede o gelo" (liga e desliga no botão do floco de neve da linha ou na chave do formulário do produto; o filtro "Pedem o gelo" lista só eles). Depois de um rollback do código, veja o item 3 |
| Cliente viu o aviso de que o valor mudou ("Confirmar novo total") | É esperado: o total mostrado precisa bater com o do servidor (`409 price_changed`: preço, promoção ou taxa mudaram). A tela mostra o que mudou e pede a confirmação; nenhum pedido foi criado até ali |
| Pedido de privacidade (LGPD) | *Painel → Clientes → Privacidade*. Responda pelo contato deixado (a política informa até 15 dias). Para quem comprou como visitante, o **owner** usa *Anonimizar uma pessoa* (telefone e/ou e-mail); a conta e os links de acompanhamento são apagados e os pedidos ficam sem dados pessoais (itens, valores, datas e bairro continuam para a contabilidade). Marque como atendido |
| Suspeita de acesso indevido | 1) Troque a senha do administrador (encerra as sessões). 2) *Configurações → Atividades*: confira entradas e mudanças. 3) Ligue o 2FA. 4) Se houve vazamento de segredo, rotacione (abaixo) |
| Depois de um deploy algo quebrou | *Vercel → Deployments →* promova o deploy anterior (rollback). O banco não volta; as migrations são compatíveis com a versão anterior |

**Trocar segredos** (faça um por vez e um novo deploy depois):

- **Neon** (`DATABASE_URL`): redefina a senha do usuário no console do Neon e atualize a variável. Atenção: a chave que protege os
  códigos de e-mail em andamento deriva da `DATABASE_URL`, então códigos de confirmação ainda não usados deixam de valer (é só pedir outro).
- **SMTP**: gere uma senha nova no provedor e atualize `SMTP_PASS`.
- **Blob**: gere um token novo na integração e atualize a variável.
- **Administradores**: *Configurações → Administradores → Nova senha* (encerra as sessões da pessoa).

## 7. Por quanto tempo cada dado é guardado

A limpeza automática (`purge_expired_data`) roda sozinha de vez em quando (em logins de clientes e na criação de pedidos): não há
agendador, então com o site parado ela só roda quando houver movimento.

| Dado | Prazo | Observação |
| ---- | ----- | ---------- |
| **Pedidos** | **não são apagados sozinhos** | Histórico e obrigações fiscais; o prazo depende da contabilidade. Anonimização manual pelo owner (item 6) |
| Link de acompanhamento | 180 dias após a última atualização do pedido (configurável de 7 a 3650, *Configurações → Loja*); o registro some 30 dias depois | Pedidos de quem tem conta seguem em "Meus pedidos" |
| Conta de cliente não confirmada | 7 dias (30 para as contas antigas), **só se não tiver pedidos** | |
| Sessão do painel / do cliente | 14 dias / 30 dias (ou até sair); vencidas são apagadas | |
| Tentativas de login com código por e-mail (painel e clientes) | no máximo 1 dia (a própria tabela apaga as antigas); excluir a conta apaga as dela | Só hashes: nunca o código |
| Links de redefinição de senha, códigos de e-mail | usados ou vencidos: de 1 a 7 dias depois | Só o hash fica no banco |
| Contadores de tentativas (limites) | 1 dia | |
| **Registro dos e-mails enviados** (destinatário, tipo, data, resultado; sem corpo, código nem link) | **180 dias** (o que está na fila não é apagado; mensagem na fila há mais de 7 dias é cancelada) | Receitas de falhas: 14 dias. Alertas resolvidos: 90 dias. Excluir conta / anonimizar / "esquecer" remove o endereço na hora |
| Preferências de e-mail e lista de supressão | preferência sem informação útil: 1 ano; pedido de promoções nunca confirmado: 30 dias; consentimento e cancelamentos: enquanto a pessoa existir; supressão: até um owner liberar (a temporária expira em 7 dias) | |
| Aparelhos conhecidos do painel | 400 dias sem uso (no máximo 20 por pessoa) | |
| Códigos de recuperação do 2FA já usados | 90 dias | |
| **Registro de atividades do painel** | **2 anos** | Não pode ser alterado nem apagado antes disso |
| Pedidos de privacidade já respondidos | 2 anos | |
| Erros do navegador e bloqueios de CSP | os logs da Vercel (o prazo depende do plano) | Sem dados pessoais |

## 8. Depois de cada deploy (5 minutos)

1. `GET /api/health` → `{"ok":true}`.
2. Abra `/` e `/bebidas` (um celular e um computador) e confira a logo, o cardápio e o botão do WhatsApp.
3. Entre em `/admin`, abra *Configurações → Painel → Estado do sistema*: banco, imagens, e-mail e endereço do site em OK.
4. Se mexeu em pedidos/checkout: faça **um pedido de teste** e cancele (ele aparece nos relatórios como cancelado). Depois da migration 0013,
   confira em *Produtos* (filtro "Pedem o gelo") que os copões certos têm o selo **Pede o gelo**, e, no site, que "Adicionar" num deles pergunta o gelo
   (e que um copão sem o selo entra direto) e o pedido de teste mostra a escolha em *Pedidos*. Depois da 0022, desmarque ali os produtos que não devem perguntar.
5. Se mexeu em e-mail: *Clientes → Enviar e-mail de teste* (owner) e abra **Painel → E-mails**: nenhum alerta aberto, "Aceitas pelo servidor" subindo e a fila vazia. Depois da migration 0019, faça **um pedido de teste com um e-mail seu** e
   confira: chegou "Pedido recebido"; ao mudar a etapa no painel, chegou o aviso da etapa; abra a mensagem em **Mensagens** para ver a linha do tempo.
6. Confira nos logs da Vercel se não há `erro inesperado`, `not_configured` nem `csp-bloqueio` novos.
7. Depois da migration 0036 (retirada do pagamento pelo site): no checkout só aparecem **PIX, Dinheiro e Cartão** (na entrega ou na retirada); *Pagamentos* deixa de existir no menu do painel. Faça um pedido de teste com dinheiro: ele nasce **Novo**, sem etapa de pagamento.
10. Depois da migration 0021 (uma coluna opcional em `store_settings`, hoje sem uso no site): nada muda. Abra **/bebidas**, toque no **ⓘ** ao lado de "Aberto agora" e confira o
   **horário de funcionamento** (com o dia de hoje destacado) e as **formas de pagamento**.
13. Depois da migration 0024 (**login do painel com código por e-mail**): ANTES de sair do painel que está aberto, confirme que o envio de e-mail funciona (*Configurações → Painel → Estado do
   sistema → "Envio de e-mail": Funcionando*). Depois **abra o painel em uma janela anônima**: informe e-mail e senha em `/admin/login`, a tela deve mudar para o código, um e-mail "XXXXXX é o
   seu código de acesso ao painel" deve chegar em até 1 minuto e, digitado o código, o painel abre. Se o e-mail **não chegar** e ninguém conseguir entrar, use o interruptor de emergência
   `ADMIN_EMAIL_CODE=off` (tabela do item 1) e conserte o e-mail. Cada administrador precisa de um e-mail que **leia de verdade**: confira em *Configurações → Administradores*.
14. Depois desta versão (**e-mail de qualquer provedor**, sem migration nova): faça o **teste de verdade com pelo menos dois provedores diferentes** (por exemplo, uma conta
   Gmail e uma Outlook/Hotmail ou iCloud sua): em `/conta` crie uma conta, confira que o código chega, confirme, saia e entre de novo (outro código a cada entrada). O que o
   sistema **não consegue provar sozinho** é a entrega pelos servidores de cada provedor (veja `docs/EMAIL.md`, seção 4.1): se algum não receber, siga o roteiro de lá antes
   de mexer no código. Quem já teve o endereço recusado antes (devolução definitiva) volta a receber o código e, ao confirmá-lo, sai da lista de supressão automática.
12. Depois da migration 0023 (login do cliente com código por e-mail): **teste o login de verdade com uma conta sua**. Em `/conta`, informe e-mail e senha: a tela deve mudar
   para **"Confirme que é você"** e um e-mail "XXXXXX é o seu código para entrar" deve chegar em até 1 minuto; digite o código e a conta abre. Se o e-mail **não chegar**, ninguém
   consegue entrar na conta (os pedidos e o acompanhamento sem conta continuam normais): veja *Painel → E-mails* (configuração do SMTP, alertas e fila) e a linha "Cliente diz que
   não recebeu o e-mail" da tabela de problemas. O login do painel (`/admin`) não muda.
11. Depois da migration 0022 (gelo por produto): os copões que já perguntavam o gelo **continuam perguntando** (a migration marcou os produtos dessas categorias). Abra *Produtos* → filtro
   **Pedem o gelo** e **desmarque** (botão do floco de neve) os que não devem perguntar; no site, confira um copão desmarcado (entra direto no pedido) e um marcado (abre "Qual gelo você prefere?").

15. Depois da migration 0025 (**miniaturas das fotos de produto**; duas colunas opcionais, nada muda até gerá-las): abra *Produtos*. Se aparecer o botão **Gerar miniaturas (N)** (ele aparece sempre que houver produto com foto e sem miniatura; esses produtos têm o selo **Miniatura pendente**), clique nele **uma vez**,
   confirme e **deixe a página aberta** até o aviso "Miniaturas geradas" (cada foto leva cerca de 1 segundo; se fechar no meio, é só voltar e clicar de novo: continua de onde parou). Depois,
   abra `/bebidas` no celular e confira que as fotos aparecem nítidas (a lista usa a cópia de 400 px; "Os favoritos da galera", a de 720 px). Nas Ferramentas do desenvolvedor do navegador (aba *Rede* → *Img*), as fotos da lista devem
   ter uns 10 a 30 KB cada, e não mais 100 a 300 KB. Se algum produto ficar de fora (a mensagem diz quantos), o botão volta com a contagem: tente de novo. Fotos de **outro site** só são lidas se o endereço for público e responder com uma imagem de até 4 MB; se o site de origem saiu do ar, envie a foto de novo no cadastro do produto (ao salvar, as miniaturas são geradas junto). **Voltar o código** para antes desta versão não quebra
   nada (as colunas ficam sem uso). Fotos cadastradas por importação com endereço de **outro site** não são tocadas.
16. **Região das funções × região do Neon** (conferir uma vez; é a maior fonte de lentidão que o código não resolve): na Vercel, *Settings → Functions → Function Region*; no Neon, a região do projeto `copocheio-db`.
   Se as duas estiverem longe uma da outra (por exemplo, funções em Washington e banco em São Paulo), **cada consulta ao banco paga a viagem de ida e volta** (~100 a 150 ms), e o cardápio e os pedidos ficam mais lentos
   que o necessário. O ideal é a **mesma região** (ou a mais próxima possível dos clientes, hoje no Brasil). O código não decide isso: é uma configuração do projeto na Vercel.
17. Depois da migration 0027 (**maioridade 18+ e cancelamento pelo cliente**): todo produto passa a ser "Bebida alcoólica" (é o lado seguro). Abra *Produtos* e **desmarque "Bebida alcoólica"** nos que não são
   (refrigerante, água, energético, gelo, copos etc.): é o que decide se o checkout pede a declaração de maioridade e se o painel pede a conferência do documento. Depois confira:
   (a) no navegador anônimo, `/bebidas` abre a janela "Venda proibida para menores de 18 anos" e **Tenho 18 anos ou mais** libera o cardápio; (b) um pedido de teste com bebida alcoólica só
   finaliza com a caixa de declaração marcada; (c) em *Pedidos*, esse pedido mostra **Conferir documento 18+** e só vai para "entregue" depois do clique em **Conferi: 18 anos ou mais**;
   (d) na página de acompanhamento de um pedido novo, **Cancelar este pedido** cancela e devolve o estoque (confira em *Produtos*), e o e-mail "pedido cancelado" chega.
   **Procedimento de entrega (para quem entrega):** peça um documento oficial **com foto**, confira que a pessoa tem 18 anos ou mais e que o documento é dela; **não fotografe, não copie nem anote** o número do documento
   (o sistema não guarda documento). Se não houver documento válido ou a pessoa for menor, **não entregue**: no painel use **Recusar entrega (maioridade não comprovada)**. Entregou? Marque como entregue e confirme a conferência.
   Os textos que o cliente lê precisam da validação jurídica: [`JURIDICO-PENDENCIAS.md`](JURIDICO-PENDENCIAS.md).
   **Cuidado com o rollback do código:** depois da 0027 o **banco** passa a exigir `age_confirmed: true` em pedidos com bebida alcoólica. A versão anterior do site **não envia isso**, então, se o código voltar para antes
   desta versão, **os pedidos com bebida alcoólica são recusados** (erro `age_required`) até o código novo voltar. Saída de emergência (só se precisar mesmo do código antigo): no Neon, `update products set alcoholic = false;`
   (isso desliga a exigência e a conferência de maioridade para TODOS os produtos; refaça a marcação no painel quando o código novo voltar). A 0027 não apaga nem altera pedidos; o painel antigo continua mudando status (os argumentos novos têm padrão).
18. (Retirado) A devolução de pagamento online pelo painel (migration 0028) deixou de existir junto com o pagamento pelo site. O dono combina a devolução com o cliente e marca o pedido como **reembolsado** à mão.
19. Depois da migration 0029 (**cupons e entrega grátis por valor**): nada muda no site (nenhum cupom existe e a entrega grátis nasce **desligada**). Para usar: *Cupons* (só o owner) → *Novo cupom* e, para a entrega grátis, *Configurações → Entrega*
   → "Entrega grátis a partir de um valor". Confira com um pedido de teste: o desconto aparece no resumo do checkout, no pedido e no painel; um cupom desligado/vencido/esgotado é recusado com a mesma mensagem ("inválido ou expirado", para não
   revelar quais códigos existem). **Regras**: um cupom por pedido; o desconto nunca passa do valor dos itens elegíveis; cupom de porcentagem pode ter teto; o pedido mínimo do cupom e o da entrega olham o subtotal **antes** do desconto; a entrega grátis por valor
   olha o subtotal **depois** do cupom; pedido cancelado não conta como uso; apagar ou mudar um cupom **nunca** altera um pedido já feito (o pedido guarda o código, o desconto e a taxa dispensada). Cupom que cobre o pedido inteiro deixa o total em R$ 0,00 (vale: todo pagamento é feito à loja). Rollback do código: a versão anterior ignora cupom e entrega grátis (as colunas ficam sem uso); pedidos feitos com cupom continuam corretos.
20. **Exportar CSV** (sem migration): *Pedidos* e *Clientes* → **Exportar CSV** (só o owner, porque têm nome, telefone, e-mail e endereço: dados pessoais da LGPD); *Estoque* → Exportar CSV (qualquer administrador). Cada exportação aparece em
   *Configurações → Painel → Registro de atividades* (quem, filtros, quantas linhas; nunca o conteúdo). A planilha abre no Excel/Google Planilhas em português (separador ";", acentos certos). Textos que começam com `=`, `+`, `-` ou `@` recebem um apóstrofo
   (proteção contra "injeção de fórmula" em planilhas). Guarde o arquivo com cuidado e apague quando não precisar mais; limite de 20 exportações por hora por pessoa e 20.000 linhas.
21. **CEP no checkout** (sem migration): o campo "CEP (opcional)" consulta o ViaCEP **pelo nosso servidor** (rota `/api/cep/:cep`): serviço público e gratuito, sem chave e sem custo; ele só recebe o CEP (nada do cliente). Se estiver fora do ar, o cliente preenche o endereço à mão e o pedido segue.
   Nenhuma variável é necessária (`CEP_API_URL` só existe para os testes). Limite de 60 consultas por 10 minutos por rede e cache de 24 horas por CEP no servidor.

22. Depois da migration 0030 (**agendamento, feriados e horários especiais**): tudo nasce **desligado/vazio** (nenhum pedido existente muda). *Configurações → Entrega → Agendamento de pedidos*: ligue, escolha a antecedência mínima, até quantos dias à frente, o tamanho da faixa
   (15/30/60/120 min) e, se quiser, quantos pedidos por faixa. *Configurações → Horários → Dias especiais*: cadastre feriados (fechado) ou horário especial (sem virar a meia-noite). Confira com um pedido de teste: no checkout aparece "O quanto antes / Agendar";
   com a loja fechada só dá para agendar; o pedido mostra o horário no acompanhamento e no painel. A conferência é **do banco** (um pedido feito direto à API fora das regras é recusado).
23. Depois da migration 0031 (**endereços extras na conta**): *Minha conta → Outros endereços* (até 4 além do principal); no checkout, quem está logado escolhe um deles. Nada muda para quem não usa.
24. Depois da migration 0032 (**limite de estoque baixo**): o padrão continua 5 (o mesmo de antes). Mude em *Estoque* (padrão da loja) ou por produto; o painel inicial avisa "estoque baixo" e "esgotado". **Aviso por e-mail:** nasce **ligado**; os donos recebem
   um e-mail quando a lista de produtos com estoque baixo/esgotado muda (no máximo um por dia; só sai se o envio de e-mail estiver configurado). Para desligar: *Estoque → Avisar os donos por e-mail*. O mesmo e-mail avisa se a rotina automática falhou ou ficou mais de 30 horas sem rodar.
25. Depois da migration 0033 (**termos e políticas**): *Configurações → Termos e políticas* (só o owner) traz cinco textos padrão (termos, cancelamento e trocas, entrega, pagamento e reembolso, contato e responsável) que descrevem **o que o sistema faz**, sem prazos, leis, CNPJ nem endereço.
   **Preencha a página "Contato e responsável"** com a razão social, o CNPJ e o endereço reais e **mande o jurídico revisar os cinco textos** ([`JURIDICO-PENDENCIAS.md`](JURIDICO-PENDENCIAS.md)); marque como revisado só depois (editar o texto tira a marca). Os links já aparecem no rodapé do site.
26. Depois da migration 0034 (**entregadores, avaliações e registro da rotina automática**): *Configurações → Entrega → Entregadores* (cadastre quem entrega; no pedido de entrega, escolha o entregador: o cliente vê só o primeiro nome, enquanto o pedido está a caminho).
   *Avaliações* (menu): o cliente avalia depois da entrega; **nada aparece no site até você publicar**; apague comentários com dado pessoal. Nada muda para quem não usa.
27. **Rotina automática**: cadastre `CRON_SECRET` (item 1) **antes** do deploy; o cron diário da Vercel passa a chamar também `/api/cron/sweep`. Depois do primeiro dia, *Configurações → Painel → Estado do sistema → Rotina automática* deve mostrar a última execução. Para checar o Pix vencido
   a cada poucos minutos, use um agendador externo gratuito (seção 4, "Rotina com mais frequência").
28. **Site instalável, buscadores e medição de visitas** (sem migration; [`PWA-SEO-ANALYTICS.md`](PWA-SEO-ANALYTICS.md)): depois do deploy confira `https://<seu site>/robots.txt` (termina com a linha `Sitemap:`), `/sitemap.xml` (8 endereços públicos) e, no Chrome, *DevTools → Application → Manifest/Service Workers*.
   Cadastre o site no Google Search Console e envie o sitemap. A medição de visitas (GA4) **só liga** com `GA_MEASUREMENT_ID` **e** a liberação do Google na política de segurança (decisão sua; veja o documento).

29. Depois da migration 0035 (**programa de pontos**): nasce **desligado e sem nenhum valor**. Em *Fidelidade* (só o owner) defina **você** as quatro regras — pontos por R$ 1,00 gasto em produtos, pontos necessários para a troca, valor do cupom (R$) e validade (dias) — e só então ligue.
   Como funciona: o cliente **com conta** ganha pontos quando o pedido vira "entregue" (sobre os itens depois do desconto; entrega e taxas não contam; visitante não ganha); se o pagamento é **devolvido** depois, o crédito é estornado (o saldo pode ficar negativo se os pontos já foram trocados);
   em *Minha conta → Meus pontos* ele troca os pontos por um **cupom pessoal** de valor fixo (uso único, só da conta dele, no campo de cupom do checkout). Acerto manual (dar ou tirar pontos, sempre com motivo, no registro de atividades) em *Fidelidade*. **Antes de ligar:** o texto do programa
   e a regra de resgate precisam de validação jurídica/fiscal ([`JURIDICO-PENDENCIAS.md`](JURIDICO-PENDENCIAS.md)). Desligar não apaga saldos (ficam guardados); excluir a conta do cliente apaga os pontos e os cupons dele.

30. Depois da migration 0037 (**escolha dos gelos saborizados dos combos**): o cliente que adiciona um combo que traz gelos escolhe os sabores (exatamente a quantidade do combo, em geral 4) entre os produtos que a loja marcou como **gelo saborizado**. **Nada é uma lista fixa do site**: a fonte é o cadastro de produtos.
   **Confira em *Produtos* logo depois do deploy** (a migration só faz um ponto de partida): (a) os gelos saborizados precisam ter o selo **Gelo saborizado** (filtro "Gelos saborizados"); a migration marcou os produtos cujo nome começa com "Gelo" (ou que estão numa categoria de gelo) e que não são tradicionais, em kg ou de barra: desmarque o que não serve e marque o que faltou (cartão "Gelo" do produto → *Este produto é um gelo saborizado*); (b) os combos precisam ter o selo **Combo com 4 gelos** (filtro "Combos com gelos"); a migration pôs 4 nos combos da categoria "Combos" cujo nome ou descrição cita "4 gelos": ajuste o número em *Gelos saborizados que vêm neste combo* (0 = o combo não pede a escolha). Só entra na escolha quem estiver **ativo** e **fora de esgotado**; esgotado aparece, mas não se escolhe.
   O preço do combo **não muda**. Os gelos escolhidos saem do **estoque** do próprio produto (quando ele controla estoque) e voltam se o pedido for cancelado. Os sabores ficam na linha do pedido (`order_items.ice_flavors`) e aparecem no carrinho, no checkout, no acompanhamento, em *Minha conta*, no pedido do painel, no recibo, no CSV e no WhatsApp; **não vão para as observações**. Cada unidade do combo é uma linha com a SUA escolha.
   **Se não houver nenhum gelo saborizado disponível, os combos com gelos não podem ser comprados** (a escolha exige a quantidade exata): por isso o ponto de partida só põe a quantidade nos combos se existir ao menos um gelo saborizado cadastrado.
   **Rollback do código**: a versão anterior do site não envia os sabores, então depois da 0037 ela não consegue fechar pedido de combo com gelos (o servidor responde `ice_flavors_required`). Saída de emergência: no Neon, `update products set combo_ice_count = 0;` (desliga a escolha em todos os combos; refaça no painel depois). Uma aba aberta de antes do deploy só passa a perguntar os sabores depois de recarregar.

### Roteiro de implantação segura (esta versão, migrations 0027 a 0035)

Nada abaixo foi feito pelo desenvolvimento: **o deploy e o uso de credenciais de produção são seus**. Ordem recomendada:

1. **Backup lógico antes de tudo** (seção 5) e anote o ponto no tempo do Neon.
2. **Teste num ambiente separado primeiro**: crie um *branch* do Neon (cópia do banco de produção), aponte o ambiente *Preview* da Vercel para ele (seção 2 deste guia: `DATABASE_URL` só no ambiente Preview) e faça um deploy de preview com `MIGRATE_ON_PREVIEW=1`.
   Confira que as 11 migrations (0027 a 0037) aplicam sem erro e que o site de preview abre, cardápio e pedido de teste funcionam.
3. **Variáveis de produção**: `CRON_SECRET` (obrigatória para os crons), `SITE_URL` (recomendada), `GA_MEASUREMENT_ID` (opcional).
4. **Atenção ao rollback**: depois da 0027 o código **antigo** não fecha pedido com bebida alcoólica (item 17). Se precisar voltar o código, siga a saída de emergência do item 17.
5. **Deploy de produção** (`git push` no branch de produção): a Vercel aplica as migrations **antes** do build; se uma falhar, o site antigo continua no ar.
6. **Depois do deploy**: percorra os itens 15 a 30 acima (principalmente 17: marcar o que **não** é bebida alcoólica) e o checklist da seção 8.
7. **Pagamento pelo site**: não existe (retirado). Se quiser oferecê-lo no futuro, será um projeto novo, com orçamento e teste em sandbox antes de qualquer cobrança real.

## 9. O que este guia não cobre

- Alertas automáticos do **site** (queda, pico de erros), painel de métricas e retenção de logs fora da Vercel: não existem neste repositório. (Os **e-mails** têm painel e alertas próprios: [`EMAIL.md`](EMAIL.md).)
- Restauração do Neon e rollback da Vercel: descritos conforme a documentação dos serviços, **não testados aqui** (o ambiente de
  desenvolvimento não tem acesso à produção).
- Análise jurídica: a política de privacidade do site descreve o que o sistema faz, mas razão social, CNPJ e encarregado (DPO)
  precisam ser preenchidos e o texto revisado por quem entende de LGPD.
