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
| `/privacidade`      | Política de privacidade (LGPD): quais dados, para quê, por quanto tempo; pedido de acesso, correção ou exclusão; botão para apagar os dados guardados neste aparelho |

Endereço que não existe mostra "Página não encontrada" (e responde `404` para o Google, que recebe o HTML pronto; veja [Robôs e prévia de links](#robôs-e-prévia-de-links)).

| Painel (só administradores)                    | O que faz                                                   |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `/admin/login`                                 | Entrar com e-mail e senha (e o código do aplicativo, se a conta usa verificação em duas etapas) |
| `/admin/dashboard`                             | Pedidos e faturamento do dia/semana/mês, gráficos, recentes |
| `/admin/pedidos` · `/admin/pedidos/:numero`    | Pedidos ao vivo, filtros (status, data, conta/visitante), busca, status, histórico, link de acompanhamento, impressão |
| `/admin/clientes`                              | Contas de clientes (confirmadas / aguardando confirmação do e-mail), estado do envio de e-mails e e-mail de teste, link de nova senha, desativar, excluir; **pedidos de privacidade (LGPD)** e anonimização (owner) |
| `/admin/produtos` · `/novo` · `/:id`           | Cadastrar, editar, duplicar, excluir, destacar, esgotar; promoção com data de início e fim; importar do cardápio antigo (JSON ou planilha) |
| `/admin/categorias`                            | Criar, editar, ordenar, ativar/desativar                    |
| `/admin/estoque`                               | + adicionar / − retirar; 0 = ESGOTADO automático            |
| `/admin/site`                                  | Logo, nome, Hero, textos das seções, SEO                    |
| `/admin/banners`                               | Banner da capa da página Bebidas (no lugar dos gelos) e carrossel do cardápio, com imagem de celular e de computador |
| `/admin/configuracoes`                         | Abas: Loja, Horários, Entrega, Pagamento, **Painel** (som, minha senha, verificação em duas etapas, estado do sistema), Administradores e **Atividades** (só o owner: quem mudou o quê) |

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
- **Escolha do gelo (Copão e Copão com Monster)**: os produtos dessas categorias só entram no pedido com a escolha **🧊 Gelo normal** ou
  **🍓 Gelo de sabor**.
  - *Quem define a regra*: uma marca na própria categoria (`categories.ice_choice_required`), não o nome que aparece no site. A migration
    `0013_ice_choice.sql` marcou "Copão" e "Copão com Monster" (sem diferenciar maiúsculas, acentos ou espaços repetidos; as outras
    categorias, como "Copões" ou "Copão Infantil", **não** são marcadas). Qualquer categoria liga ou desliga a regra em *Categorias →
    Editar → Pedir a escolha do gelo*, e a lista mostra "Pede o gelo" nas que têm. Renomear uma categoria não desliga a regra; criar uma
    categoria nova com nome parecido também não a liga.
  - *No site*: tocar em "Adicionar" num desses produtos abre "**Qual gelo você prefere? ***" com dois cartões (celular: folha que sobe
    de baixo; computador: janela no centro). Nada é adicionado sem escolher: o botão mostra "Escolha o tipo de gelo para continuar." e a
    opção escolhida fica destacada; dá para trocar de ideia antes de adicionar. A pergunta volta a cada unidade adicionada (sem opção
    marcada de antemão). Cada gelo é uma **linha separada** do pedido, com a sua quantidade (o mesmo copão com os dois gelos aparece
    duas vezes), e o cartão do produto mostra quantos já estão no pedido. Na gaveta do pedido e no checkout cada linha mostra o gelo e um
    "Alterar", que abre a mesma pergunta com a escolha atual marcada (se o outro gelo já estiver no pedido, as quantidades se somam). A
    escolha fica guardada no aparelho junto com o pedido (sobrevive a recarregar a página e a navegar). Um pedido guardado **antes** desta
    mudança com copão sem gelo continua no carrinho, marcado "Escolher o gelo *": "Finalizar pedido" mostra a mesma mensagem e não segue
    até escolher. "Pedir de novo" (em *Minha conta*) leva o gelo que foi escolhido naquele pedido.
  - *No servidor*: `create_order` (no banco) recusa o pedido se algum item de categoria que pede o gelo vier sem `ice_choice` válido
    (`"normal"` ou `"flavored"`): `400` com `code: "ice_required"`, a mensagem acima e a lista dos produtos que faltam; **nada é criado e
    nenhum estoque fica reservado**. Isso vale para qualquer requisição, não só a do site. Em produto de categoria que não pede, o campo é
    ignorado (nada muda para as outras categorias). Estoque e o limite de 99 por produto contam a **soma** das linhas do mesmo produto.
    A escolha é gravada em `order_items.ice_choice` e entra na chave de idempotência (repetir o envio com outro gelo é um pedido
    diferente). Preço, frete, total e pagamento não mudam por causa do gelo.
  - *Onde aparece*: gaveta do pedido, checkout, página do pedido e de acompanhamento, mensagem de WhatsApp para a loja, "Meus pedidos"
    (resumo), pedido no painel e recibo impresso. O ranking de mais vendidos do dashboard soma os dois gelos do mesmo produto.
- **WhatsApp**: só depois que o pedido está salvo, a página do pedido mostra o botão com a mensagem pronta para o número
  configurado no painel. O número da loja já vem preenchido — (34) 99128-3384, pela migration `0008_store_whatsapp.sql`,
  que só grava se o campo estiver vazio — e vale para todos os botões de WhatsApp do site (Contato, chamada final, cardápio
  vazio, pedido e acompanhamento) e para o rodapé dos e-mails. Para trocar ou tirar, é só editar *Configurações → Loja →
  WhatsApp da loja* (sem número, o botão abre o WhatsApp para a pessoa escolher o contato). Se a API estiver fora do ar e o
  navegador não tiver cópia do site, o botão de ajuda usa o número de `src/lib/defaults.ts`. Um link do WhatsApp (por exemplo
  `https://api.whatsapp.com/send/?phone=5534991283384`) também funciona como *Link* de um banner: tocar nele abre o chat.
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
  (opcional) aparece para o cliente depois do pedido. O **Pix online** (pagar pelo site) tem a base pronta, mas está **desligado e sem
  operadora conectada**: veja o item abaixo.
- **Pagamento online (Pix pelo site, com a ValidaPay)** — **escrito e testado contra um servidor ValidaPay FALSO que segue a documentação oficial; NUNCA
  testado na ValidaPay de verdade** (nem sandbox, nem produção). O "Pix online" nasce **desligado**; só liga com as variáveis `VALIDAPAY_*` e uma conta
  do estabelecimento **aprovada**. O que existe, o que falta, o que a documentação não confirma, o cartão e o passo a passo para ligar (começando pelo
  sandbox): [`docs/PAGAMENTO-ONLINE.md`](docs/PAGAMENTO-ONLINE.md). Em resumo:
  - O pedido com Pix online nasce **"aguardando pagamento"** (estoque reservado; a loja não o vê como novo e ele não entra nas vendas) e só
    vira **novo** quando a ValidaPay confirma (aviso **assinado** + consulta da cobrança), na mesma transação do banco. Sem pagamento
    a tempo, o Pix é **cancelado na ValidaPay** e o pedido, cancelado (o estoque volta uma vez só).
  - **Comissão de 2%** do total do pedido, calculada no banco em centavos (`payment_commission_cents`) e enviada como divisão fixa para a conta
    master (a cobrança nasce na **subconta** do estabelecimento); só vira "efetivada" quando o extrato da master mostra o crédito daquela cobrança.
  - Valor, comissão e status nunca vêm do navegador; ver o QR Code ou tocar em "Já paguei" não confirma nada; uma cobrança aberta por
    pedido; aviso repetido, atrasado ou fora de ordem não duplica pedido nem comissão.
  - **Conta do estabelecimento** (só o owner, em *Pagamentos*): vincular uma conta que a ValidaPay já tem ou cadastrar uma nova (PF/PJ), sempre com a
    autorização do titular e, em produção, a ciência das tarifas (R$ 15,00 por conta nova). Nada é criado sozinho, não duplica e o número da conta
    só entra com a confirmação oficial. Os dados pessoais vão direto para a ValidaPay e não ficam guardados aqui.
  - **Cartão online não existe, por decisão do dono da loja**: o cartão continua sendo pago **na entrega/retirada** (maquininha), como sempre. A documentação da
    ValidaPay também não mostra divisão (split) da comissão para cartão; se um dia houver cartão online, é uma mudança à parte (veja o documento acima).
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
- **Página Bebidas no computador**: a partir de 1024 px de largura a página ocupa a tela toda (a coluna estreita de 44 rem
  continua valendo abaixo disso, no celular e no tablet, que não mudam em nada). A capa vira uma faixa em largura total; o
  cabeçalho da loja (logo, nome, horário, aberto/fechado e busca) fica à esquerda e o carrossel de banners à direita (sem
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
- **O cliente só lê**: não existe rota pública que altere pedido; status e pagamento só mudam pelo painel (o servidor
  confere o login). O pedido público nunca traz telefone, e-mail, ids internos nem o código.
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

### Confirmação do e-mail (contas de clientes)

**Regra:** uma conta só passa a valer depois que a pessoa **prova que lê a caixa de e-mail** informada. Formato válido,
domínio que existe e e-mail que não é descartável são camadas extras; **nenhuma delas substitui a confirmação**.

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
   | `CRON_SECRET` | texto aleatório longo; **liga o cron diário** que processa a fila de e-mails (`/api/cron/email`) | recomendada |
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

## API

Público: `GET /api/products` · `GET /api/site` (traz `banners` do cardápio e `cover_banners` da capa) · `POST /api/orders` (devolve `{order, token}`; aceita `idempotency_key` e `expected_total`) · `GET /api/health` · `POST /api/privacy/request`
Técnico (público): `GET /api/__page` (HTML para robôs) · `POST /api/csp-report` · `POST /api/client-error`
Acompanhamento (sem login): `GET /api/tracking/:codigo` · `POST /api/tracking/lookup` (`order_number` + `code`)
Pagamento online (sem login, pelo código do pedido ou pela própria conta): `GET|POST /api/tracking/:codigo/payment` ·
`GET|POST /api/account/orders/:numero/payment` · aviso da operadora: `POST /api/payments/webhook` (nada é gravado antes de a operadora provar
que o aviso é dela, por assinatura HMAC; sem operadora conectada responde `503 payments_unavailable`)
Conta do cliente: `POST /api/account/register|verify-email|verify-link|resend-verification|login|logout|forgot-password|reset-check|reset|recover` · `GET /api/account/me` ·
`PATCH|DELETE /api/account` · `PATCH /api/account/password` · `GET /api/account/orders[/:numero]` ·
`POST /api/account/orders/claim`
Painel, sessão: `POST /api/auth/login` · `POST /api/auth/login/2fa` · `POST /api/auth/logout` · `GET /api/auth/me` · `PATCH /api/auth/password` ·
verificação em duas etapas: `GET /api/auth/2fa` · `POST /api/auth/2fa/setup|enable|disable|recovery-codes`
Preferências de e-mail (sem login, pelo link do e-mail): `GET|PATCH /api/email/preferences/:chave` · descadastro de um clique (RFC 8058): `POST /api/email/unsubscribe/:chave` ·
logado: `GET|PATCH /api/account/email-preferences` · cron diário: `GET /api/cron/email` (só com `Authorization: Bearer $CRON_SECRET`) · avisos do provedor opcional:
`POST /api/email/webhook/resend` (assinatura Svix; sem `RESEND_WEBHOOK_SECRET` nem existe)
Painel (exige login): `/api/admin/dashboard`, `orders` (+ `POST orders/:id/tracking-link`), `live`, `customers`, `mail` (+ `POST mail/test`, owner),
`emails/overview|messages[/:id]|suppressions|campaigns[/:id]|dns` (consulta; o owner age: reenviar/cancelar mensagem, `POST emails/process`, supressões, criar/testar/enviar/cancelar campanha), `products`
(+ `POST products/import`, que devolve o relatório linha a linha), `categories`, `banners`, `settings`, `store` (`PATCH` aceita `expected_updated_at`: se outra pessoa salvou antes, responde `409` em vez de sobrescrever),
`site`, `hero`, `payments` (formas de pagamento), `zones`, `upload`, `health` (estado do sistema, com o nome das variáveis que faltam), `privacy`
Só o owner: `/api/admin/admins` (+ `POST admins/:id/reset-2fa`), `GET /api/admin/audit` (registro de atividades), `POST /api/admin/privacy/anonymize`,
excluir cliente, gerar link de nova senha de cliente, e-mail de teste e os **pagamentos online**: `GET /api/admin/payments` (operadora, conta,
resumo, comissão calculada × efetivada, cobranças) · `GET /api/admin/payments/:id` · `POST /api/admin/payments/:id/refresh|ack` ·
`POST /api/admin/payments/sweep` · conta do estabelecimento: `GET /api/admin/payments/account/candidates` ·
`POST /api/admin/payments/account/link|proposal|refresh` (a forma "Pix online" só o owner liga: `PATCH /api/admin/payments/pix_online`).

Toda resposta traz `x-request-id` (um erro `500` mostra o mesmo número no corpo: serve para achar a linha nos logs). A API nunca vai
para a CDN, exceto as duas listas públicas (10 s); o resto responde `Cache-Control: no-store`.

## Segurança

- **Segredos só no servidor**: `DATABASE_URL`, a credencial do Blob e a senha do e-mail existem apenas no servidor (nenhuma variável
  `VITE_`); o pacote do navegador não contém driver de banco, token nem segredo. O navegador só fala com `/api/*`.
- **Login do painel**: e-mail e senha (scrypt); sessão = código aleatório num cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` em https),
  14 dias, guardado no Neon só como hash e conferido a cada chamada administrativa. Sair, trocar ou redefinir a senha, desativar ou
  remover a pessoa (ou rodar `npm run admin:create` para ela) derruba as sessões. Sem cadastro público: administradores só o owner cria.
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
`public/robots.txt` bloqueia `/api/`, `/pedido/`, `/acompanhar-pedido/` e `/conta`; o painel e o checkout ficam fora do Google por
`noindex` (cabeçalho `X-Robots-Tag` e `<meta name="robots">`).

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
(verificação em duas etapas e aparelhos conhecidos), **`privacy_requests`** (pedidos de titulares), **`merchant_accounts`** (conta da
loja na operadora de pagamento), **`payments`** (cobranças online, em centavos) e **`payment_events`** (avisos da operadora)
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
operadora (o adaptador fica no servidor); a única linha de dados é o `pix_online` desligado. Detalhes em
[`docs/PAGAMENTO-ONLINE.md`](docs/PAGAMENTO-ONLINE.md).
As migrations 0009 a 0019 **só acrescentam** (tabelas, colunas e funções novas; a assinatura de `create_order(payload jsonb)` continua a
mesma), para que a versão anterior do site, que segue atendendo durante um deploy ou depois de um rollback, continue funcionando contra o
banco já migrado. **Exceção da 0013**: como o banco passa a exigir o gelo, a versão anterior do site (que não sabe perguntar) não consegue
pedir produtos dessas duas categorias enquanto a marca estiver ligada; veja o rollback em [`docs/OPERACAO.md`](docs/OPERACAO.md). **Cuidado
da 0014**: depois de um rollback do código, o painel antigo lista o "Pix online" e não conhece a trava que impede ligá-lo; não o ligue.
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
- Não há captcha. O pedido repetido só é detectado dentro da mesma aba (a chave fica no `sessionStorage`); em duas
  abas diferentes valem os limites por rede e por telefone.
- **Pagamento online**: o adaptador da ValidaPay **nunca foi testado na ValidaPay de verdade** (só contra um servidor falso baseado na documentação). Não
  existem o cartão online (o cartão é pago na entrega, por decisão do dono) nem o estorno pela API. Há pontos que a documentação não confirma (veja `docs/PAGAMENTO-ONLINE.md`). Não há agendador: pedidos online não pagos são encerrados
  de passagem, quando o painel está aberto ou entra movimento. O checkout não coleta CPF/CNPJ do pagador (o Pix imediato da ValidaPay não o exige).
- A chave do aplicativo de duas etapas fica no banco sem criptografia; o mapa do Google carrega sem pedir consentimento antes (veja
  [Segurança](#segurança) e [Privacidade (LGPD)](#privacidade-lgpd)).
- Acessibilidade: o Hero (aprovado, não alterado) ainda tem apontamentos de leitor de tela (nome do link que não repete o texto
  visível e regiões sem rótulo); o texto bem pequeno e os alvos de toque de alguns botões no celular não foram mexidos para não
  mudar o visual do celular.
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

## Estrutura

```
api/index.ts           função da Vercel: entrega /api/* para o servidor
server/                servidor: rotas, validação, login, acompanhamento, contas, banco (Neon), imagens (Blob)
server/routes/         uma pasta de rotas por assunto (public, orders, catalog, content, session, twofactor, account, tracking, customers,
                       team, audit, privacy, seo, upload, mailadmin, payments)
server/payments/       pagamento online: contrato (types.ts), adaptador da ValidaPay (validapay.ts), fábrica pelas variáveis de ambiente (factory.ts), serviço (service.ts), conta do estabelecimento (merchant.ts)
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
src/lib/               cliente da API, tipos, formatação, horários, rotas
src/admin/             painel (carregado só em /admin) · src/admin/emails/: abas do painel E-mails · src/site/EmailPreferences.tsx: preferências de e-mail do cliente
tests/                 testes unitários, de API e de navegador, com o servidor de teste (veja tests/README.md)
docs/OPERACAO.md       variáveis, deploy, monitoramento, backup, o que fazer quando algo quebra, prazos dos dados
docs/EMAIL.md          e-mails: envio, registro, entregabilidade, DNS, promoções, alertas, testes e pendências (EMAIL-AUDITORIA.md: a auditoria que originou)
docs/PAGAMENTO-ONLINE.md  Pix online: o que existe, o que falta (ValidaPay), regras, contrato do adaptador, como ligar
.github/workflows/     ci.yml: tipos, build e testes a cada envio ao GitHub
```
