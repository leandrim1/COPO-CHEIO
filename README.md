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
vercel env pull .env.local   # DATABASE_URL e a credencial do Blob do projeto
npm run dev                  # site + API em http://localhost:5173
npm run build                # confere os tipos (site e servidor) e gera a versão de produção
npm test                     # tipos + testes unitários + testes de API (precisa de um PostgreSQL local: veja tests/README.md)
```

Mais documentação: [`docs/OPERACAO.md`](docs/OPERACAO.md) (variáveis de ambiente, deploy e migrations, monitoramento, backup, o que
fazer quando algo quebra, prazos de guarda dos dados) e [`tests/README.md`](tests/README.md) (como rodar os testes e o que eles cobrem).

## Páginas

| Site                | O que é                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `/`                 | Hero, Contato, chamada final ("Deu sede?") e rodapé                          |
| `/bebidas`          | Cardápio: capa com banner, carrossel de banners, busca, categorias, favoritos, ESGOTADO |
| `/checkout`         | Dados do cliente, entrega ou retirada, endereço, pagamento, observações      |
| `/pedido/:codigo`   | Confirmação: "Pedido recebido!", andamento, link de acompanhamento, WhatsApp |
| `/acompanhar-pedido`            | Sem login: acompanhar sem cadastro (número + código) ou entrar na conta. Com login: só os pedidos em andamento da conta |
| `/acompanhar-pedido/:codigo`    | Link permanente do pedido: andamento ao vivo, itens, pagamento     |
| `/conta` · `/conta/pedidos` · `/conta/pedidos/:numero` | Conta (opcional): dados, "Meus pedidos", detalhe e "pedir de novo" |
| `/conta/recuperar` · `/conta/redefinir/:codigo`        | Esqueci a senha: link por e-mail (ou, sem e-mail, telefone + pedido) e tela da senha nova |
| `/conta/verificar/:codigo`                             | Link do e-mail de confirmação (um toque no botão ativa a conta) |
| `/privacidade`      | Política de privacidade (LGPD): quais dados, para quê, por quanto tempo; pedido de acesso, correção ou exclusão; botão para apagar os dados guardados neste aparelho (e, se a loja liga a medição de visitas, a escolha de aceitar ou não) |
| `/termos` · `/trocas-e-cancelamentos` · `/entrega` · `/pagamento-e-reembolso` · `/contato-e-responsavel` | Termos de uso, cancelamento e trocas, entrega e retirada, pagamento e reembolso, contato e responsável: **texto editável pelo owner no painel** (texto padrão que descreve o que o sistema faz, sem inventar prazos, leis, CNPJ nem endereço) |

Endereço que não existe mostra "Página não encontrada" (e responde `404` para o Google, que recebe o HTML pronto; veja [Robôs e prévia de links](#robôs-e-prévia-de-links)).

| Painel (só administradores)                    | O que faz                                                   |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `/admin/login`                                 | Entrar com e-mail e senha **e o código de 6 dígitos enviado ao e-mail da conta** (mais o código do aplicativo, se a conta usa verificação em duas etapas) |
| `/admin/dashboard`                             | Pedidos e faturamento do dia/semana/mês, gráficos, recentes |
| `/admin/pedidos` · `/admin/pedidos/:numero`    | Pedidos ao vivo, filtros (status, data, conta/visitante), busca, status, histórico, link de acompanhamento, impressão |
| `/admin/clientes`                              | Contas de clientes (confirmadas / aguardando confirmação do e-mail), estado do envio de e-mails e e-mail de teste, link de nova senha, desativar, excluir; **pedidos de privacidade (LGPD)** e anonimização (owner) |
| `/admin/produtos` · `/novo` · `/:id`           | Cadastrar, editar, duplicar, excluir, destacar, esgotar; promoção com data de início e fim; importar do cardápio antigo (JSON ou planilha) |
| `/admin/categorias`                            | Criar, editar, ordenar, ativar/desativar                    |
| `/admin/cupons` (só o owner)                   | Cupons de desconto e entrega grátis                         |
| `/admin/avaliacoes`                            | Avaliações dos pedidos entregues: publicar, esconder, apagar |
| `/admin/fidelidade` (só o owner)               | Programa de pontos: regras, resumo, acerto manual e movimentos |
| `/admin/estoque`                               | + adicionar / − retirar; 0 = ESGOTADO automático            |
| `/admin/site`                                  | Logo, nome, Hero, textos das seções, SEO                    |
| `/admin/banners`                               | Banner da capa da página Bebidas (no lugar dos gelos) e carrossel do cardápio, com imagem de celular e de computador |
| `/admin/configuracoes`                         | Abas: Loja, Horários (+ feriados e horários especiais), Entrega (+ entrega grátis, agendamento e entregadores), Pagamento, **Termos e políticas** (só o owner), **Painel** (som, minha senha, verificação em duas etapas, estado do sistema), Administradores e **Atividades** (só o owner: quem mudou o quê) |

Qualquer `/admin/*` sem login vai para `/admin/login`, e o servidor confere a sessão em **toda** chamada
administrativa: esconder a tela no navegador não é a proteção. O código do painel só é baixado quando alguém abre `/admin`.

## Colocar no ar (uma vez)

O projeto `copocheio` na Vercel já está ligado ao Neon `copocheio-db` e ao Blob `copocheio-uploads`.

1. **Variáveis** — em *Settings → Environment Variables* do projeto confirme que existem `DATABASE_URL`
   (integração Neon) e a credencial do Blob, marcadas para *Production*. O Blob tem dois jeitos de autenticar, e o
   servidor aceita os dois: o clássico, com `BLOB_READ_WRITE_TOKEN` (ou `<PREFIXO>_READ_WRITE_TOKEN`), e o novo, sem
   token, com `BLOB_STORE_ID` + OIDC da Vercel (as variáveis `BLOB_STORE_ID` e `BLOB_WEBHOOK_PUBLIC_KEY` indicam o modo
   novo; o projeto precisa estar com *OIDC* ligado em *Settings → Security*). O Blob precisa ser **público** (as fotos
   aparecem no site). Na internet, `GET /api/health` só diz se o site está de pé (`{"ok":true}`, ou `503` se o banco não responde); o
   que está faltando, com o **nome** das variáveis, aparece só para administradores logados, em *Configurações → Painel → Estado do sistema*.
   A tabela completa de variáveis, e o que acontece quando faltam, está em [`docs/OPERACAO.md`](docs/OPERACAO.md).
2. **E-mail (necessário para criar contas de clientes e recuperar a senha por e-mail)** — veja [Confirmação do e-mail](#confirmação-do-e-mail-contas-de-clientes):
   cadastre `SMTP_HOST`, `SMTP_USER` e `SMTP_PASS`. **Enquanto faltarem, ninguém consegue criar conta nem entrar nela**
   (pedir e acompanhar pedidos sem conta continua funcionando, e o painel mostra um aviso com o que falta).
3. **Endereço do site (`SITE_URL`)** — cadastre o endereço público (ex.: `https://www.seudominio.com.br`). Os links dos e-mails
   (confirmar conta, "esqueci a senha") e a logo deles são montados a partir dele, **nunca** a partir do que o navegador envia
   (isso permitiria mandar à vítima um link para um site falso). Sem a variável, na Vercel vale o domínio de produção do projeto;
   fora da Vercel só `localhost` funciona.
4. **Deploy** — o script `vercel-build` roda `node scripts/migrate.mjs` antes do build: ele cria as tabelas no Neon
   (`db/migrations`) e carrega o conteúdo inicial (os mesmos textos que o site já tinha). Nenhum produto, preço ou
   categoria é inventado. Rodar de novo não faz nada de novo. **Só o deploy de produção aplica migrations**: deploys de teste
   (preview) apenas listam as pendentes, para nunca alterar o banco da loja por engano; para ter previews com banco próprio, veja
   [`docs/OPERACAO.md`](docs/OPERACAO.md) (`MIGRATE_ON_PREVIEW`).
5. **Primeiro administrador (owner)** — no seu computador, com as variáveis baixadas (`vercel env pull .env.local`):

   ```bash
   npm run admin:create -- seu@email.com "Seu Nome"
   ```

   Ele pergunta a senha (mínimo de **10** caracteres, sem senhas comuns, sequências nem o próprio e-mail) sem mostrá-la. A senha é
   guardada só como hash (scrypt). Rodar de novo com o mesmo e-mail troca a senha e **encerra todas as sessões** dessa conta.
   Os outros administradores o owner cria pelo painel, em *Configurações → Administradores*.
6. Entre em `/admin`, **ligue a verificação em duas etapas** (*Configurações → Painel*), configure **WhatsApp, Instagram, endereço,
   horário, entrega e pagamento** em *Configurações* e cadastre (ou importe) os produtos.

## Migrar o cardápio antigo

*Produtos → Importar*: escolha um arquivo ou **cole** o conteúdo. Aceita **JSON** (no formato do antigo `produtos.json`) ou
**planilha** (CSV com `;` ou `,`, ou colado do Excel/Google Planilhas, com TAB; aspas protegem separadores dentro do texto):

```json
[
  { "name": "Coca-Cola 2L", "price": 12.0, "category": "Refrigerantes", "description": "…", "image": "https://…", "featured": true, "available": true }
]
```

```csv
nome;preço;categoria;promoção;estoque;destaque;esgotado
Coca-Cola 2L;12,00;Refrigerantes;10,90;24;sim;não
```

No JSON valem também `nome`, `preco`, `categoria`, `descricao`, `imagem`, `destaque`. Na planilha, a primeira linha dá os títulos
(`nome` e `preço` são obrigatórios; também `categoria`, `promoção`, `descrição`, `imagem`, `sku`, `estoque`, `destaque`, `esgotado`).
Antes de enviar, a tela mostra quantos itens foram lidos. **Cada linha é validada sozinha**: a linha com problema não derruba as
outras, e no fim aparece um **relatório linha a linha** (importado / já existia / repetido no arquivo / com problema e o motivo).
As categorias que não existirem são criadas; produto com o mesmo nome e categoria não é duplicado; `available: false` entra como
ESGOTADO; no máximo **500 produtos** por vez. Imagens com link público continuam funcionando — para guardá-las no Blob, abra o
produto e envie a foto.

## Como funciona

- **Pedido**: o checkout chama `POST /api/orders`; o servidor confere tudo de novo dentro do banco (`create_order`) — preço
  (sempre o do banco, inclusive promocional, e só dentro das datas da promoção), produto ativo, esgotado, estoque, horário de
  funcionamento, pausa de pedidos, entrega/retirada, bairro e taxa, pedido mínimo, forma de pagamento e troco. **O preço enviado
  pelo navegador é ignorado.** Os produtos ficam travados durante a compra, então dois clientes ao mesmo tempo nunca levam a
  mesma última unidade. O número do pedido é sequencial (começa em **#1001**).
  - **Sem pedido duplicado**: cada envio leva uma chave única (`idempotency_key`). Toque duplo, internet que cai e volta ou
    "reenviar" devolvem o **mesmo** pedido em vez de criar outro; a mesma chave com um pedido diferente é recusada (`409 idempotency_conflict`).
  - **Sem preço trocado em silêncio**: o checkout manda o total que a pessoa viu (`expected_total`). Se o servidor chega a um valor
    diferente (preço, promoção ou taxa mudaram), **nenhum pedido é criado**: o site mostra o que mudou e só envia depois de a pessoa
    tocar em "Confirmar novo total" (`409 price_changed`).
  - **Contra pedidos falsos**: campo-isca invisível, tempo mínimo de preenchimento (medido no navegador), limites por rede (60
    tentativas e 20 pedidos a cada 10 min; o pedido devolvido pela chave não gasta limite) e, no banco, no máximo 5 pedidos por
    telefone a cada 10 min. Não há captcha; se ainda aparecer abuso, o próximo passo é acrescentar um (por exemplo, Cloudflare Turnstile).
- **Itens**: nome e preço são gravados no pedido. Mudar o produto depois não altera pedidos antigos.
- **Escolha do gelo (só nos produtos que a loja marcar)**: os produtos marcados só entram no pedido com a escolha **🧊 Gelo normal** ou
  **🍓 Gelo de sabor**; os outros (mesmo da categoria Copão) são pedidos direto, sem pergunta.
  - *Quem define a regra*: uma marca em cada **produto** (`products.ice_choice_required`), escolhida no painel; nem a categoria nem o
    nome decidem. Em *Produtos* há três jeitos de marcar: o botão do **floco de neve** na linha do produto (azul = pede o gelo), a chave
    **Pedir a escolha do gelo** no formulário do produto (cartão "Gelo") e, para conferir, o selo **Pede o gelo** e o filtro "Pedem o
    gelo". Vale para o site na hora. Produto novo nasce **sem** a marca (a loja liga um a um); duplicar um produto copia a marca;
    renomear o produto ou a categoria, ou mudá-lo de categoria, não muda a regra. *De onde veio*: a migration `0013_ice_choice.sql`
    marcava categorias ("Copão" e "Copão com Monster"); a `0022_ice_per_product.sql` passou a marca para o produto e, **uma única vez**,
    marcou os produtos que estavam nessas categorias (para o site não mudar de comportamento no instante do deploy). **Depois do deploy,
    desmarque no painel os produtos que não devem perguntar o gelo.** A marca antiga da categoria (`categories.ice_choice_required`) ficou
    no banco, sem uso, e saiu da tela *Categorias*.
  - *No site*: tocar em "Adicionar" num desses produtos abre "**Qual gelo você prefere? ***" com dois cartões (celular: folha que sobe
    de baixo; computador: janela no centro). Nada é adicionado sem escolher: o botão mostra "Escolha o tipo de gelo para continuar." e a
    opção escolhida fica destacada; dá para trocar de ideia antes de adicionar. A pergunta volta a cada unidade adicionada (sem opção
    marcada de antemão). Cada gelo é uma **linha separada** do pedido, com a sua quantidade (o mesmo copão com os dois gelos aparece
    duas vezes), e o cartão do produto mostra quantos já estão no pedido. Na gaveta do pedido e no checkout cada linha mostra o gelo e um
    "Alterar", que abre a mesma pergunta com a escolha atual marcada (se o outro gelo já estiver no pedido, as quantidades se somam). A
    escolha fica guardada no aparelho junto com o pedido (sobrevive a recarregar a página e a navegar). Um pedido guardado **antes** desta
    mudança com copão sem gelo continua no carrinho, marcado "Escolher o gelo *": "Finalizar pedido" mostra a mesma mensagem e não segue
    até escolher. "Pedir de novo" (em *Minha conta*) leva o gelo que foi escolhido naquele pedido.
  - *No servidor*: `create_order` (no banco) recusa o pedido se algum item de produto marcado vier sem `ice_choice` válido
    (`"normal"` ou `"flavored"`): `400` com `code: "ice_required"`, a mensagem acima e a lista dos produtos que faltam; **nada é criado e
    nenhum estoque fica reservado**. Isso vale para qualquer requisição, não só a do site. Em produto que não pede, o campo é
    ignorado (nada muda para os outros produtos). Estoque e o limite de 99 por produto contam a **soma** das linhas do mesmo produto.
    A escolha é gravada em `order_items.ice_choice` e entra na chave de idempotência (repetir o envio com outro gelo é um pedido
    diferente). Preço, frete, total e pagamento não mudam por causa do gelo.
  - *Onde aparece*: gaveta do pedido, checkout, página do pedido e de acompanhamento, mensagem de WhatsApp para a loja, "Meus pedidos"
    (resumo), pedido no painel e recibo impresso. O ranking de mais vendidos do dashboard soma os dois gelos do mesmo produto.
- **WhatsApp**: só depois que o pedido está salvo, a página do pedido mostra o botão com a mensagem pronta para o número
  configurado no painel. O número da loja já vem preenchido — (34) 9244-1191, pela migration `0026_store_whatsapp_novo.sql`
  (que troca o número da `0008_store_whatsapp.sql`, (34) 99128-3384, só onde ele ainda é esse: número que a loja já mudou, ou campo
  deixado vazio de propósito, não é tocado) — e vale para todos os botões de WhatsApp do site (Contato, chamada final, cardápio
  vazio, pedido e acompanhamento) e para o rodapé dos e-mails. Para trocar ou tirar, é só editar *Configurações → Loja →
  WhatsApp da loja* (sem número, o botão abre o WhatsApp para a pessoa escolher o contato). Se a API estiver fora do ar e o
  navegador não tiver cópia do site, o botão de ajuda usa o número de `src/lib/defaults.ts`. Um link do WhatsApp (por exemplo
  `https://wa.me/553492441191`) também funciona como *Link* de um banner: tocar nele abre o chat.
- **Status**: NOVO → CONFIRMADO → EM PREPARO → SAIU PARA ENTREGA (PRONTO PARA RETIRAR) → ENTREGUE, ou CANCELADO. Cada mudança fica
  em `order_status_history` (de → para, data e administrador). Regras, conferidas no banco: para a frente pode pular etapas; para
  trás só uma etapa de cada vez (e "entregue" só volta para "saiu para entrega", por clique errado); **entregue não cancela** (a
  mercadoria já saiu e o estoque não volta; para devolver o dinheiro, use o pagamento "reembolsado"); **cancelado não reabre**;
  cancelar devolve o estoque. Pagamento: pedido cancelado não vira "pago", e só se reembolsa o que estava pago. O painel altera só
  status e pagamento — itens e valores ficam como o cliente fechou.
- **Pedido novo no painel**: o painel pergunta ao servidor a cada **8 s** com a aba à vista (30 s em segundo plano; 2 min depois de
  1 hora escondida; se a internet cai, o intervalo cresce até 1 min), e na hora em que você volta para a aba, só o que chegou
  depois do último pedido visto. Quando chega: aviso "🔔 NOVO PEDIDO", som (liga/desliga por aparelho), contador no menu e no
  título da aba, e listas e dashboard atualizados sem recarregar.
- **Dashboard**: "venda" é pedido que não foi cancelado nem reembolsado (inclui o que ainda vai ser pago na entrega); "pedidos de
  hoje" não conta cancelados; "concluídos hoje" são os **entregues hoje** (pela data da entrega, não a do pedido). Dias, semanas
  e meses seguem o fuso da loja. Os gráficos têm descrição para leitores de tela.
- **Imagens**: o painel reduz e converte a foto para WebP, envia para `/api/admin/upload`, o servidor confere pelos **bytes** (não pelo
  tipo que o navegador declara) que é mesmo uma imagem inteira — JPG, PNG, WebP, GIF ou AVIF, com cabeçalho e fim de arquivo
  válidos, até 12 000 px de lado e 50 milhões de pixels, 4 MB; SVG nunca — e grava no Blob. O Neon guarda só a URL. Quando uma
  imagem deixa de ser usada (troca, exclusão), o servidor a apaga do Blob; produto duplicado compartilha a imagem até o último
  uso sumir.
  - **Miniaturas das fotos de produto** (migration `0025`, `products.image_sm_url` / `image_md_url`): além da foto de até 1200 px, o painel
    grava duas cópias da **mesma** foto, com **400 px** e **720 px** de largura (WebP, a partir da própria foto escolhida). O site usa a de 400 px direto
    nas listas (cerca de 1/7 dos bytes da foto original) e deixa o navegador escolher entre as duas (`srcset` + `sizes`) nos "favoritos", que são
    poucos cartões grandes (o `srcset` nas dezenas de fotos da lista custava mais CPU do que economizava). Produto sem
    miniatura continua mostrando a foto original, como antes. O servidor garante que as miniaturas **sempre pertencem à foto atual** (trocar ou
    tirar a foto zera as duas) e as libera do Blob junto com ela. **Fotos que já existem** ganham miniatura pelo botão **Gerar miniaturas (N)**
    em *Produtos* (uma vez, depois do deploy da 0025: o navegador busca cada foto pelo servidor, gera as duas cópias e grava; pode parar e continuar).
    O botão aparece **sempre que houver produto com foto e sem miniatura**, inclusive quando a foto veio de **outro endereço** (cardápio importado): a miniatura
    é gravada no armazenamento da loja e a foto continua apontando para o endereço de origem. Cada produto assim ganha o selo **Miniatura pendente** na lista e,
    no cadastro do produto, o botão **Gerar miniatura desta foto**.
    Detalhes e números em [`docs/DESEMPENHO.md`](docs/DESEMPENHO.md).
- **Estoque**: vazio = não controla. Com controle, cada pedido desconta; chegou a 0, vira ESGOTADO; repôs, volta a vender. Mexer na
  quantidade de um produto que **não** controla estoque exige ativar o controle de propósito (botão "Começar a controlar" em
  *Estoque*); o banco não deixa o estoque ficar negativo.
- **Promoção com data**: o preço promocional pode valer só entre duas datas (horário da loja). Fora da janela o produto volta ao preço
  normal sozinho, e o site, o carrinho e o pedido usam a mesma regra (`effective_promo`, no banco). Sem datas, vale sempre. A promoção
  precisa ser menor que o preço, e o fim depois do início. Produto com nome e categoria repetidos pede confirmação antes de salvar.
- **Entrega**: taxa única, ou taxa por bairro (*Configurações → Entrega → Taxa por bairro*). Com bairros cadastrados,
  o cliente escolhe o bairro numa lista.
- **Combos (trocar o energético, pagando só a diferença)**: nos produtos da categoria **Combos** (achada pelo NOME, sem diferenciar acento nem
  maiúsculas; "Combos de cerveja" e outras **não** contam), ao adicionar aparece o aviso "Combo adicionado ao pedido. Obs: CASO QUEIRAM TROCAR O
  ENERGÉTICO POR OUTRO, PAGAR A DIFERENÇA." (fecha no X e some sozinho); a mesma observação fica na linha do combo na gaveta do pedido e no checkout.
  - *Qual energético vem no combo* (painel: *Produtos → editar o combo → "Troca do energético (combos)"*): cada combo guarda **o energético que vem
    nele**, de um destes dois jeitos — **(1)** escolhendo o produto do cardápio (`products.swap_base_product_id`; vale o preço de agora dele, com a
    promoção) ou **(2)** deixando "Nenhum (informar o valor)" e digitando o **valor** do energético (`products.swap_base_price`), para quando o energético
    do combo (ex.: o Jack Power) não é vendido avulso. Se os dois estiverem preenchidos, vale o produto. A migration `0017` já preencheu o produto uma vez,
    procurando no nome do combo o energético de 2L cujo nome aparece nele; **confira cada combo no painel**. Combo sem produto e sem valor não aceita
    troca (o botão não aparece).
  - *Quais energéticos o cliente pode escolher* (`product_swap_options`, mesma tela): no painel você **marca todos os energéticos** que o cliente pode
    escolher na troca daquele combo ("Marcar todos" / "Limpar"). **Sem nenhum marcado, vale qualquer energético de 2L** do cardápio (produto de uma
    categoria "Energéticos" ou com o nome começando por "Energético", e com "2L" no nome — "2 L", "2 litros" ou "2000ml"; 473 ml, 2,5L, refrigerantes,
    copões e combos ficam de fora). O que já vem no combo nunca aparece como opção.
  - *O botão QUERO TROCAR O ENERGÉTICO* (no aviso e na linha do combo) abre a lista dessas opções. Cada uma mostra **+ R$ da diferença por combo** (ou
    "Sem diferença"); **Trocar** passa UMA unidade do combo para o energético novo (o botão vira um contador para trocar mais ou voltar atrás). Na gaveta
    e no checkout o combo trocado mostra o energético e a diferença, com "Alterar" e "Voltar ao original".
  - *A conta*: o combo trocado custa **preço do combo + max(0, preço do energético novo − valor do energético que vem no combo)**, com as promoções em
    vigor. Se o novo for **mais caro**, o cliente paga a diferença; se for **do mesmo valor** (ou mais barato), o preço do combo se mantém (não há desconto
    nem devolução). O preço **nunca fica abaixo do combo sem troca**.
  - *Quem calcula*: o **banco** (`create_order`), como todo o preço do pedido; o site só manda qual energético o cliente escolheu em cada linha
    (`swap_to`). Troca em combo sem produto nem valor, energético fora da lista do combo (ou, sem lista, que não é de 2L), esgotado, desativado, igual ao
    do combo ou sem estoque é recusada, mesmo numa requisição feita direto à API. O pedido grava "…— troca do energético por X (+ R$ 2,00)" (ou "(sem
    diferença)"), o estoque do energético novo sai (e volta ao cancelar) e "pedir de novo" traz a troca de volta (se ainda valer).
- **Pagamento**: PIX, dinheiro (com troco) e cartão na entrega, cada um liga/desliga (sempre pelo menos um ativo). A chave PIX
  (opcional) aparece para o cliente depois do pedido. **Todas as formas são pagas à loja**: o sistema não cobra nada pelo site. O pagamento pelo site
  (Pix online e cartão online, que usavam a ValidaPay) **foi retirado do sistema** (migration `0036` e remoção do código): o servidor recusa pedido com
  `pix_online` ou `card_online` (`400 payment_unavailable`), o cardápio público nunca as lista e o painel não as liga. As tabelas e colunas que a
  integração criou (`payments`, `payment_methods`, `payment_fee_settings`, `merchant_accounts`, `orders.payment_fee*` e as funções do banco) continuam no
  banco, **sem uso e sem efeito**: apagá-las seria destrutivo e irreversível. O dono marca o pagamento como pago ou reembolsado à mão, no pedido.
- **Banner da capa**: a faixa azul do topo de `/bebidas` mostra o banner cadastrado em *Banners → Capa da página Bebidas*
  no lugar dos gelos. É só imagem (o texto vai dentro da arte), com versão de celular (telas até 639 px) e de computador,
  descrição para leitores de tela e link opcional. Com mais de um banner ativo eles se alternam a cada 6 s (parado para
  quem pediu menos animação e enquanto o mouse ou o teclado está em cima). **Sem banner ativo, ou se a imagem não abrir,
  a página mostra a capa azul com os gelos, como antes.** Tamanhos ideais: 1200 × 540 px (celular) e 1920 × 480 px
  (computador, proporção 4:1). No celular e no tablet a altura da capa é fixa e a imagem é cortada para caber, sempre
  centralizada; no computador (a partir de 1024 px) a capa ocupa a largura toda e mostra a imagem inteira, sem cortes: se
  a proporção não for a ideal, os lados são preenchidos com a própria imagem desfocada. Os botões "Início" e "Acompanhar"
  (no alto) e a logo (embaixo, à esquerda) ficam por cima da imagem: a prévia do painel mostra essas áreas. A capa e o
  carrossel do cardápio (abaixo do título "Bebidas") têm ordem própria; trocar um banner de um lugar para o outro é só
  escolher *Onde aparece* ao editar.
- **Login / Minha conta**: em `/bebidas`, um botão compacto **Login** (preto, texto branco, borda discreta) fica no canto superior direito da área de informações da
  loja, na altura do nome (no computador, na ponta direita do conteúdo; com banners no cardápio, na ponta direita da coluna da loja, para não cobrir o
  carrossel; no celular, ao lado do nome, sem fazê-lo quebrar de linha). Não existe login novo: o botão é um link para `/conta`, a tela de entrada que o site já
  tem (entrar, criar conta, confirmar o e-mail por código, "Meus pedidos", "Sair"). A sessão é a de sempre (cookie HttpOnly conferido em `/api/account/me`, o mesmo
  `useCustomer()` do resto do site): quem já tem sessão vê **Minha conta** (de 360 a 400 px, "Conta"; abaixo de 360 px, só o ícone), cai direto nos dados e nos
  pedidos sem digitar a senha e nunca vê "Login" piscar enquanto o servidor responde. Depois de entrar o cliente fica na conta (sem `?voltar=`, para não haver vai e
  volta com a Bebidas). O acompanhamento **sem cadastro** (número + código), o botão "Acompanhar pedido" do topo, o carrinho e o checkout não mudaram. O site não
  tem avaliações de clientes, então nada de estrelas. Nas páginas de **conta/login** (`/conta`) e de **acompanhar pedido** (`/acompanhar-pedido` e o link de um pedido), o botão
  "Início" do alto leva de volta à **página Bebidas** (a logo do canto continua levando à página inicial). Código: `src/site/AccountLink.tsx` (o botão) e o cabeçalho em `src/App.tsx`.
- **Horário e pagamento (botão ⓘ)**: em `/bebidas`, o resumo dos horários não fica mais na tela: ele só aparece dentro da janela que um ícone ⓘ discreto, ao lado de "Aberto agora / Fechado", abre uma janela centralizada, escura e azul
  (a do tema da marca), com o título (nome da loja e o status), o **horário de funcionamento de domingo a sábado** (o dia de hoje destacado com "Hoje" e
  os dias fechados marcados "Fechado") e as **formas de pagamento aceitas**. Só isso. Tudo vem do que o painel já cadastra (*Configurações → Horários* e
  *Pagamento*): uma forma de pagamento desligada no painel some da janela, e sem os dados da API (e sem cópia salva) o botão nem é mostrado, para nunca
  exibir horários inventados. Fecha pelo X, clicando no fundo escuro ou com Esc; a página de trás não rola enquanto a janela está aberta; o foco entra na
  janela, fica preso nela (Tab) e volta para o ⓘ ao fechar. Código: `src/site/StoreInfo.tsx`.
- **Página Bebidas no computador**: a partir de 1024 px de largura a página ocupa a tela toda (a coluna estreita de 44 rem
  continua valendo abaixo disso, no celular e no tablet, que não mudam em nada). A capa vira uma faixa em largura total; o
  cabeçalho da loja (logo, nome, tempo e taxa de entrega, aberto/fechado com o ⓘ e busca) fica à esquerda e o carrossel de banners à direita (sem
  banners, a busca vai para a direita do título); as categorias ficam numa fileira fixa em largura total; os favoritos
  mostram mais cards por tela; as bebidas se organizam em 2 colunas (3 a partir de 1800 px); o botão "Ver pedido" vai para o
  canto de baixo, à direita, para não cobrir as categorias nem o meio da página. O respiro das laterais cresce com a tela
  (2,5 rem, 3,5 rem e 5 rem) e o conteúdo só para de esticar em telas maiores que 1920 px.
- **Site sempre em dia**: o site lê a API ao abrir e de novo quando a pessoa volta para a aba; guarda uma cópia no
  navegador para abrir rápido. As listas públicas (`/api/products`, `/api/site`) ficam 10 s na CDN da Vercel (e até 30 s servindo a
  cópia antiga enquanto atualiza): uma mudança no painel aparece no site em segundos. Se a API estiver fora do ar e não houver cópia
  no aparelho, o site **não afirma "Fechado"** (esconde o aviso de horário) e o botão de ajuda leva ao WhatsApp da loja.
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
  atualização". A página consulta o servidor a cada 10 s com a aba à vista e o pedido em andamento (2 min com o pedido finalizado;
  1 min com a aba em segundo plano, 5 min se também finalizado) e na hora em que a aba volta ou a internet reconecta. Sem conexão,
  continua mostrando o último estado, avisa e tenta de novo com intervalo crescente (até 1 min).
- **O cliente só lê, com uma exceção: cancelar.** Não existe rota pública que altere pedido; status e pagamento só mudam pelo painel (o servidor
  confere o login). A única ação do cliente é **cancelar o pedido** (`POST /api/tracking/:codigo/cancel` ou, logado, `POST /api/account/orders/:numero/cancel`),
  só enquanto o pedido está *aguardando pagamento* ou *novo*, sem pagamento recebido; depois que a loja confirma, ou se já foi pago, a página explica o motivo e
  leva ao WhatsApp. O cancelamento é **uma transação no banco** (`customer_cancel_order`): muda o estado, devolve o estoque **uma única vez** (repetir não devolve de
  novo), grava quem/quando/motivo no histórico, dispara o e-mail "pedido cancelado". Pedido de outra pessoa dá 404.
  **A devolução do dinheiro é combinada com a loja**: o sistema não devolve valores (o pagamento é feito à loja, na entrega ou pela chave PIX).
  O pedido público nunca traz telefone, e-mail, ids internos nem o código.
- **Limite de consultas**: 30 consultas erradas por IP a cada 15 min (as certas, como o acompanhamento automático, não
  contam). Pedido inexistente, código errado e link vencido dão exatamente a mesma resposta.

### Conta do cliente (opcional)

`/conta`: cadastro (nome, e-mail, telefone), **confirmação do e-mail**, login, "Meus pedidos" (com o pedido em andamento
em destaque), detalhe com andamento ao vivo, **pedir de novo** e dados/endereço guardados que já vêm preenchidos no
checkout. Comprar como visitante continua sempre possível.

- **Vincular um pedido de visitante à conta** exige a prova de posse: o **número + o código de acompanhamento** do
  pedido *e* o telefone (ou e-mail) do pedido iguais aos da conta. Pedido já ligado a outra conta, código errado ou
  vencido recebem a mesma resposta ("não encontramos…"). Vincular não altera o pedido.
- **Esqueci a senha**: o caminho principal é o **link por e-mail** (abaixo). Quem não acessa o e-mail tem duas saídas:
  *e-mail + telefone cadastrado + número e código de um pedido que já está na conta* (em `/conta/recuperar`, "Não consigo
  acessar meu e-mail"), ou a loja gera um **link de nova senha** (uso único, vale 24 h) em *Painel → Clientes* e envia pelo
  WhatsApp. Esses dois caminhos não provam acesso ao e-mail: conta pendente continua pendente.
- **Excluir a conta** (pelo cliente em `/conta`, ou pelo owner a pedido do titular): apaga cadastro, endereço guardado e
  sessões; os pedidos ficam na loja, sem ligação com a conta, e o link de acompanhamento deles continua valendo.
- Sessão do cliente: cookie `HttpOnly` + `SameSite=Lax` próprio (`copocheio_cliente`, 30 dias), só o hash no Neon; é
  outro mundo que a sessão do painel (uma não abre a outra). Senha com scrypt (mínimo de 8 caracteres, sem senhas comuns).
  Limites de login: 8 erros por e-mail + rede e 30 por rede a cada 15 min, e 100 tentativas por hora por e-mail.
- **Login com código por e-mail, a CADA entrada** (migration `0023_login_code.sql`): a senha certa **sozinha não abre sessão**. Em `/conta` a pessoa informa
  e-mail e senha; com a senha certa o servidor manda um **código de 6 dígitos** para o e-mail da conta, a tela muda para **"Confirme que é você"** e só o código
  certo abre a sessão (`POST /api/account/login` → `202 { status: "code_required", ... }` e `POST /api/account/login/code { code }` → `200 { customer }` com o cookie de
  sessão). Sair e entrar de novo pede outro código; uma sessão que já está aberta continua valendo (30 dias) até a pessoa sair.
  - *Amarrado ao navegador*: junto com o `202` o servidor entrega um cookie secreto (`copocheio_login`, `HttpOnly`, 30 min) que identifica a tentativa; o código só vale
    **vindo desse mesmo navegador**. Quem só leu o e-mail (ou o código) não entra, e quem só sabe a senha também não.
  - *Regras do código*: vale **5 min**, **uso único**, **5 erros** inutilizam a tentativa (é preciso informar a senha de novo), **reenvio só depois de 60 s**
    (`POST /api/account/login/resend`), no máximo **5 e-mails por tentativa** e **10 por hora por conta**, e até 40 por hora por rede. O banco guarda só o hash do cookie
    e um HMAC do código (chave que só o servidor conhece); tudo isso é conferido **dentro do banco**, então pedidos simultâneos não furam nenhum limite.
  - *Trocar a senha derruba a tentativa aberta* (por qualquer caminho); conta desativada ou excluída também. Entrar de novo **logo em seguida, no mesmo navegador**,
    não manda outro e-mail (vale o código já enviado).
  - *Quem erra a senha nunca chega ao código*: nenhum e-mail sai e a resposta (`401`) é a mesma de sempre, então ninguém enche a caixa de e-mail de um cliente sem
    saber a senha dele. Conta com e-mail ainda não confirmado segue no fluxo de confirmação (`403 email_not_verified`).
  - *Sem e-mail configurado (SMTP), ninguém entra na conta*: com a senha certa o servidor responde `503 mail_not_configured` (o cadastro já era assim). Fazer pedidos e
    acompanhá-los **sem conta** continua funcionando. O mesmo vale se o servidor de e-mail estiver fora do ar na hora (`503 mail_failed`: nada de sessão sem o código).
  - *Recém-cadastrado*: depois de confirmar o e-mail do cadastro, a tela segue direto para o código de acesso (um segundo e-mail, já a caminho).
  - O e-mail do código é o tipo `login_code` (transacional, síncrono, nunca guardado nem reenviado: só o nome do tipo vai para o registro de e-mails). O painel (`/admin/login`)
    não muda: continua com senha e, se a conta usar, o código do aplicativo (2FA).

### Login do painel com código por e-mail

**Fluxo** (tela `/admin/login`, o mesmo visual de sempre):

1. *E-mail e senha* → `POST /api/auth/login`. O servidor confere a senha, se a conta está **ativa** e o papel (owner ou admin). Quem erra a senha, não existe, está desativado ou
   é cliente recebe sempre o **mesmo** `401 "E-mail ou senha incorretos."` e **nenhum e-mail sai** (ninguém enche a caixa de um administrador sem saber a senha dele).
2. Com a senha certa **ainda não há sessão**: o servidor manda um código de 6 dígitos para o e-mail da conta e responde `202 { status: "code_required", email_masked, resend_in: 60,
   expires_in: 300 }` mais um cookie secreto (`copocheio_admin_login`, `HttpOnly`, `SameSite=Strict`, 15 min) que prende a tentativa a **este navegador**. A tela mostra o e-mail
   mascarado (`a***@dominio.com`), seis caixas para o código, o contador de validade, "Reenviar código" (liberado após 60 s) e "Voltar".
3. *Código* → `POST /api/auth/login/code { code }`: com o código certo, vindo do mesmo navegador, a sessão é criada (`200 { admin }`). Se a conta também usa o aplicativo
   autenticador, a resposta é `{ two_factor: true, challenge }` e o **código do aplicativo** é a 3ª etapa (`/api/auth/login/2fa`), que só aceita o desafio criado depois do e-mail.
4. *Reenviar* → `POST /api/auth/login/resend`.

**Regras do código** (todas conferidas **dentro do banco**, então pedidos simultâneos não furam nenhum limite):

| Regra | Valor |
| ----- | ----- |
| Validade | **5 minutos**, **uso único**; a tentativa toda vale 15 min |
| Erros | **5** por código; no 5º a tentativa inteira morre (é preciso informar a senha de novo) |
| Reenvio | só após **60 s**; no máximo **4 e-mails por tentativa**; o código novo substitui o anterior só depois que o e-mail novo realmente sai |
| Teto por conta | **8 pedidos de código por hora que NÃO terminam em entrada** (quem entra de verdade não é limitado) |
| Por rede | 30 e-mails de código por hora e 30 tentativas de código a cada 15 min |
| Armazenamento | o banco guarda **só hashes**: SHA-256 do cookie da tentativa e HMAC do código (chave que só o servidor conhece, derivada da `DATABASE_URL`); o código nunca é gravado, nem aparece no registro de e-mails, em log, na URL ou em resposta da API |
| Amarrado ao navegador | quem só leu o e-mail (ou só sabe a senha) não entra: o código só vale com o cookie do navegador que digitou a senha |
| Troca de senha | trocar a senha da conta (por qualquer caminho), desativá-la ou excluí-la derruba a tentativa aberta |

**Se o e-mail não puder ser enviado, ninguém entra**: sem SMTP configurado a resposta é `503 mail_not_configured`; com o servidor de e-mail fora do ar, `503 mail_failed` ("tente de novo em
instantes"). Nunca se abre a sessão "por falta de e-mail". A tentativa pode ser repetida na hora (o desafio que não chegou a ser enviado é descartado).

**Interruptor de emergência (`ADMIN_EMAIL_CODE=off`)**: se o e-mail da loja parar e **ninguém** conseguir entrar no painel, quem tem acesso às variáveis da Vercel pode criar
`ADMIN_EMAIL_CODE=off` (escrito exatamente assim; qualquer outro valor deixa o código LIGADO) e fazer um novo deploy: o painel volta ao login antigo (senha e, se a conta usa, o
aplicativo). Em *Configurações → Painel → Estado do sistema* aparece "Desligado (emergência)" em vermelho enquanto o interruptor estiver ligado, e `/api/admin/health` informa
`admin_login_code: "off"`. **Conserte o e-mail, remova a variável e faça um novo deploy** assim que possível: com ela, o painel fica só com senha (e aplicativo).

**E-mail de envio**: o código sai pelo mesmo serviço central de e-mails do site (`deliver()`, tipo `admin_login_code`: transacional, síncrono, nunca guardado nem reenviado). Hoje esse
serviço usa o **SMTP do Gmail da loja** (as variáveis `SMTP_*` da seção [Confirmação do e-mail](#confirmação-do-e-mail-contas-de-clientes)); não existe integração com Google Apps Script
neste projeto. O painel **não** envia por outro provedor.

**Administrador autorizado** (quem pode receber o código): o e-mail cadastrado na conta administrativa. O primeiro owner é criado com `npm run admin:create -- seu@email.com "Seu Nome"`
(use um e-mail que você **lê** de verdade: é para ele que o código vai); os demais, pelo owner em *Configurações → Administradores*. O e-mail de uma conta só muda pelo owner.

### Confirmação do e-mail (contas de clientes)

**Regra:** uma conta só passa a valer depois que a pessoa **prova que lê a caixa de e-mail** informada. Formato válido,
domínio que existe e e-mail que não é descartável são camadas extras; **nenhuma delas substitui a confirmação**.

**Qualquer provedor de e-mail serve.** Gmail, iCloud, Outlook, Hotmail, Yahoo, UOL, Proton, o e-mail de uma empresa ou de um domínio próprio: o cliente **não
precisa ter Gmail, um iPhone ou Android específico, nem instalar aplicativo** para receber o código. Não existe lista de domínios permitidos: o cadastro só barra o que
**nunca receberia o código** (formato impossível, domínio que não existe ou que declara não receber e-mail, e serviço de e-mail **temporário**, que some em minutos). O
remetente (o Gmail da loja, hoje pelo SMTP) e o destinatário (qualquer endereço) são coisas diferentes. Detalhes, o que o sistema consegue saber da entrega e como
investigar um provedor que não recebe: [docs/EMAIL.md](docs/EMAIL.md), seção 4.1.

**Fluxo**

1. `/conta` → *Criar conta*: nome, telefone, e-mail e senha. O servidor valida o formato, normaliza o e-mail, barra
   domínio descartável/inexistente (abaixo), cria a conta como **`pending_verification`** (sem sessão) e envia um e-mail
   com um **código de 6 dígitos** e um **link**.
2. A tela pede o código (ou a pessoa toca no link do e-mail → `/conta/verificar/<código>` → botão *Confirmar meu e-mail*).
   Confirmado, a conta vira `active` com a **data da confirmação** (`email_verified_at`) e a tela entra sozinha.
3. Quem tenta entrar com a senha certa antes de confirmar **não ganha sessão**: recebe `403 email_not_verified`, um
   código novo é enviado (respeitando os limites) e a tela volta para a confirmação.
4. **Cadastro preso ao navegador**: quem cria a conta recebe um cookie (`copocheio_cadastro`, 7 dias) que liga aquele navegador ao
   cadastro. Sem isso, alguém poderia cadastrar o e-mail de outra pessoa com uma senha que só ele conhece e esperar que a vítima
   "confirmasse" o código. Agora, confirmar o e-mail **em outro navegador** (o caso normal de quem recebe o e-mail no celular) ativa a
   conta, mas a senha digitada no cadastro **deixa de valer**: a pessoa define uma senha nova na hora (`set_password_token`).

**Códigos**

| Regra | Valor |
| ----- | ----- |
| Código | 6 dígitos aleatórios (`crypto.randomInt`), vale **15 min**, **uso único**, **5 erros** inutilizam o código |
| Link | 256 bits aleatórios, vale **24 h**, uso único; abrir o link não confirma (precisa do toque no botão, para leitores de e-mail que "abrem" links sozinhos não gastarem o link) |
| Armazenamento | o banco guarda **só hashes**: HMAC-SHA256 do código (chave que só o servidor conhece, derivada da `DATABASE_URL`: se a senha do banco for trocada, os códigos em andamento deixam de valer e é só pedir outro) e SHA-256 do link — nada em texto puro |
| Reenvio | espera de **60 s**; no máximo **5 por hora** e **10 por dia** por conta; um código novo **invalida os anteriores** (só depois que o e-mail novo realmente sai: se o envio falhar, o código que a pessoa já tinha continua valendo) |
| Vínculo ao endereço | o código só vale para o endereço para o qual foi enviado; o e-mail da conta **não pode ser trocado** por `PATCH /api/account` (mudar o e-mail = novo cadastro = nova confirmação) |
| Excesso de erros | 5 códigos errados por e-mail e 30 por IP a cada 15 min → `429`; pedir um código novo libera |
| Abuso | 6 cadastros por IP por hora, 12 pedidos de reenvio e 15 e-mails por IP por hora |
| Mensagens | iguais para e-mail novo, pendente ou já cadastrado (não revela quem tem conta); quem já tem conta recebe, na própria caixa, um aviso "você já tem uma conta" (no máximo 1 por hora) |

**Validação do endereço antes de enviar** (`server/emailAddress.ts`, `server/mailDomain.ts`)

- **Formato e normalização**: um `@`, parte local em ASCII, domínio em minúsculas (acentos viram punycode), espaços e
  caracteres invisíveis removidos. Pontos e `+etiqueta` **não** são mexidos (mudariam o endereço).
- **Descartáveis**: lista embutida com ~62 mil domínios (união de duas listas públicas: `disposable-email-domains`, CC0, e
  `mailchecker`, MIT), incluindo subdomínios. Provedores comuns (Gmail, Outlook, Hotmail, Yahoo, iCloud, UOL…) e serviços
  de "apelido" legítimos nunca são barrados. Para atualizar a lista: `npm run emails:update-blocklist`, conferir o diff e
  fazer deploy (vale rodar de vez em quando).
- **DNS**: o domínio precisa ter MX (ou A/AAAA, como manda o protocolo) e não pode ser "MX nulo" (RFC 7505). Só rejeita
  quando a inexistência é **confirmada**; falha de rede, timeout ou DNS fora do ar **não** bloqueiam o cadastro (quem decide
  é o código no e-mail).
- Domínios reservados (`example.com`, `.test`, `.invalid`, `.local`…) são recusados.

**Configurar o envio** (variáveis do **servidor**, nunca chegam ao navegador; são as mesmas da confirmação de cadastro e da
recuperação de senha). O envio usa SMTP comum, que funciona com
qualquer provedor. O caminho mais simples, sem domínio próprio, é uma conta **Gmail** da loja:

1. Na conta Google da loja, ligue a *Verificação em duas etapas* e crie uma **senha de app** em
   <https://myaccount.google.com/apppasswords> (16 letras; os espaços não importam).
2. Na Vercel, *Settings → Environment Variables* (Production), cadastre:

   | Variável | Valor | Obrigatória |
   | -------- | ----- | ----------- |
   | `SMTP_HOST` | `smtp.gmail.com` | sim |
   | `SMTP_USER` | o Gmail da loja, ex.: `copocheio@gmail.com` | sim |
   | `SMTP_PASS` | a senha de app (marque como *Sensitive*) | sim |
   | `SMTP_PORT` | `465` (padrão) ou `587` | não |
   | `SMTP_SECURE` | `true`/`false` (padrão: `true` na porta 465) | não |
   | `MAIL_FROM` | remetente, ex.: `Copo Cheio <copocheio@gmail.com>`; **obrigatória só** quando `SMTP_USER` não é um e-mail (Resend, SendGrid, SES…) | não |
   | `SITE_URL` | endereço do site nos links e na logo dos e-mails, ex.: `https://www.seudominio.com.br`; sem ela usa o domínio de produção da Vercel | não |
   | `CRON_SECRET` | texto aleatório longo; **liga os crons diários**: fila de e-mails (`/api/cron/email`) e varredura de Pix/cartão vencido (`/api/cron/sweep`) | recomendada |
   | `GA_MEASUREMENT_ID` | identificador do Google Analytics 4 (`G-XXXXXXXXXX`; não é segredo); liga a medição de visitas **só para quem aceitar** (exige também liberar o Google na CSP: `docs/PWA-SEO-ANALYTICS.md`) | não |
   | `EMAIL_DAILY_LIMIT`, `EMAIL_PROMO_DAILY_LIMIT`, `MAIL_REPLY_TO` | teto diário de envio (padrão 450 no Gmail), parte dele para promoções e endereço de resposta | não |
   | `EMAIL_ORDER_NOTICES` | `off` **pausa** os e-mails de pedido e pagamento (interruptor de segurança; códigos de confirmação, nova senha e promoções não são afetados) | não |

   (Provedor opcional com avisos de entrega: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`. Tudo sobre envio, registro,
   entregabilidade, DNS e promoções: [`docs/EMAIL.md`](docs/EMAIL.md).)

3. Faça um novo deploy, abra *Painel → Clientes* e use **Enviar e-mail de teste** (owner), ou *Painel → E-mails → Autenticação → **Enviar exemplos para
   mim*** (um exemplo de cada modelo: confirmação, nova senha, pedido, pagamento, entrega, cancelamento e promoção). O painel e
   `GET /api/health` (`"mail":"ok"`) mostram se está configurado; se faltar algo, listam os **nomes** das variáveis.

Outros provedores (Brevo, Resend `smtp.resend.com`, Amazon SES, SendGrid, Zoho…) funcionam do mesmo jeito, com o servidor
e as credenciais SMTP deles; para um remetente com o seu domínio, configure SPF/DKIM no provedor. Contas Gmail comuns têm
limite diário de envios (centenas); para volume maior use um provedor transacional. **Sem as variáveis, o servidor recusa o
cadastro (`503 mail_not_configured`) em vez de criar contas que ninguém poderia confirmar.**

**Contas que já existiam** antes desta atualização passam a `pending_verification` (com 30 dias de prazo) e confirmam o
e-mail no próximo login. Conta pendente há mais de 7 dias (30, as antigas), **sem pedidos**, é apagada
automaticamente. Administradores do painel não passam por isto (só o owner os cria).

### Recuperação de senha por e-mail

`/conta/recuperar` (link "Esqueci minha senha" na tela de entrada): a pessoa informa o e-mail da conta e recebe, na caixa de
entrada, um **link de uso único** que leva a `/conta/redefinir/<link>`, onde escolhe a senha nova.

1. **Pedir** — `POST /api/account/forgot-password { email }`. A resposta é **sempre a mesma** (`200`), exista a conta ou não,
   esteja ela ativa, pendente ou desativada, e **demora o mesmo tempo** (no mínimo ~2 s), para a tela não servir para descobrir
   quem tem cadastro. Só conta ativa recebe o e-mail; o texto da tela diz "se existir uma conta...".
2. **O link** — 256 bits aleatórios, **só o hash (SHA-256) fica no banco**, vale **60 minutos** e **uma vez**. Um link novo
   invalida os anteriores (só depois que o e-mail novo realmente saiu; se o envio falhar, o que a pessoa já tinha continua valendo).
3. **Abrir o link** — a tela consulta (`POST /api/account/reset-check`, que **não gasta** o link, então leitores de e-mail que
   "abrem" links sozinhos não o invalidam) e mostra a conta (e-mail mascarado) ou, se o link venceu/foi usado/foi trocado,
   "Este link não vale mais" com o botão **Pedir um novo link** — sem pedir senha à toa.
4. **Senha nova** — `POST /api/account/reset { token, password }` (mínimo de 8 caracteres): troca a senha, **derruba todas as
   sessões da conta** (todos os aparelhos), invalida os outros links e libera o login de quem ficou bloqueado por errar a senha.
   **Não abre sessão**: a pessoa entra com a senha nova (a tela já traz o e-mail preenchido). Em seguida, um e-mail
   **"Sua senha foi alterada"** (com data e hora) avisa a conta, para quem não foi o autor perceber na hora.

| Regra | Valor |
| ----- | ----- |
| Espera entre pedidos | **60 s** por conta; no máximo **5 por hora** e **10 por dia** por conta (decididos dentro do banco, de forma atômica) |
| Por rede (IP) | 10 pedidos por hora; e os e-mails enviados contam no mesmo limite de **15 por hora** da confirmação de cadastro |
| Link errado | 10 tentativas por IP a cada 15 min (depois, `429`); consulta do link: 60 por IP a cada 15 min |
| Quem recebe | só conta **ativa**; conta desativada, inexistente ou com e-mail inválido não recebe nada (e ninguém vê a diferença) |
| Falha do servidor de e-mail | a resposta continua igual (não revela a falha); sem SMTP configurado, a rota responde `503 mail_not_configured` e a tela abre o caminho "sem e-mail" |

**Conta que nunca confirmou o e-mail** (inclusive as contas antigas, que ficaram pendentes na atualização): o link de e-mail
também vale como **prova de acesso à caixa**, então redefinir a senha por ele **confirma o e-mail** no mesmo passo (a tela
diz isso) e a pessoa já entra, sem código. Isso só vale para o link enviado por e-mail: o link gerado pela loja (WhatsApp)
**não** confirma nada, e o banco ainda confere que o link foi mesmo enviado e que o e-mail da conta é o mesmo para o qual
ele foi.

### E-mails da Copo Cheio (layout único da marca)

Todo e-mail do sistema usa o **mesmo layout** (`server/mailLayout.ts`): cabeçalho preto com a **logo oficial** e uma faixa azul
da marca, cartão claro com cantos arredondados sobre um fundo suave, tipografia do sistema, rodapé com o nome e o slogan da
loja e os **contatos reais** (WhatsApp, Instagram, endereço e site, lidos de *Painel → Configurações*; o que não estiver
cadastrado simplesmente não aparece) e uma versão em **texto simples** gerada junto. Cada e-mail só descreve o próprio conteúdo.

| Arquivo | O que é |
| ------- | ------- |
| `server/mailLayout.ts` | O layout: cabeçalho, rodapé, paleta, modo escuro, ajuste para celular e os blocos (texto, código, botão, link, aviso) em HTML e em texto |
| `server/mailTemplates.ts` | Os e-mails de hoje: **confirmação de e-mail**, aviso **"você já tem uma conta"**, **redefinição de senha** e **"sua senha foi alterada"** (o de teste do painel é o de confirmação com um código de exemplo) |
| `server/mailBrand.ts` | A marca na hora de enviar: nome, slogan, contatos e logo, vindos do banco (`loadBrand`) |
| `server/mail.ts` | O transporte SMTP (`nodemailer`): só fala com o servidor de e-mail e devolve o que ele respondeu |
| `server/email/` | **O serviço central de e-mails**: `service.ts` (`deliver()`, fila, tentativas), `kinds.ts` (os tipos), `ledger.ts` (registro de cada mensagem), `templates.ts` (pedido, promoção, alerta), `render.ts`, `preferences.ts` (consentimento), `alerts.ts`, `dns.ts` (SPF/DKIM/DMARC), `svix.ts`/`webhooks.ts`/`resend.ts` (provedor opcional) |
| `server/routes/emailadmin.ts`, `emailpublic.ts` | Painel **E-mails** (visão geral, mensagens, campanhas, supressões, DNS) e rotas públicas (preferências, descadastro de um clique, cron, avisos do provedor) |
| `server/passwordReset.ts` | Recuperação de senha: pedir o link, enviar o e-mail, aviso de senha alterada |
| `public/email/logo.png` | A logo oficial reduzida para e-mail |

**Como a logo é carregada.** Leitores de e-mail só mostram imagem com **endereço público** (nada de arquivo anexo ou
`data:`), então o e-mail aponta para `https://<seu site>/email/logo.png`: a mesma arte de `public/logo.png`, reduzida para
256×256 (o dobro do tamanho exibido, 128 px, para ficar nítida em tela de celular), em PNG de 32 bits com transparência
(~64 KB; é o formato que todo leitor abre, inclusive o Outlook para Windows). O endereço do site vem de `SITE_URL` (se
definida) ou do domínio de produção da Vercel — por isso o domínio de produção precisa ser público (o padrão). Se a logo for
trocada em *Painel → Site* e o arquivo novo for PNG, JPG ou GIF, o e-mail passa a usá-la; se for WebP (o formato que o painel
costuma gerar, e que o Outlook para Windows não abre), o e-mail continua com a logo oficial em PNG. Sem a imagem (Outlook
bloqueia por padrão), aparece o nome da loja no lugar.

**Compatibilidade.** HTML de tabelas com estilos inline (o visual claro não depende do `<style>`), fonte do sistema por
extenso, botão com retângulo arredondado em VML para o Outlook para Windows, `color-scheme` e `prefers-color-scheme` para o
**modo escuro** (Apple Mail, Outlook.com e aplicativo, Samsung; o Gmail escurece sozinho), ajuste para telas de até 520 px,
sem JavaScript, sem fonte externa e **sem pixel de rastreamento** (a única imagem é a logo). Cerca de 14 KB de HTML por e-mail (o Gmail
corta acima de ~100 KB). As cores têm contraste WCAG AA nos dois modos.

**Criar um e-mail novo** (o de redefinição de senha, em `server/passwordReset.ts`, é um bom exemplo completo):

1. Em `server/mailTemplates.ts`, escreva uma função no formato das que já estão lá: recebe `brand` e os dados e devolve
   `renderEmail(brand, { to, subject, preheader, eyebrow, title, greeting, blocks: [...], reason })`. Os blocos disponíveis
   são `text`, `code`, `button`, `link` e `notice` (para um bloco novo, como o resumo de um pedido, acrescente o tipo em
   `mailLayout.ts`: HTML e texto).
2. Registre o tipo em `server/email/kinds.ts` (transacional ou promocional, se leva segredo, tetos) e envie com `deliver()`
   (`server/email/service.ts`): ele confere as regras (endereço suprimido, consentimento, tetos), registra a mensagem, envia e trata a falha.
   Detalhes em [`docs/EMAIL.md`](docs/EMAIL.md#14-como-criar-um-tipo-de-e-mail-novo).

Cabeçalho, logo, cores, rodapé, modo escuro e versão em texto vêm do layout; o e-mail novo só diz o que tem a dizer.

**Testar o envio real e ver no Gmail.** Em *Painel → Clientes*, o dono usa **Enviar e-mail de teste**: chega na caixa do
próprio dono o e-mail de confirmação de verdade (mesmo layout, logo e rodapé), com a faixa "Mensagem de teste" e o código de
exemplo `123456`, que não ativa conta nenhuma. Abra no celular e no computador, nos modos claro e escuro do Gmail, e use
*⋮ → Mostrar original* para conferir que SPF, DKIM e DMARC estão em **PASS**. O e-mail de confirmação real é o do cadastro em
`/conta`. Limites: a "foto" do remetente na lista do Gmail (a silhueta cinza) não vem do e-mail — só aparece a logo ali com
BIMI, que exige um domínio próprio; e o Outlook para Windows mostra cantos retos nos cartões (o botão continua arredondado).

### Entregabilidade, registro e promoções (resumo)

Manual completo, com tabelas, alertas, DNS (SPF, DKIM, DMARC), procedimento para conferir no Gmail/Outlook e limites: **[`docs/EMAIL.md`](docs/EMAIL.md)**.

- **Um só caminho de saída** (`deliver()`): classifica o e-mail (transacional × promocional), confere supressão, consentimento e tetos, **registra** a mensagem (sem corpo,
  código nem link) e envia. Falha temporária → fila com espera crescente; código de login e link de senha **nunca** vão para a fila nem para o registro.
- **E-mails de pedido e pagamento** (recebido, confirmado, saiu para entrega, entregue, cancelado, pagamento confirmado, reembolso), enfileirados pelo banco, sem duplicar,
  também para visitantes (com travas: domínio, tetos por endereço e link “não quero e-mails de pedidos neste endereço”).
- **Promoções**: só com consentimento (caixa desmarcada por padrão; vale depois de confirmar o e-mail), com descadastro de um clique (RFC 8058) e campanhas pelo painel.
- **Painel *E-mails***: números honestos (o SMTP só informa “aceito”; entrega, devolução e spam aparecem como “não informado” a menos que o provedor opcional avise), histórico por
  mensagem, fila, alertas, lista de supressão e verificador de SPF/DKIM/DMARC.
- **Registros** ficam 180 dias; excluir a conta ou anonimizar uma pessoa remove o endereço deles.

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
- Sessões vencidas, links de redefinição usados/vencidos, registros de tentativas (1 dia), aparelhos do painel sem uso há 400
  dias, códigos de recuperação já usados (90 dias), registro de atividades com mais de 2 anos e pedidos de privacidade já
  respondidos há 2 anos são apagados sozinhos (função `purge_expired_data`, chamada de vez em quando por logins e pedidos). A
  tabela completa está em [`docs/OPERACAO.md`](docs/OPERACAO.md).
- O **registro dos e-mails enviados** (destinatário, tipo, data e resultado; sem corpo, código nem link) fica **180 dias**; excluir a conta ou anonimizar uma pessoa tira o endereço dele, das preferências e da lista de supressão.
- **Os pedidos em si não são apagados automaticamente**: a loja precisa deles como histórico e para obrigações fiscais.
  Prazo de guarda e eventual anonimização de pedidos antigos dependem da sua contabilidade; a anonimização a pedido do titular
  é feita pelo owner (veja [Privacidade (LGPD)](#privacidade-lgpd)).
- O cliente vê só o necessário para acompanhar a compra: nome, itens, valores, endereço e andamento; a página manda
  `noindex` e `Referrer-Policy: no-referrer` para o link não vazar.

## Cupons, entrega grátis, agendamento e endereços

Tudo abaixo nasce **desligado ou vazio** e é calculado e conferido **no banco** (o navegador só manda o código do cupom, o horário escolhido e o total que viu):

- **Cupons** (`/admin/cupons`, só o owner; migration `0029`): código único em maiúsculas, tipo *porcentagem* (com teto opcional), *valor fixo* ou *entrega grátis*, pedido mínimo, validade, limite total de usos, limite por cliente (conta ou telefone),
  categorias, "sem itens em promoção". Um cupom por pedido; o desconto nunca passa do valor dos itens elegíveis; pedido cancelado não conta como uso; cupom que zera o pedido só vale para pagar na entrega/retirada. Inexistente, desligado ou vencido
  dá **sempre a mesma mensagem** e quem erra o código 12 vezes em 10 minutos é barrado. O pedido guarda código, desconto e taxa dispensada: mudar ou apagar um cupom **nunca** altera pedido feito. A prévia do carrinho é `POST /api/coupons/validate`.
- **Entrega grátis por valor** (*Configurações → Entrega*): a partir de um subtotal **depois do cupom**, só na entrega; a taxa (única ou do bairro) não é cobrada e o pedido guarda quanto foi dispensado.
- **Agendamento** (*Configurações → Entrega*; migration `0030`): o cliente escolhe dia e faixa de horário (15/30/60/120 min) respeitando o horário de funcionamento, a antecedência mínima, o limite de dias e a lotação por faixa; loja fechada pode receber pedido agendado
  para quando abrir; pedidos pausados não. **Feriados e horários especiais** (*Configurações → Horários*) valem no lugar do horário da semana para os pedidos de agora e os agendados. `GET /api/schedule` lista as faixas.
- **CEP** (campo opcional no checkout e nos endereços): `GET /api/cep/:cep` consulta o ViaCEP **pelo servidor da loja** (gratuito, sem chave); o serviço só recebe o CEP. Fora do ar, o cliente preenche à mão.
- **Endereços extras** (migration `0031`; *Minha conta → Outros endereços*): até 4 além do principal, escolhidos no checkout (`/api/account/addresses`).
- **Exportar CSV** (pedidos e clientes: só o owner; estoque: qualquer administrador): `GET /api/admin/export/orders.csv|customers.csv|stock.csv`, separador `;`, UTF-8 com BOM, texto que começa com `= + - @` ganha apóstrofo (proteção contra injeção de fórmula),
  limite de 20 por hora e 20.000 linhas, cada exportação no registro de atividades (nunca o conteúdo).
- **Estoque baixo** (migration `0032`; *Estoque*): limite padrão da loja e limite por produto; aviso no painel inicial **e por e-mail aos donos** (um por dia, só quando a lista de produtos muda; interruptor em *Estoque*). O mesmo aviso
  avisa se a **rotina automática** falhou ou parou de rodar (`server/opsAlerts.ts`, pelo serviço de e-mails de sempre).
- **Termos e políticas** (migration `0033`; *Configurações → Termos e políticas*, só o owner): `/termos`, `/trocas-e-cancelamentos`, `/entrega`, `/pagamento-e-reembolso` e `/contato-e-responsavel` com texto editável; o painel marca "ainda não revisado juridicamente"
  (`docs/JURIDICO-PENDENCIAS.md`). Razão social, CNPJ e endereço do responsável **não são inventados**: a loja os escreve na página de contato.
- **Programa de pontos** (migration `0035`; `/admin/fidelidade`, só o owner; *Minha conta → Meus pontos*): **desligado e sem nenhum valor** até o dono definir pontos por R$ 1, pontos para trocar, valor e validade do cupom. O cliente **com conta** ganha pontos quando o pedido é entregue
  (itens depois do desconto; entrega e taxas não contam), o crédito é estornado se o pagamento é devolvido, o extrato é só de acréscimo e a troca gera um **cupom pessoal** de valor fixo (uso único, só dessa conta) de forma atômica. Acerto manual do owner, sempre com motivo.
- **Avaliações** (migration `0034`; `/admin/avaliacoes`): depois de **entregue**, o cliente dá nota de 1 a 5 e um comentário opcional, uma vez, pelo link de acompanhamento ou pela conta. Nasce "aguardando"; só vai para o site
  (`GET /api/reviews`) depois que a loja **publica**, e o público recebe só nota, comentário e data (nunca nome, telefone nem número do pedido). A loja pode esconder ou apagar (um comentário com dado pessoal, por exemplo).
- **Entregadores** (migration `0034`; *Configurações → Entrega*): a loja cadastra quem entrega e escolhe o entregador em cada pedido de **entrega**; o **nome fica gravado no pedido** (apagar o entregador não muda o histórico) e o cliente vê só o
  **primeiro nome**, enquanto o pedido está a caminho.
- **Rotina automática** (`GET /api/cron/sweep`, só com `Authorization: Bearer $CRON_SECRET`): manda a fila de e-mails, avisa a operação (estoque baixo, rotina com problema) e limpa dados vencidos; registra quando rodou em `job_runs` (aparece em *Configurações → Painel → Estado do sistema*). A Vercel (plano gratuito) só aceita cron **diário**
  (`vercel.json` → `crons`); para checar a cada poucos minutos use um agendador externo (veja `docs/OPERACAO.md`, seção 4). Sem agendador, a fila de e-mails também sai de passagem quando entra movimento.
- **Site instalável, buscadores e medição de visitas** (`docs/PWA-SEO-ANALYTICS.md`): manifesto + service worker que guarda **só arquivos estáticos**; `robots.txt` e `sitemap.xml` gerados com o endereço do site; Google Analytics 4 **opcional**
  (`GA_MEASUREMENT_ID`), só depois do "Aceitar" da pessoa e sem dado pessoal (precisa também liberar o Google na CSP: decisão do proprietário).

## API

Público: `GET /api/products` · `GET /api/site` (traz `banners` do cardápio e `cover_banners` da capa) · `POST /api/orders` (devolve `{order, token}`; aceita `idempotency_key` e `expected_total`) · `GET /api/health` · `POST /api/privacy/request`
Técnico (público): `GET /api/__page` (HTML para robôs) · `GET /api/sitemap.xml` e `GET /api/robots.txt` (servidos como `/sitemap.xml` e `/robots.txt`) · `POST /api/csp-report` · `POST /api/client-error`
Loja e checkout (público): `POST /api/coupons/validate` (prévia do cupom) · `GET /api/schedule` (faixas do agendamento) · `GET /api/cep/:cep` · `GET /api/legal/:pagina` (termos e políticas) · `GET /api/reviews` (avaliações publicadas)
Acompanhamento (sem login): `GET /api/tracking/:codigo` · `POST /api/tracking/lookup` (`order_number` + `code`) · `POST /api/tracking/:codigo/cancel` (o cliente cancela o pedido)
Conta do cliente: `POST /api/account/register|verify-email|verify-link|resend-verification|login|logout|forgot-password|reset-check|reset|recover` · `GET /api/account/me` ·
`PATCH|DELETE /api/account` · `PATCH /api/account/password` · `GET /api/account/orders[/:numero]` ·
`POST /api/account/orders/claim` · `POST /api/account/orders/:numero/cancel` · `GET|POST /api/account/orders/:numero/review` · `GET|POST|PATCH|DELETE /api/account/addresses`
Acompanhamento, avaliação: `GET|POST /api/tracking/:codigo/review`
Pontos (conta): `GET /api/account/loyalty` · `POST /api/account/loyalty/redeem` — painel (owner): `GET /api/admin/loyalty` · `PUT /api/admin/loyalty/settings` · `POST /api/admin/loyalty/adjust`
Painel, sessão: `POST /api/auth/login` · `POST /api/auth/login/2fa` · `POST /api/auth/logout` · `GET /api/auth/me` · `PATCH /api/auth/password` ·
verificação em duas etapas: `GET /api/auth/2fa` · `POST /api/auth/2fa/setup|enable|disable|recovery-codes`
Preferências de e-mail (sem login, pelo link do e-mail): `GET|PATCH /api/email/preferences/:chave` · descadastro de um clique (RFC 8058): `POST /api/email/unsubscribe/:chave` ·
logado: `GET|PATCH /api/account/email-preferences` · crons diários: `GET /api/cron/email` e `GET /api/cron/sweep` (só com `Authorization: Bearer $CRON_SECRET`; `GET /api/cron/status` mostra quando a varredura rodou) · avisos do provedor opcional:
`POST /api/email/webhook/resend` (assinatura Svix; sem `RESEND_WEBHOOK_SECRET` nem existe)
Painel (exige login): `/api/admin/dashboard`, `orders` (+ `POST orders/:id/tracking-link`), `live`, `customers`, `mail` (+ `POST mail/test`, owner),
`emails/overview|messages[/:id]|suppressions|campaigns[/:id]|dns` (consulta; o owner age: reenviar/cancelar mensagem, `POST emails/process`, supressões, criar/testar/enviar/cancelar campanha), `products`
(+ `POST products/import`, que devolve o relatório linha a linha), `categories`, `banners`, `settings`, `store` (`PATCH` aceita `expected_updated_at`: se outra pessoa salvou antes, responde `409` em vez de sobrescrever),
`site`, `hero`, `payments` (formas de pagamento), `zones`, `upload`, `health` (estado do sistema, com o nome das variáveis que faltam), `privacy`
Só o owner: `/api/admin/admins` (+ `POST admins/:id/reset-2fa`), `GET /api/admin/audit` (registro de atividades), `POST /api/admin/privacy/anonymize`,
excluir cliente, gerar link de nova senha de cliente e e-mail de teste.

Toda resposta traz `x-request-id` (um erro `500` mostra o mesmo número no corpo: serve para achar a linha nos logs). A API nunca vai
para a CDN, exceto as duas listas públicas (10 s); o resto responde `Cache-Control: no-store`.

## Segurança

- **Segredos só no servidor**: `DATABASE_URL`, a credencial do Blob e a senha do e-mail existem apenas no servidor (nenhuma variável
  `VITE_`); o pacote do navegador não contém driver de banco, token nem segredo. O navegador só fala com `/api/*`.
- **Login do painel em duas etapas, a cada entrada** (migration `0024_admin_login_code.sql`): e-mail e senha (scrypt) e, **com a senha certa, um código de 6 dígitos
  enviado ao e-mail da própria conta administrativa**; a sessão só abre com o código (veja [Login do painel com código por e-mail](#login-do-painel-com-código-por-e-mail)).
  Sessão = código aleatório num cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` em https), 14 dias, guardado no Neon só como hash e conferido a cada chamada
  administrativa; o identificador é **renovado a cada login** (a sessão antiga do navegador morre). Sair, trocar ou redefinir a senha, desativar ou remover a pessoa (ou
  rodar `npm run admin:create` para ela) derruba as sessões. Sem cadastro público: administradores só o owner cria (ou o script `admin:create`, com acesso ao banco).
- **Senha forte** (painel: 10 caracteres ou mais; clientes: 8 ou mais): recusa senhas comuns (lista de senhas vazadas e palavras
  típicas, com variações como `brasil2026`), sequências (`1234567890`, `qwertyuiop`), repetições e o próprio e-mail ou nome com um
  enfeite. Vale ao trocar a senha, criar administrador, cadastrar cliente, "esqueci a senha" e no `npm run admin:create`
  (que confere a mesma regra quando o TypeScript do projeto está instalado). A senha nunca é registrada.
- **Limites de tentativa, atômicos**: a conferência e o registro da tentativa acontecem juntos dentro do banco (40 tentativas
  simultâneas não passam todas). Painel: 8 erros por e-mail + rede e 30 por rede a cada 15 min, e 40 por hora por e-mail para
  aparelhos que a conta não conhece. Conta de cliente: 8 por e-mail + rede, 30 por rede (15 min) e 100 por hora por e-mail.
  Consulta de pedido: 30 erradas por rede a cada 15 min. Cadastro: 6 por rede por hora (mais os limites de código e reenvio acima).
  Pedido: veja [Como funciona](#como-funciona). **Senha certa não gasta tentativa**, e quem erra de longe só bloqueia a si mesmo
  (o limite é por e-mail **e** rede), nunca o dono da conta.
- **Verificação em duas etapas (opcional, recomendada)**: aplicativo autenticador (TOTP: 6 dígitos, 30 s, cada código vale uma vez), em
  *Configurações → Painel*, com 8 códigos de recuperação (só o hash fica no banco; cada um vale uma vez). Depois da senha a pessoa tem
  5 minutos e 5 tentativas para digitar o código. Perdeu o celular? O owner usa *Administradores → Desligar 2 etapas* (ou
  `npm run admin:create -- email "Nome" --reset-2fa`). **A chave do aplicativo fica no banco sem criptografia** (o servidor precisa
  dela para conferir o código): quem conseguir ler o banco consegue gerar códigos, então proteja o acesso ao Neon.
- **Aviso de acesso novo**: entrar de um aparelho que a conta ainda não conhecia manda o e-mail "Novo acesso ao painel" (data,
  aparelho e rede) para o dono da conta, se o e-mail do site estiver configurado, e fica no registro de atividades.
- **Registro de atividades** (*Configurações → Atividades*, só o owner): quem fez o quê e quando (produtos, preços, configurações,
  banners, equipe, 2FA, privacidade, entradas no painel). Só se acrescenta (o banco recusa alterar ou apagar), é guardado por 2
  anos e não recebe senhas, códigos nem links. Gerar o link de nova senha de um cliente e excluir cliente são ações **só do owner**.
- **Cabeçalhos HTTP** (`vercel.json`): política de conteúdo (CSP) restritiva — scripts só do próprio site, sem `eval`, conexões só com
  a própria API, `frame-ancestors 'none'`, `form-action 'self'`, `object-src 'none'`, tudo por https; os estilos inline continuam
  permitidos (`style-src 'unsafe-inline'`), e o único site de terceiros que pode ser incorporado é o mapa do Google. Mais HSTS,
  `nosniff`, `X-Frame-Options: DENY`, `Permissions-Policy` (câmera, microfone, localização, pagamento e USB desligados) e
  `Referrer-Policy`. Bloqueios da CSP vão para o log do servidor (`csp-bloqueio`). Pedido, conta e painel não são indexados, não
  ficam em cache e não vazam o endereço (`no-referrer`).
- **Endereço dos links de e-mail**: vem de `SITE_URL` (ou do domínio de produção da Vercel), **nunca** do `Host` da requisição.
- **IP de quem acessa** (usado nos limites): o servidor confia no cabeçalho que a própria Vercel acrescenta e agrupa IPv6 por /64;
  cabeçalhos que o navegador inventa não valem.
- **Imagens**: o tipo vem dos bytes do arquivo, não do que o navegador declara (veja [Como funciona](#como-funciona)).
- **Conta de cliente só vale com o e-mail confirmado, conferido no servidor em toda chamada**: `login`, `/me`, "Meus pedidos",
  vincular pedido, trocar senha, excluir conta e a ligação do pedido à conta exigem `active` **e** `email_verified_at`
  (as funções do banco repetem a regra). Chamar a API direto, forjar cookie ou ter uma sessão antiga não contorna isso.
  Códigos e links só existem no banco como hash. Nenhuma chave de e-mail vai para o navegador.
- **Recuperação de senha**: link de 256 bits só como hash, 60 minutos, uso único, derruba todas as sessões, resposta idêntica
  e com o mesmo tempo exista a conta ou não, limites por conta, por IP e por link errado (acima). O link de e-mail é a única
  coisa que confirma o e-mail numa troca de senha; o gerado pela loja nunca confirma.
- Escritas administrativas só aceitam a própria origem do site (defesa extra contra CSRF).
- Toda entrada é validada no servidor (tipos, tamanhos, links `https://`) e o banco repete os limites. Consultas sempre
  parametrizadas.
- O site público nunca recebe estoque, SKU, telefone de cliente ou qualquer dado administrativo. O cliente vê o próprio
  pedido só com o código secreto do link (ou pela própria conta); o código só existe no banco como hash.
- O servidor ignora tudo o que o navegador mandar sobre status, pagamento, valores, desconto, conta ou código do pedido:
  quem decide é o banco (`create_order`) e o login do painel.
- Papéis: **admin** cuida da operação; **owner** também gerencia administradores, vê o registro de atividades e trata a privacidade
  (a loja nunca fica sem um owner ativo).
- **Dependências**: `npm audit --omit=dev` (o que roda em produção) não aponta nada. O `npm audit` completo ainda lista 5 avisos de
  severidade alta, todos do pacote `braces` dentro do Tailwind 3 (ferramenta de build; não roda no servidor nem vai para o site);
  resolvê-los pede migrar o Tailwind para a versão 4, o que muda o CSS gerado e não foi feito.

## Privacidade (LGPD)

- **Política pública** em `/privacidade` (link no rodapé e no checkout), escrita a partir do que o sistema realmente faz: dados
  coletados (pedido, conta, endereço de rede para segurança), para quê, com quem passam (hospedagem, banco, e-mail e mapa), cookies e
  dados guardados no aparelho, prazos e direitos. O botão **"Apagar os dados deste aparelho"** remove o carrinho, os dados do último
  pedido, a cópia do cardápio e os atalhos de pedidos (tudo que começa com `copocheio:`). **Razão social, CNPJ e encarregado (DPO)
  não estão cadastrados e precisam ser preenchidos pela loja; o texto deve ser revisado por quem entende de LGPD.** O que está no
  site é um ponto de partida técnico, não parecer jurídico.
- **Pedido de titular**: o formulário de `/privacidade` (`POST /api/privacy/request`, 5 por rede por hora) cai em *Clientes →
  Privacidade (LGPD)*. A loja responde pelo contato deixado (a política informa até 15 dias) e marca como atendido ou recusado, com
  anotação.
- **Anonimização** (owner): *Anonimizar uma pessoa* (telefone com DDD e/ou e-mail) tira de **todos** os pedidos dela nome, telefone,
  e-mail, endereço, complemento, referência e observações, apaga a conta e os links de acompanhamento e mantém só o que a
  contabilidade precisa (itens, valores, datas e o tipo de entrega). É tudo ou nada, numa transação, e fica no registro de atividades.
- **Mapa do Google**: a seção Contato incorpora o mapa do Google (carregado só perto da tela, com `Referrer-Policy` restrita). **Ainda
  não há um aviso de consentimento antes de carregar o mapa** — a política informa o uso. Para exigir consentimento, troque o mapa por
  um botão "Ver mapa" que só então cria o iframe.
- Prazos de guarda de cada dado: [`docs/OPERACAO.md`](docs/OPERACAO.md).

## Robôs e prévia de links

WhatsApp, Facebook, Telegram, Slack e outros não executam JavaScript, e o Google prefere HTML pronto. Por isso, para esses robôs (e só
para eles; pessoas recebem o site normal), o `vercel.json` manda a página para `GET /api/__page`, que devolve o mesmo `index.html` do
build com o `<head>` já escrito a partir do painel (*Site → SEO*): título, descrição, imagem de compartilhamento, endereço canônico,
`noindex` nas páginas privadas e dados estruturados da loja (schema.org: nome, telefone, endereço e horários **que estiverem
cadastrados**). Endereço que não existe recebe `404` de verdade. Exceção: na página inicial `/`, só os robôs de prévia de link
(WhatsApp, Facebook etc.) recebem a versão da função; o Googlebot recebe o `index.html` estático, com o título e a descrição fixos dele.
`/robots.txt` e `/sitemap.xml` são gerados pelo servidor (precisam do endereço completo do site: `SITE_URL`). O `robots.txt` bloqueia `/api/`, `/pedido/`, `/acompanhar-pedido/` e `/conta` e aponta o sitemap; o sitemap só lista as
páginas públicas e estáveis (início, cardápio, privacidade e as cinco páginas de políticas). O painel e o checkout ficam fora do Google por `noindex` (cabeçalho `X-Robots-Tag` e `<meta name="robots">`).

> Esse roteamento (`redirects`/`rewrites` com `has` por `user-agent`, `includeFiles`, cabeçalhos) foi validado com o pacote de
> roteamento da Vercel e um servidor local, **não** na Vercel de verdade: confira com `curl -A "WhatsApp/2.0" https://<seu site>/bebidas`
> depois do primeiro deploy.

## Banco (Neon)

`admins`, `admin_sessions`, `categories`, `products`, `payment_methods`, `orders`, `order_items`, `order_status_history`,
`store_settings`, `delivery_zones`, `site_settings`, `hero_settings`, `banners`, **`order_tracking_tokens`**
(hash dos códigos), **`customers`** (com `status` e `email_verified_at`), **`customer_sessions`**,
**`customer_password_resets`** (hash do link, validade, `via` = e-mail ou loja, envio e uso), **`email_verifications`** (hash do código e do link, validade, tentativas, envio e uso),
**`email_messages`**, **`email_events`**, **`email_suppressions`**, **`email_preferences`**, **`email_campaigns`**, **`email_alerts`** e **`email_webhook_state`** (o registro e a fila de e-mails: sem corpo, código nem link),
**`audit_log`** (registro de atividades do painel), **`admin_recovery_codes`**, **`admin_login_challenges`** e **`admin_devices`**
(verificação em duas etapas e aparelhos conhecidos), **`privacy_requests`** (pedidos de titulares), **`merchant_accounts`**, **`payments`**, **`payment_events`** e **`payment_refunds`** (as quatro são da integração de pagamento online, retirada: ficam **sem uso**, veja a 0036 abaixo), **`coupons`** e **`coupon_categories`**, **`store_exceptions`** (feriados e horários especiais),
**`customer_addresses`** (endereços extras), **`legal_pages`** (termos e políticas), **`couriers`**, **`order_reviews`**, **`loyalty_ledger`** (extrato de pontos) e **`job_runs`** (última execução da rotina automática)
(+ `rate_limits`, `schema_migrations`). Cada pedido guarda: id interno, número público (#1001…), data, cliente, endereço, itens com preço
da hora, subtotal, entrega, desconto, total, forma e situação do pagamento, status, histórico, conta (se houver) e
última atualização.

A migration `0004_order_tracking.sql` **preserva os pedidos existentes**: o UUID secreto dos links `/pedido/:id` já
enviados vira hash e continua abrindo o pedido; a coluna em texto puro (`public_token`) deixa de existir. Ela também
mantém, de forma transitória, a compatibilidade com a versão anterior do site (que pode seguir no ar durante um deploy
ou voltar num rollback).
A migration `0005_email_verification.sql` acrescenta o status da conta (`pending_verification`, `active` ou `disabled`,
coluna gerada a partir de `active` e `email_verified_at`, então nunca fica fora de sincronia), a tabela
`email_verifications`, as funções que emitem e conferem códigos de forma atômica (limites de reenvio e tentativas dentro
do banco) e encerra as sessões de cliente abertas antes dela.
A migration `0006_password_reset_email.sql` acrescenta a `customer_password_resets` de onde veio o link (`via`: `admin` ou
`email`), para qual e-mail foi e quando foi enviado, e as funções atômicas que pedem o link (espera de 60 s, limites por
hora e por dia), registram o envio e usam o link (trocar a senha, derrubar sessões e, só para link de e-mail enviado, confirmar o e-mail).
A migration `0007_banner_cover.sql` acrescenta `banners.placement` (`menu` ou `cover`; os banners que já existiam ficam no
cardápio, na mesma ordem) e a regra de que um banner de capa precisa de pelo menos uma imagem.
A migration `0008_store_whatsapp.sql` preenche o WhatsApp da loja quando ele ainda está vazio (quem já cadastrou outro número
não é sobrescrito).
A migration `0009_security_foundations.sql` acrescenta o contador de tentativas atômico (`rate_limit_hit` e `rate_limit_refund`), o
`audit_log` (o banco recusa alterar ou apagar linhas com menos de 2 anos), a verificação em duas etapas, os aparelhos conhecidos e o
vínculo do cadastro ao navegador (`customers.reg_nonce_hash`).
A migration `0010_promo_window.sql` acrescenta as datas de início e fim da promoção e a função `effective_promo`.
A migration `0011_orders_integrity.sql` acrescenta a chave de idempotência do pedido, o total esperado (`create_order` devolve o
erro `CC409` quando o valor mudou), as regras de status e de pagamento, o estoque que só passa a ser controlado de propósito e o
dashboard novo.
A migration `0012_privacy.sql` acrescenta `privacy_requests`, a anonimização de uma pessoa (`anonymize_person`) e amplia a limpeza
automática (`purge_expired_data`).
A migration `0013_ice_choice.sql` acrescenta `categories.ice_choice_required` e `order_items.ice_choice`, troca `create_order` (valida e
grava a escolha do gelo) e `order_json` (a escolha chega ao cliente) e marca as categorias "Copão" e "Copão com Monster". É a única
migration que **escreve um dado** (um `UPDATE` que liga a marca nessas duas categorias, achadas pelo nome só nesse momento); nenhum
pedido, produto, preço ou estoque é alterado.
A migration `0019_email_deliverability.sql` acrescenta as tabelas do registro de e-mails (acima), as funções atômicas (`email_apply_event`, `email_claim_due`, `email_forget`), os **gatilhos** que enfileiram o
e-mail de cada etapa do pedido e de cada pagamento (erro do gatilho nunca derruba o pedido) e troca `anonymize_person` e `purge_expired_data` por versões iguais para tudo o que já existe, mais a limpeza dos registros de
e-mail (180 dias). Só acrescenta; não escreve nenhum dado nem envia nenhum e-mail para pedidos que já existem.
A migration `0017_energetic_swap.sql` acrescenta `products.swap_base_product_id` (o energético que vem no combo; preenchida uma vez pelo nome),
`order_items.swap_to_product_id` e funções de apoio (`norm_text`, `is_energetic_2l`...), e troca `create_order` (entende `swap_to` em cada item),
`restore_order_stock` (devolve também o energético da troca) e `order_json` por versões iguais para tudo o que já existe: pedido sem troca se comporta
exatamente como antes.
A migration `0018_swap_options.sql` acrescenta `products.swap_base_price` (o valor do energético que vem no combo, quando não é um produto do cardápio) e a
tabela `product_swap_options` (os energéticos que o cliente pode escolher na troca de cada combo), e troca `create_order` por uma versão que calcula a
diferença sobre esse valor e respeita a lista. Não preenche nada: combo sem valor nem lista funciona exatamente como na 0017.
A migration `0016_commission_2_percent.sql` troca a taxa da comissão de 5% para **2%** (só a função `payment_commission_bps()`; cobranças já criadas
mantêm a taxa de quando nasceram).
A migration `0015_merchant_account_flow.sql` acrescenta `merchant_accounts.ambiguous`, o índice que só deixa existir um cadastro de conta ativo por
operadora e dois desfechos permitidos para os avisos de cadastro.
A migration `0014_online_payments.sql` acrescenta `merchant_accounts`, `payments` e `payment_events`, o status de pedido
`awaiting_payment`, o meio de pagamento `pix_online` (**desligado**) e as funções de pagamento (`payment_begin`, `payment_apply`,
`payment_expire_local`, `orders_cancel_unpaid`, o cálculo da comissão, 5% na origem e 2% desde a 0016, e outras); troca `create_order`, `order_json`,
`admin_set_order_status`, `admin_set_payment_status` e `admin_dashboard` por versões iguais para tudo o que já existe. Não fala com nenhuma
operadora (o adaptador ficava no servidor); a única linha de dados é o `pix_online` desligado. **Sem uso desde a 0036** (o pagamento pelo site foi retirado).
A migration `0020_card_online.sql` acrescenta o cartão de crédito online (desligado) e a **taxa de serviço do Pix** (2,5% do cliente + 2,5% do estabelecimento = 5% para a conta master; `service_fee_cents`,
`payment_fee_settings.pix_*`, colunas `payment_fee*` em `orders` e `customer_fee_cents` em `payments`). Também **sem uso desde a 0036**.
A migration `0021_pickup_time.sql` acrescentou uma coluna opcional, `store_settings.pickup_time` (texto de até 30 letras). **Hoje o site não a usa**: a janela ⓘ da página
Bebidas ficou só com horário de funcionamento e formas de pagamento, então a coluna fica vazia e sem efeito (pode ser apagada ou reaproveitada depois).
A migration `0024_admin_login_code.sql` acrescentou a tabela `admin_email_challenges` e cinco funções (`begin_admin_email_challenge`, `finish_admin_email_challenge`, `begin_admin_email_resend`,
`finish_admin_email_resend`, `verify_admin_email_code`) para o login do painel com código por e-mail. **Só acrescenta** (não toca em `admin_login_challenges`, que continua sendo o desafio
do aplicativo autenticador): nenhuma função existente muda e nenhum dado é escrito ou apagado. Voltar o código para a versão anterior continua funcionando contra este banco.
A migration `0023_login_code.sql` acrescentou a tabela `customer_login_challenges` e cinco funções (`begin_login_challenge`, `finish_login_challenge`, `begin_login_resend`,
`finish_login_resend`, `verify_login_code`) para o login do cliente com código por e-mail. **Só acrescenta**: nenhuma função existente muda e nenhum dado é escrito ou
apagado. Voltar o código para a versão anterior continua funcionando contra este banco (o login antigo só pede a senha).
A migration `0022_ice_per_product.sql` acrescentou `products.ice_choice_required` e trocou `create_order` por uma versão idêntica à da 0020, exceto por
ler a marca do **produto** (era a da categoria). Ela escreve **uma única linha de dados** (um `UPDATE` que marca os produtos que estavam em categorias que pediam o gelo, para o site
não mudar no deploy); nenhum pedido, preço, estoque ou categoria é alterado. A coluna `categories.ice_choice_required` continua no banco, sem uso.
A migration `0027_age_and_customer_cancel.sql` acrescentou `products.alcoholic` (**todos nascem `true`**), as colunas de maioridade em `orders`, `order_status_history.reason`, a regra
`order_cancel_why` e a função `customer_cancel_order`, e trocou `order_json`, `create_order` (exige `age_confirmed: true` em pedido com bebida alcoólica) e `admin_set_order_status`
(entregar pedido com bebida alcoólica exige `age_checked`). **Exceção ao rollback**: a versão anterior do site não envia a declaração, então depois da 0027 ela não consegue fechar pedido com
bebida alcoólica (veja `docs/OPERACAO.md`, item 17). A `0028_payment_refunds.sql` só acrescenta a tabela `payment_refunds` e duas funções (devolução de pagamento online; sem uso desde a 0036).
A `0036_remove_online_payments.sql` **só desliga** as formas `pix_online` e `card_online` que estivessem ligadas (idempotente) e **não apaga nada**: as tabelas, colunas e funções da integração de pagamento online ficam no banco, sem uso. Voltar o código para a versão anterior não exige desfazer nada.
A `0029_coupons_free_delivery.sql` acrescenta cupons e a entrega grátis por valor (desligada); a `0030_scheduling.sql`, o agendamento (desligado), os dias especiais e `orders.scheduled_for`; a `0031_customer_addresses.sql`, os endereços extras
da conta (até 4, trava no banco); a `0032_stock_alert.sql`, o limite de estoque baixo (padrão 5, o mesmo de antes); a `0033_legal_pages.sql`, as cinco páginas de termos e políticas com o texto padrão; a `0034_couriers_reviews_jobs.sql`, os
entregadores, as avaliações e o registro da rotina automática; a `0035_loyalty.sql`, o programa de pontos (desligado e sem valores: colunas em `store_settings`, o extrato `loyalty_ledger` só de acréscimo, `coupons.customer_id` para o cupom pessoal e o gatilho que credita/estorna). **Todas só acrescentam** (tabelas, colunas com padrão que não muda nenhum pedido e funções; `create_order` e `order_json` são trocadas por versões iguais para tudo o que já existia);
nenhuma apaga ou reescreve dados. Como as migrations só rodam no deploy de **produção**, o roteiro seguro está em `docs/OPERACAO.md` (seção 3 e item 17).
As migrations 0009 a 0024 **só acrescentam** (tabelas, colunas e funções novas; a assinatura de `create_order(payload jsonb)` continua a
mesma), para que a versão anterior do site, que segue atendendo durante um deploy ou depois de um rollback, continue funcionando contra o
banco já migrado. **Exceção da 0013**: como o banco passa a exigir o gelo, a versão anterior do site (que não sabe perguntar) não consegue
pedir os produtos marcados (inicialmente, os dos copões) enquanto a marca estiver ligada; veja o rollback em [`docs/OPERACAO.md`](docs/OPERACAO.md). **Cuidado
da 0014**: depois de um rollback do código para uma versão que ainda tinha o pagamento online, o painel antigo lista o "Pix online" e não conhece a trava que impede ligá-lo; não o ligue (o pagamento online foi retirado).
Mudanças de estrutura são arquivos novos em `db/migrations` (cada comando separado por `-- statement-breakpoint`);
`npm run db:migrate` aplica os que faltam. Regras que precisam ser atômicas (criar pedido, mudar status, estoque,
dashboard) são funções do banco chamadas só pelo servidor.

## Limites conhecidos

- Uma função da Vercel aceita até ~4,5 MB por requisição: o painel já reduz as fotos (limite de 4 MB por imagem).
- Neon pode "dormir" quando fica sem uso; a primeira chamada depois disso demora um pouco mais.
- Nenhuma checagem automática prova que a caixa de e-mail existe e é da pessoa (DNS e lista de descartáveis só descartam o
  que é claramente impossível): quem prova é o código/link. Se o provedor de e-mail da loja estiver fora do ar, o cadastro
  responde "tente de novo" em vez de criar conta sem confirmação.
- A prévia de links e o HTML para o Google dependem de regras do `vercel.json` que só foram testadas com o pacote de roteamento da
  Vercel e um servidor local (veja [Robôs e prévia de links](#robôs-e-prévia-de-links)): confira depois do deploy.
- Não há captcha, **de propósito** (veja `docs/SEGURANCA.md`, seção 8, com o gatilho para adotar e a opção recomendada). O pedido repetido só é detectado dentro da mesma aba (a chave fica no `sessionStorage`); em duas
  abas diferentes valem os limites por rede e por telefone.
- **Pagamento pelo site (Pix online e cartão online)**: **não existe**: foi retirado do sistema por decisão do proprietário. Todo pagamento é feito à loja (chave PIX, dinheiro ou cartão na entrega ou na retirada) e o dono
  marca o pedido como pago ou reembolsado à mão. O sistema não cobra, não devolve valores e não fala com operadora de pagamento. O status manual de um pedido ("cancelado") **não é** uma transação financeira.
- **Maioridade (18+)**: a janela de entrada e a caixa do checkout são **autodeclaração** (não provam idade); a prova é a conferência do documento na entrega, registrada no painel (sem guardar o documento). Os textos precisam de
  validação jurídica (`docs/JURIDICO-PENDENCIAS.md`). Todo produto nasce como bebida alcoólica: desmarque o que não é em *Produtos*.
- A chave do aplicativo de duas etapas fica no banco sem criptografia; o mapa do Google carrega sem pedir consentimento antes (veja
  [Segurança](#segurança) e [Privacidade (LGPD)](#privacidade-lgpd)).
- Acessibilidade: auditoria automática (axe-core, WCAG 2.0/2.1/2.2 A e AA) sem violações nas páginas principais em celular e computador; os alvos de toque pequenos ganharam área de 44 × 44 px **sem mudar o desenho**
  (`docs/PWA-SEO-ANALYTICS.md`, seção 4; os apontamentos antigos do Hero — nome do link da logo, região sem rótulo e pontinhos do carrossel — foram corrigidos sem mudar o visual). **Não testado:** leitor de tela real (NVDA/VoiceOver/TalkBack) e zoom de 200 %; recomenda-se um teste manual.
- **Programa de pontos**: existe (migration `0035`), mas nasce **desligado e sem valores**: as regras são do dono (`/admin/fidelidade`) e precisam de revisão jurídica/fiscal antes de ligar. **Notificações por WhatsApp/SMS/push** não existem (dependem
  de serviço pago ou de consentimento próprio); o aviso ao cliente é por e-mail. **Nota fiscal (NFC-e)** não é emitida: o sistema não tem integração fiscal (`docs/FISCAL.md`: o que existe e o que o contador precisa decidir).
- **PWA**: o site é instalável, mas não funciona sem internet (cardápio e pedido exigem conexão, de propósito: preço e estoque nunca ficam velhos).
- Alertas automáticos (queda do site, pico de erros) e envio de logs para fora da Vercel não existem: veja [`docs/OPERACAO.md`](docs/OPERACAO.md). (Os **e-mails** têm alertas próprios no painel *E-mails*.)
- **E-mails**: sem domínio próprio não há SPF/DKIM/DMARC da loja; o SMTP comum **não informa** entrega, devolução nem spam; abertura e clique não são medidos; ninguém sabe em que pasta o e-mail caiu; a fila
  não tem agendador (anda por atividade e pelo cron **diário**); e o provedor opcional (Resend) foi testado só contra um simulador. Tudo em [`docs/EMAIL.md`](docs/EMAIL.md#13-limites-conhecidos-e-pendências).

## Testes e CI

```bash
npm test                 # tipos + testes unitários + testes de API (PostgreSQL local em 127.0.0.1:5433)
npm run test:unit        # só os unitários (segundos)
npm run test:e2e         # navegador (Chromium); precisa de `npm run build` antes
```

Os testes rodam num **PostgreSQL de teste**, com Blob falso, e-mail de mentira e DNS simulado: não tocam no Neon, no Blob nem no e-mail
de verdade (nem o provedor de e-mail opcional: ele é um simulador). Como preparar o ambiente, o que cada arquivo cobre e o que os testes **não** provam estão em
[`tests/README.md`](tests/README.md). O GitHub Actions (`.github/workflows/ci.yml`) roda tudo isso a cada envio para o GitHub.

## Operação

Variáveis de ambiente, previews × produção, deploy e migrations, monitoramento, backup e restauração, o que fazer quando algo dá
errado (login bloqueado, 2FA perdido, e-mail que não chega, pedido de privacidade, troca de segredos) e por quanto tempo cada dado é
guardado: [`docs/OPERACAO.md`](docs/OPERACAO.md).

## Desempenho

O site foi medido e otimizado **sem mudar o visual nem nenhuma função**: cardápio que só redesenha o cartão tocado, busca que não trava a digitação, nada de
salto de layout na primeira visita, fotos das listas com 1/7 dos bytes (miniaturas), cardápio e foto principal (capa, promoção, primeira bebida) pedidos já na
leitura do HTML, slides escondidos dos carrosséis sem disputar a rede com a foto que aparece, finalização do pedido e vídeo da página inicial carregados só
quando servem, e partida a frio da função mais leve. O relatório (o que foi medido, antes × depois, o que **não** dá para medir
daqui, o que fica pendente e o que o dono precisa conferir) está em [`docs/DESEMPENHO.md`](docs/DESEMPENHO.md); as ferramentas de medição, em
[`tests/perf/`](tests/perf/README.md).

## Estrutura

```
api/index.ts           função da Vercel: entrega /api/* para o servidor
server/                servidor: rotas, validação, login, acompanhamento, contas, banco (Neon), imagens (Blob)
server/routes/         uma pasta de rotas por assunto (public, orders, catalog, content, session, twofactor, account, tracking, customers,
                       team, audit, privacy, seo, upload, mailadmin, payments, coupons, exports, cep, schedule, addresses, legal, reviews, couriers, cron, loyalty)
server/auth.ts         senhas (scrypt), sessões, limites de tentativa atômicos · passwordPolicy.ts / commonPasswords.ts: regra de senha forte
server/totp.ts         verificação em duas etapas (TOTP, códigos de recuperação) · adminAccess.ts: aparelhos conhecidos e aviso de acesso novo
server/audit.ts        registro de atividades do painel · clientIp.ts: IP de quem acessa · images.ts: conferência das imagens enviadas
server/verification.ts confirmação do e-mail: códigos, links, reenvio e limites
server/passwordReset.ts recuperação de senha por e-mail: link, envio, limites e aviso de senha alterada
server/mail*.ts        transporte SMTP, layout e textos dos e-mails (mailLayout, mailTemplates, mailBrand), domínio do e-mail (DNS/MX), lista de descartáveis (disposableDomains.ts, gerada)
server/email/          serviço central de e-mails: deliver(), fila, registro, tipos, preferências, alertas, DNS, provedor opcional (veja docs/EMAIL.md)
server/emailAddress.ts formato, normalização e máscara do e-mail
db/migrations/         tabelas, funções e conteúdo inicial do Neon
scripts/               migrate.mjs (migrations) · create-admin.mjs (administrador; `--reset-2fa`) · update-disposable-domains.mjs (lista de e-mails descartáveis)
src/App.tsx            site: Hero, Bebidas, Contato, chamada final, rotas
src/site/              dados do site (API), carrinho, checkout, política de privacidade (Privacy.tsx)
src/site/Tracking.tsx  confirmação, acompanhamento e "Acompanhar pedido" (pacote à parte, junto com Account.tsx)
src/site/Account.tsx   conta do cliente: login, Meus pedidos, recuperar senha
src/ErrorBoundary.tsx  tela de erro do site (em vez de tela branca) · src/lib/report.ts: envia o erro para os logs
public/email/logo.png  logo oficial reduzida para os e-mails (servida em /email/logo.png)
src/lib/               cliente da API, tipos, formatação, horários, rotas, CEP e medição de visitas (analytics.ts)
public/sw.js · manifest.webmanifest · offline.html   site instalável: service worker (só estático), manifesto e página "sem conexão"
src/admin/             painel (carregado só em /admin) · src/admin/emails/: abas do painel E-mails · src/site/EmailPreferences.tsx: preferências de e-mail do cliente
tests/                 testes unitários, de API e de navegador, com o servidor de teste (veja tests/README.md)
docs/OPERACAO.md       variáveis, deploy, monitoramento, backup, o que fazer quando algo quebra, prazos dos dados
docs/EMAIL.md          e-mails: envio, registro, entregabilidade, DNS, promoções, alertas, testes e pendências (EMAIL-AUDITORIA.md: a auditoria que originou)
docs/AUDITORIA.md      auditoria geral: o que está aprovado, o que precisa de correção, o que é parcial, o que está bloqueado, e o plano priorizado
docs/SEGURANCA.md      auditoria de segurança de ponta a ponta
docs/PWA-SEO-ANALYTICS.md  site instalável, buscadores, medição de visitas (GA4, opcional) e acessibilidade
docs/JURIDICO-PENDENCIAS.md  textos e regras que precisam de validação jurídica ou fiscal
docs/FISCAL.md        nota fiscal: o que existe (nada) e o que o contador precisa definir
.github/workflows/     ci.yml: tipos, build e testes a cada envio ao GitHub
```
