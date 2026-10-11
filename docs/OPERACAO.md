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
| `SITE_URL` | Endereço público do site (ex.: `https://www.seudominio.com.br`) usado **nos links dos e-mails**, na logo dos e-mails e no endereço canônico das páginas | Na Vercel: em produção, o domínio de produção do projeto (`VERCEL_PROJECT_PRODUCTION_URL`); em preview, o endereço do deploy. Fora da Vercel só vale `localhost`; qualquer outro endereço sem `SITE_URL` impede montar o e-mail (`503`) e o painel mostra "Endereço do site: Não configurado" |
| `MIGRATE_ON_PREVIEW` | `1` = deploys de teste (preview) também aplicam migrations. **Só** se o ambiente *Preview* usar um banco **separado** | Previews apenas listam as migrations pendentes e **não** mexem no banco |
| `SHELL_HTML_FILE` | Avançado: caminho do `index.html` usado na página para robôs (WhatsApp, Facebook, Google). Os testes usam | Usa `dist/index.html`, que a Vercel inclui na função (`vercel.json` → `includeFiles`) |
| `ADMIN_PASSWORD` | Só para rodar `npm run admin:create` sem digitar (CI, testes). **Não cadastre na Vercel** | O script pergunta a senha |

Definidas pela própria Vercel (não cadastre): `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`.

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

**Exceção conhecida: a migration 0013 (escolha do gelo).** Ela segue as regras acima (só acrescenta colunas e troca funções), com duas
ressalvas que você precisa conhecer:

1. Ela escreve **uma linha de dados**: liga `categories.ice_choice_required` nas categorias chamadas "Copão" e "Copão com Monster" (o nome
   só é usado nesse momento, sem diferenciar maiúsculas, acentos ou espaços). Se na loja elas têm outro nome, a regra **não** liga sozinha:
   ligue em *Categorias → Editar → Pedir a escolha do gelo* (confira depois do deploy, passo 4 do item 8).
2. A regra é conferida **no banco**, então a versão antiga do site (que não sabe perguntar o gelo) é recusada ao pedir produtos dessas
   categorias, com a mensagem "Escolha o tipo de gelo para continuar.". Isso acontece (a) nos poucos minutos entre a migration rodar e o
   site novo entrar no ar e (b) **depois de um rollback do código**. O resto do site (outras categorias) segue normal. Para voltar o código
   sem perder pedidos de copão, desligue a regra no SQL Editor do Neon: `update categories set ice_choice_required = false;` (quando
   voltar ao código novo, ligue de novo em *Categorias*). Quem estava com o site aberto de antes só precisa recarregar a página.

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
| Atividade no painel | *Configurações → Atividades* (só o owner): quem mudou o quê e quando, entradas de aparelho novo, 2FA, privacidade. Guardado por 2 anos, não editável |

**Sinais que merecem olhar:** `/api/health` em 503; vários `500`/`erro inesperado` seguidos; `not_configured` ou `not_migrated` nos
logs (variável faltando ou migration não aplicada); muitos `429` em login (alguém testando senhas); e-mails de "Novo acesso ao
painel" que você não reconhece.

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
| E-mails não chegam | *Estado do sistema*: "Envio de e-mail" deve estar OK; senão cadastre `SMTP_HOST`, `SMTP_USER` e `SMTP_PASS`. O owner pode usar *Clientes → Enviar e-mail de teste*. Veja o spam. No Gmail confira a senha de app e o limite diário |
| O link do e-mail abre o endereço errado | Defina `SITE_URL` com o endereço público e faça um novo deploy |
| Não consigo enviar imagem | *Estado do sistema*: "Armazenamento de imagens". Limites: 4 MB e JPG, PNG, WebP, GIF ou AVIF (SVG nunca) |
| Cliente diz que o pedido "sumiu" | Busque o número em *Pedidos*. Sem o link do acompanhamento, o painel gera um novo (*Pedido → Acompanhamento do cliente*) |
| Cliente diz que não consegue adicionar ou finalizar um copão ("Escolha o tipo de gelo para continuar.") | É a regra da escolha do gelo. No site novo, a pergunta aparece ao tocar em "Adicionar"; se a pessoa está com uma aba aberta de antes do deploy, basta recarregar. Confira em *Categorias* quais categorias têm "Pede o gelo" (liga e desliga em *Editar*). Depois de um rollback do código, veja o item 3 |
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
| Links de redefinição de senha, códigos de e-mail | usados ou vencidos: de 1 a 7 dias depois | Só o hash fica no banco |
| Contadores de tentativas (limites) | 1 dia | |
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
   confira em *Categorias* que "Copão" e "Copão com Monster" mostram **Pede o gelo**, e, no site, que "Adicionar" num copão pergunta o gelo
   e o pedido de teste mostra a escolha em *Pedidos*.
5. Se mexeu em e-mail: *Clientes → Enviar e-mail de teste* (owner).
6. Confira nos logs da Vercel se não há `erro inesperado`, `not_configured` nem `csp-bloqueio` novos.

## 9. O que este guia não cobre

- Alertas automáticos, painel de métricas e retenção de logs fora da Vercel: não existem neste repositório.
- Restauração do Neon e rollback da Vercel: descritos conforme a documentação dos serviços, **não testados aqui** (o ambiente de
  desenvolvimento não tem acesso à produção).
- Análise jurídica: a política de privacidade do site descreve o que o sistema faz, mas razão social, CNPJ e encarregado (DPO)
  precisam ser preenchidos e o texto revisado por quem entende de LGPD.
