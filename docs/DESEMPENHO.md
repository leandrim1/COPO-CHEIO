# Desempenho do site

Relatório da otimização de desempenho do COPO CHEIO: o que foi medido, o que atrasava o site, o que mudou, os números de **antes e depois**, o que **não** dá
para medir daqui, o que ficou pendente e o que o dono precisa conferir depois do deploy. Regra seguida do começo ao fim: **o mesmo site** (identidade visual,
cores, fontes, espaçamentos, tamanhos, imagens, animações, layout, responsividade e todas as funções) **só mais rápido**, e nenhuma melhora é dada como feita
sem medir o resultado.

> Os números vêm de um celular **simulado** (Chromium com CPU 4× mais lenta e 4G lento) sobre o **site de teste** com um cardápio **sintético** de 90 produtos
> (fotos geradas pelo mesmo caminho do painel). Servem para **comparar versões nas mesmas condições**, não para prever o tempo exato de um cliente. O que não dá para
> medir aqui está na seção 8.

## 1. Em resumo

Mesmo site, mesmo visual, mesmas funções: **só mais rápido e mais leve**. Números do **celular simulado** (CPU 4× mais lenta, 4G lento de 1,6 Mbps) sobre o site de teste com 90 produtos; medianas; detalhes e
ressalvas na seção 5.

| O que o visitante sente | Antes | Depois |
| ----------------------- | ----- | ------ |
| Salto de layout na primeira visita ao cardápio (meta do Google: ≤ 0,1) | **0,60** | **0** |
| Foto principal do cardápio na tela (capa / 1ª promoção) | 7,8 s | **4,9 s** |
| 1ª bebida da página inicial na tela | 3,6 s | **1,6 s** |
| 1º produto do cardápio na tela | 1,89 s | **1,74 s** |
| Fotos baixadas para rolar o cardápio todo | 15,1 MB | **2,8 MB** |
| Espera pelas fotos da tela depois de rolar rápido e parar | 29,6 s | **0,9 s** |
| Memória do navegador depois de rolar o cardápio todo | 801 MB | **300 MB** |
| Digitar na busca (duração mediana de cada letra) | ~100 ms | **~40 ms** |
| Pacote principal de JavaScript (comprimido) | 113 KB | **106 KB** |
| Lighthouse, celular, `/bebidas` (nota) | 50 | **79** |
| Partida a frio do servidor (importar a função) | 256 ms | **86 ms** |

**O que fica igual ou não melhorou** (dito com todas as letras): o **bloqueio da thread principal na carga (TBT)** é o mesmo (312 → 323 ms, dentro da variação); o **toque em "Adicionar"** continua em ~160 ms
(o JavaScript dele caiu de 44–50 para 25–29 ms, mas o resto do tempo é do navegador desenhando); o **primeiro desenho da página inicial** ficou ~80 ms mais tarde (dentro da variação), em troca de a foto principal
aparecer 2 s antes; e o **LCP do Lighthouse em `/bebidas` no celular (5,5 s) ainda passa da meta de 2,5 s**: com os banners de teste (~200 KB cada) a tela precisa de ~700 KB e o 4G lento entrega ~200 KB/s —
no site real depende do tamanho das fotos que a loja enviou (veja a seção 7).

**Nada foi publicado.** O trabalho está num commit local; um deploy de produção aplica a migration `0025` (duas colunas opcionais) e exige a ação do dono descrita na seção 9.

## 2. Como foi medido

- **Ferramentas** (todas em [`tests/perf/`](../tests/perf/README.md), repetíveis): `bench.cjs` (carga a frio, rolagem do cardápio inteiro, interações, volta ao site),
  `interactions.cjs`, `lcp.cjs` (quando a foto principal aparece e a fila das fotos na rede), `scroll.cjs` (custo de renderização), `memory.cjs`, `cls.cjs`, `shots.cjs` + `diff.cjs` (comparação visual pixel a pixel) e `lighthouse.mjs`
  (Lighthouse 12). O estrangulamento de CPU e de rede é feito pelo protocolo do Chrome (o mesmo do painel *Performance*/*Network* do DevTools); um proxy comprime o
  texto em Brotli, como a Vercel faz, para os bytes de rede serem os de produção.
- **Perfis**: *android* (412 × 915, DPR 2,625, CPU 4×, 1,6 Mbps, 150 ms), *weak* (aparelho muito fraco: CPU 6×, 0,8 Mbps, 300 ms) e *desktop* (1366 × 768, 10 Mbps, 40 ms).
- **Antes** = o commit publicado (`1539013`), construído e servido do mesmo jeito; **depois** = esta versão. As duas rodam ao mesmo tempo na mesma máquina, sobre o **mesmo
  banco** de teste. Cada número é a **mediana** de 3 a 5 execuções.
- **Métricas-alvo do Google** (p75 de usuários reais): LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1. Aqui o INP é estimado pela duração de cada interação com a CPU estrangulada.

## 3. O que realmente atrasava o site (diagnóstico)

Medido sobre a versão publicada (`1539013`), cardápio sintético de 90 produtos, celular simulado:

1. **Fotos dos produtos pesadas demais para o espaço que ocupam.** O painel grava a foto com até 1200 px de largura, mas o site a mostra em no máximo 176 px (lista) ou
   ~290 px (favoritos). Rolar o cardápio inteiro baixava **15,8 MB de fotos** (95 arquivos, ~160 KB cada) e deixava **cada foto decodificada em ~5,8 MB de memória**
   (1200 × 1200 × 4 bytes). Quem rolava rápido e parava num ponto do cardápio esperava **~30 s** até as fotos da tela aparecerem (todas as outras, já pedidas, disputavam a rede).
2. **Cada toque em "Adicionar" refazia os ~90 cartões do cardápio** (preço, ícones, imagem de cada um): mediana de **~165 ms** por toque e até **256 a 336 ms** ao digitar na busca,
   com a CPU de um celular intermediário. O cardápio não era memoizado e a busca refazia o texto de busca de todos os produtos a cada letra.
3. **Salto de layout de 0,60 na primeira visita (celular e tablet)** — o triplo do limite (0,1) do Google. Os brilhos de fundo ficam a 1/3 e 2/3 da **altura da página**: quando o
   cardápio chegava e a página crescia de ~1 500 para ~17 000 px, eles "andavam" mais de 5 000 px; e o bloco que continha o esqueleto de carregamento era o mesmo que depois recebia
   o cardápio, então contava como elemento que mudou de lugar. (Quem já visitou o site não via isso: o cardápio salvo no navegador aparece na hora.)
4. **O cardápio só começava a ser pedido depois que todo o JavaScript baixava, era lido e iniciava**: com 4G lento, os pedidos de `/api/products` e `/api/site` saíam em **~1,45 s**
   e o primeiro produto aparecia em **~1,9 s**, uma cascata desnecessária (o HTML já sabe que vai precisar deles).
5. **O formulário de finalização (22 KB, 7 KB comprimidos) ia junto no pacote principal** de quem só olha o cardápio.
6. **Página inicial**: o vídeo de fundo (arquivo externo, de tamanho desconhecido) começava a baixar junto com a primeira foto e **as outras duas fotos de bebida (de 100 a 210 KB cada)
   eram baixadas de imediato**, embora só apareçam 4,5 s depois; a logo de 512 px (72 KB) era usada em tamanhos de 36 a 128 px e o gelo de 320 px (56 KB) em tamanhos de 28 a 80 px;
   o vídeo ignorava "reduzir movimento" e a economia de dados.
7. **Custo de pintura na rolagem**: cada um dos ~90 cartões tinha `backdrop-blur` (desfoque do que está atrás), que obriga o navegador a criar uma camada própria por cartão.
   Na rolagem do cardápio, só o `Commit` das camadas somava **~1,1 s** de thread principal.
8. **Função da Vercel (partida a frio)**: de ~260 ms para importar o servidor, ~100 ms eram do `nodemailer` e ~106 ms do SDK do Blob, que a imensa maioria das chamadas (cardápio, textos,
   pedidos) nunca usa.
9. **Carrosséis (capa e promoções) baixavam a foto de TODOS os slides de uma vez.** Os slides que ainda não aparecem ficam empilhados sob o da vez, com opacidade 0, mas *dentro da tela*; o navegador
   não sabe que estão escondidos e os trata como visíveis (`loading="lazy"` só olha a posição). Na medição com 5 banners de ~200 KB (a imagem principal da página era a 1ª promoção), as 5 fotos
   disputavam a rede com a que importa: a foto principal só chegava aos **7,7 s** (4G lento), embora 2 fotos (390 KB) bastassem para a tela.
10. **A foto principal só era descoberta depois do JavaScript**: capa e promoção em `/bebidas` e a 1ª bebida da página inicial só eram pedidas depois de o pacote baixar, rodar e o React desenhar
    a tela — mais de 1 s depois de a resposta com o endereço da foto já estar no navegador.

**O que foi verificado e NÃO era problema** (e por isso não foi mexido): fontes (o site usa as do sistema: nenhuma fonte para baixar), *source maps* (não são publicados), cache dos arquivos
do site (`/assets` com cache de 1 ano, imutável; imagens fixas com cache de 1 dia), compressão (a Vercel comprime em Brotli), consultas ao banco (as listas públicas escolhem as colunas
uma a uma, sem `select *`; a consulta do cardápio leva **0,76 ms** para 90 produtos e o esquema já tem índices em todos os filtros e ordenações usados), cache das listas públicas
(`s-maxage=10` na borda da Vercel; dados privados continuam `no-store`), nenhuma consulta duplicada na carga das páginas.


## 4. O que mudou e por quê

### Cardápio (React)

| Mudança | Arquivo | Por quê |
| ------- | ------- | ------- |
| Cartões da lista e dos favoritos viram `memo` e recebem funções que **nunca mudam de identidade** (a quantidade chega como número) | `src/App.tsx` | Ao mexer no pedido só o cartão daquele produto é redesenhado (antes, os ~90). A regra de "aumentar mostra o aviso do combo" continua a mesma: o cartão informa de quanto para quanto. |
| Busca **adiada** (`useDeferredValue`) e texto de busca de cada produto preparado **uma vez** por cardápio | `src/App.tsx` | O campo responde na hora; a lista é refeita logo depois, sem travar a digitação em celular fraco. Mesmo resultado, mesma ordem. |
| Depois de buscar o cardápio de novo, o que **não mudou** continua sendo o **mesmo objeto** (`reuseUnchanged`) | `src/site/data.tsx` | A cópia salva no navegador costuma ser igual ao que chega da API: com objetos iguais, nada é redesenhado (nem o pedido é reajustado). Dado novo sempre vale. |
| Um `Intl.Collator` só (em vez de `localeCompare(…, 'pt-BR')` a cada comparação) | `src/site/data.tsx` | Mesma ordem, menos trabalho na ordenação do cardápio. |
| `backdrop-blur` tirado dos cartões da lista | `src/App.tsx` | Era o que criava uma camada por cartão (ver diagnóstico 7). O fundo atrás dos cartões é um preto liso com brilhos já desfocados, então o desfoque não aparecia; a **única diferença visual** é o serrilhado do texto, que muda de forma imperceptível (seção 6). |

### Saltos de layout (CLS)

| Mudança | Arquivo | Por quê |
| ------- | ------- | ------- |
| O esqueleto de carregamento fica num bloco **só dele** (`key` próprio); o cardápio entra num bloco novo | `src/App.tsx` | O navegador só conta como salto o que já estava na tela e mudou de lugar; elemento novo não conta. O visual final é o mesmo. |
| Os brilhos de fundo só aparecem quando o cardápio chega (na primeira visita) e a linha "aberto agora / ⓘ" já reserva o seu lugar | `src/App.tsx` | Eles ficam a 1/3 e 2/3 da altura da página e "andavam" mais de 5 000 px; a linha de situação aparecia empurrando o título 28 px. Quem já visitou não vê nada diferente. |

### Dados e carregamento

| Mudança | Arquivo | Por quê |
| ------- | ------- | ------- |
| **Pedido adiantado**: um script minúsculo (`/early.js`, 2 KB, assíncrono) começa a pedir `/api/products` e `/api/site` assim que o HTML é lido; `fetchShop` usa essas respostas (e pede sozinho se faltarem ou vierem com erro) | `public/early.js`, `index.html`, `src/site/data.tsx` | Tira a cascata do diagnóstico 4. Arquivo à parte (e não inline) porque a política de segurança do site continua **sem** aceitar script dentro do HTML (`script-src 'self'`, intocada). Não roda no painel. |
| O mesmo script abre, antes de qualquer foto ser pedida, a **conexão com o Blob** (`preconnect`), pelo endereço da última visita ou, na primeira, pelo da resposta do cardápio | `public/early.js` | DNS + conexão + TLS levam de 2 a 3 idas e voltas (uns 300 a 450 ms em 4G) e começavam só quando a primeira foto era pedida. **Não medível aqui** (as fotos de teste são do mesmo endereço do site). |
| Finalização do pedido num **pacote à parte** (`lazy`), baixado em segundo plano quando o primeiro item entra no pedido | `src/App.tsx` | −8 KB comprimidos no pacote principal de quem só olha o cardápio; ao tocar em "Finalizar" o formulário já está lá. |
| Vídeo e fotos da **página inicial**: o **vídeo de fundo** só começa depois que a foto da bebida chegou (e não é baixado com *economia de dados* ou rede 2G; com *reduzir movimento* mostra só o primeiro quadro); as **outras bebidas** só são baixadas depois da primeira | `src/App.tsx` | Diagnóstico 6. Nada muda para quem tem boa conexão: o vídeo começa uma fração de segundo depois e as bebidas aparecem na mesma hora da troca (4,5 s). |
| `fetchPriority="high"` na primeira imagem do carrossel do cardápio | `src/App.tsx` | O Lighthouse apontava a falta de prioridade na imagem que define o LCP. |
| **Foto principal adiantada**: quando a resposta de `/api/site` chegou **e o pacote principal terminou de baixar**, o `early.js` pede (`<link rel="preload" as="image">`, prioridade alta) a foto do 1º slide da capa, a do 1º slide do cardápio (celular × computador, a mesma escolha do `<picture>`) e, na página inicial, a 1ª bebida (a do painel ou a de sempre) | `public/early.js` | Diagnóstico 10. Só em `/` e `/bebidas`, só `https` ou caminho do próprio site, pelo **mesmo endereço** que o site vai usar (conferido: nenhuma foto é baixada duas vezes, nenhum aviso no console). **Esperar o pacote** foi uma correção medida: pedindo a foto já na resposta (antes do pacote terminar), ela dividia a rede com o JavaScript e atrasava o primeiro desenho (FCP +0,4 s, 1º produto +0,2 s no 4G lento); esperando, o navegador só faz contas (rodar o JavaScript) enquanto a foto baixa. |
| **Slides escondidos dos carrosséis só pedem a foto depois que a 1ª terminou** (carregou ou falhou), com `fetchPriority="low"`; garantia de 8 s caso o aviso nunca chegue; o slide da vez sempre carrega | `src/App.tsx` (`useRestReady`, `CoverSlide`, `BannerCarousel`) | Diagnóstico 9. Para quem vê nada muda: no ritmo normal os slides já estão prontos antes da vez deles (conferido no teste `e2e-slides`). A página inicial já fazia o mesmo com as bebidas. |

### Imagens

| Mudança | Arquivo | Por quê |
| ------- | ------- | ------- |
| **Miniaturas das fotos dos produtos** (400 e 720 px de largura): o painel as gera ao salvar uma foto. As **listas** (cartões e linhas do pedido) usam direto a de 400 px num `<img>` simples; os **favoritos** (poucos cartões grandes) usam `srcset` + `sizes` e o navegador escolhe entre 400 e 720 px | `db/migrations/0025_image_variants.sql`, `src/admin/client.ts`, `src/admin/Products.tsx`, `server/routes/catalog.ts`, `server/routes/public.ts`, `server/blob.ts`, `src/site/data.tsx`, `src/site/ui.tsx`, `src/App.tsx` | Diagnóstico 1: cada foto da lista passa de ~160 KB para **~26 KB** (a de 400 px tem 16% dos bytes) e de ~5,8 MB para ~0,6 MB de memória decodificada. Por que `srcset` não vai nas ~90 fotos da lista: medido, escolher a fonte por `srcset` + `sizes` custa **~95 ms** de CPU (celular 4× mais lento) para criar as 90 imagens, contra ~4 ms com `src` simples; a de 400 px já cobre o cartão (até 176 px) em tela 2×. Foto sem miniatura continua sendo a foto original. |
| Botão **Gerar miniaturas (N)** em *Produtos* + rota `GET /api/admin/image-source` (só para o painel; só repassa o endereço de foto que está cadastrado em algum produto, no Blob da loja ou em outro site público, com as travas descritas em `docs/SEGURANCA.md`) | `src/admin/Products.tsx`, `src/admin/client.ts`, `server/routes/upload.ts` | Fotos que já existem também ganham miniatura, sem reenviar nada. O navegador não consegue ler a foto sozinho (a política de segurança só deixa o site falar com ele mesmo), por isso o servidor repassa os bytes. O botão aparece para **toda** foto sem miniatura (também as importadas de outro endereço) e o cadastro do produto tem o botão **Gerar miniatura desta foto**. |
| Logo e gelo em tamanhos menores (`logo-128/256.webp`, `gelo-96/192.webp`) com `srcset` | `public/`, `src/site/ui.tsx`, `src/site/shell.tsx`, `src/App.tsx`, `vercel.json` | A logo de 512 px (72 KB) aparece em 36 a 128 px; passa a baixar 8 a 20 KB. O gelo (56 KB) aparece em 28 a 80 px. Só para a logo **padrão** (a enviada pelo painel segue como está). |
| Painel: miniaturas na lista de *Produtos* e em *Estoque* | `src/admin/Products.tsx`, `src/admin/Stock.tsx` | A lista do painel mostrava a foto de 1200 px em quadradinhos de 48 px. |

### Servidor e Vercel

| Mudança | Arquivo | Por quê |
| ------- | ------- | ------- |
| `nodemailer` e SDK do Blob carregados **no primeiro uso** (`import()` dinâmico) | `server/mail.ts`, `server/blob.ts` | Diagnóstico 8: a função que atende o site não paga ~200 ms de importação na partida a frio. Comportamento idêntico. |
| Cache de 1 dia (+ 7 dias de "revalidar em segundo plano") para `early.js` e para as novas cópias de logo/gelo | `vercel.json` | Mesma regra já usada nas outras imagens fixas. |
| Índices, consultas, cabeçalhos de cache das listas públicas | — | Conferidos: **nenhuma mudança necessária** (ver "O que foi verificado"). |

### Achado de passagem

`src/site/energeticSwap.ts` e `src/site/EnergeticSwap.tsx` diferiam **só na caixa das letras**: num sistema de arquivos que não diferencia maiúsculas de minúsculas (macOS, Windows) um
sobrescreve o outro, e o analisador do pacote quebrava. O arquivo `.ts` (o contexto) passou a se chamar `energeticSwapContext.ts` (só a importação mudou).


## 5. Resultados completos (antes × depois)

> Proveniência: "depois" = esta versão; "antes" = `1539013`. As comparações **intercaladas** (A/B: uma execução de cada versão, alternando, 10 vezes) e as feitas lado a lado (rolagem estável, memória, interações,
> foto principal, Lighthouse, comparação visual) foram na mesma sessão. As **matrizes** de 3 a 5 execuções por cenário (as linhas marcadas com *matriz*) têm a versão antiga medida numa sessão anterior da mesma
> máquina; use-as pela ordem de grandeza, e as intercaladas para diferenças pequenas. A máquina de medição foi reiniciada no meio do trabalho (os servidores de teste foram recriados; os arquivos ficaram).

### 5.1 Carga a frio de `/bebidas` no celular (CPU 4×, 1,6 Mbps, 150 ms)

| Métrica | Antes | Depois | Observação |
| ------- | ----- | ------ | ---------- |
| Salto de layout (CLS) | 0,596 | **0** | meta ≤ 0,1 |
| Foto principal na tela (LCP real, `lcp.cjs`, 3 execuções) | 7 800 ms | **4 860 ms** | era o último a chegar: 5 fotos de banner (~200 KB) disputavam a rede; hoje só as 2 visíveis vêm primeiro |
| 1º produto na tela (A/B, 10 execuções) | 1 890 ms (1 796–1 982) | **1 741 ms** (1 585–1 837) | os dados são pedidos na leitura do HTML |
| Primeiro desenho (FCP) | 1 444 ms (1 392–1 512) | 1 468 ms (1 408–1 480) | igual |
| Bloqueio da thread principal (TBT) | 312 ms (257–396) | 323 ms (303–389) | igual (faixas se sobrepõem) |
| Bytes até 4 s depois do 1º produto | 254 KB | 862 KB | de propósito: as fotos principais agora chegam dentro da janela (antes só ~7 s) |
| CPU da thread principal nessa janela | 1 685 ms | 2 055 ms | consequência da linha acima (desenhar as fotos que chegaram); o TBT não mudou. Interpretação, não medida à parte |
| JavaScript baixado (comprimido, *matriz*) | 103,4 KB | 101,0 KB | pacote principal −26,5 KB brutos (−6,9 KB comprimidos): a finalização do pedido virou pacote à parte |
| Volta ao site (cache, *matriz*) | 1 183 ms | 1 147 ms | igual |

### 5.2 Rolar o cardápio (celular, 1,6 Mbps) — *matriz*

| Métrica | Antes | Depois |
| ------- | ----- | ------ |
| Fotos baixadas para rolar tudo | 15,1 MB | **2,83 MB** |
| Espera até as fotos assentarem depois de rolar tudo | 60,1 s | **3,0 s** |
| Rola rápido até 45% do cardápio e para: espera pelas fotos da tela | 29,6 s (7,41 MB) | **0,9 s** (1,64 MB) |
| Quadros acima de 50 ms **durante** a rolagem | 7 | 11 |
| Quadros acima de 50 ms na rolagem **com as fotos já carregadas** (5 execuções, lado a lado) | 3 | 2 |
| Tempo da thread principal na rolagem estável | 6 148 ms | 6 075 ms |

Os 11 quadros lentos "durante" a rolagem não são piora de renderização: no site antigo as fotos nem chegavam enquanto se rolava (a tela ficava vazia por 30 a 60 s); hoje elas chegam e são desenhadas na hora. Com as fotos
já carregadas, a rolagem custa o mesmo.

### 5.3 Memória do navegador depois de rolar o cardápio inteiro (PSS lido de `/proc`, 3 execuções)

| | Antes | Depois |
| - | ----- | ------ |
| Processo da página (início → depois de rolar) | 117 → **720 MB** | 106 → **233 MB** |
| Navegador inteiro (início → depois) | 188 → **801 MB** | 177 → **300 MB** |
| Pixels de fotos decodificados (101 / 99 fotos) | ≈ 532 MB | **≈ 69 MB** |
| Memória do JavaScript | 8 MB | 5 MB |
| Nós do DOM | 2 366 | 2 420 |

Num celular de entrada, 800 MB para uma aba é o que costuma terminar em "a página travou/recarregou"; 300 MB não.

### 5.4 Interações (CPU 4×, rede normal; 5 execuções × 6 produtos espalhados)

| Interação | Antes | Depois |
| --------- | ----- | ------ |
| Digitar na busca (mediana / máximo) | 96–104 ms / 256–888 ms | **32–40 ms / 120–160 ms** |
| Tocar em "Adicionar": duração total (mediana, 3 rodadas) | 160 / 168 / 176 ms | 160 / 144 / 176 ms (sem diferença consistente) |
| …só o JavaScript do site (processamento) | 44–50 ms | **25–29 ms** |
| …atraso de entrada (a thread estava ocupada) e desenho (estilo/layout/pintura) | ~65 ms e ~52 ms | ~70 ms e ~55 ms (iguais) |
| Abrir o pedido | 128–192 ms | 136–144 ms |
| Computador (1×), "Adicionar" máx / busca máx (*matriz*) | 128 / 56 ms | **72 / 24 ms** |

Tudo abaixo de 200 ms (meta de INP) mesmo com a CPU de um celular de entrada, em ambas as versões; a melhora é na busca e no custo de JavaScript por toque.

### 5.5 Aparelho muito fraco (CPU 6×, 0,8 Mbps, 300 ms) — *matriz*

| | Antes | Depois |
| - | ----- | ------ |
| Salto de layout (CLS) | 0,506 | **0,007** |
| 1º produto na tela | 3 536 ms | **3 103 ms** |
| Bloqueio da thread principal (TBT) | 662 ms | **505 ms** |
| Foto principal na tela (LCP real, 3 execuções) | 14,8 s | **11,2 s** |
| Primeiro desenho (FCP) | 2 664 ms | 2 672 ms |

### 5.6 Computador (1366 × 768, 10 Mbps) — *matriz*

| | Antes | Depois |
| - | ----- | ------ |
| `/bebidas`: LCP / CLS | 1 780 ms / 0,02 | **976 ms / 0** |
| `/bebidas`: fotos baixadas para rolar tudo | 12,4 MB | **2,1 MB** |
| `/`: LCP / bytes | 856 ms / 658 KB | **700 ms / 546 KB** |

### 5.7 Página inicial no celular (CPU 4×, 1,6 Mbps)

| | Antes | Depois |
| - | ----- | ------ |
| 1ª bebida (foto principal) pronta | 3,6 s | **1,6 s** |
| Primeiro desenho (FCP, A/B, 10 execuções) | 1 630 ms (1 576–1 728) | 1 708 ms (1 572–1 848) |
| Bytes / JavaScript | 658 / 103,4 KB | 656 / 101,0 KB |

A foto principal passa a ser pedida pouco antes de o JavaScript rodar (com ele já baixado) em vez de depois; o primeiro desenho fica ~80 ms mais tarde (dentro da variação das faixas), a foto aparece ~2 s antes.

### 5.8 Lighthouse 12 (simulação padrão, 3 execuções, mediana; site de teste)

| | `/bebidas` celular | `/` celular | `/bebidas` computador | `/` computador |
| - | ------------------ | ----------- | --------------------- | -------------- |
| Nota de desempenho | 50 → **79** | 88 → **92** | 88 → **97** | 99 → **100** |
| LCP | 11,2 s → **5,5 s** | 3,7 s → **3,2 s** | 2,2 s → **1,2 s** | 0,87 s → **0,69 s** |
| CLS | 0,551 → **0** | 0 → 0 | 0,047 → **0** | 0,007 → 0,007 |
| TBT | 197 → **65 ms** | 105 → 110 ms | 0 → 4 ms | 0 → 0 |
| Peso da página | 2 646 → **1 474 KB** | 661 → **570 KB** | 3 573 → **1 759 KB** | 661 → **550 KB** |

O Lighthouse *simula* a rede a partir de um carregamento sem estrangulamento; ele subestima o efeito de "pedir a foto mais cedo" (por isso a página inicial mostra só 3,7 → 3,2 s, e a medição direta com a rede
estrangulada, 5.7, 3,6 → 1,6 s). Acessibilidade 96, boas práticas 96–100 e SEO 100 não mudaram.

### 5.9 Servidor

| | Antes | Depois |
| - | ----- | ------ |
| Importar a função da Vercel (partida a frio, sem rede nem banco, 9 processos novos) | 256 ms | **86 ms** |
| Consulta pública do cardápio (90 produtos) | 0,76 ms | 0,76 ms (já estava certa: índices, sem `select *`) |
| `/api/products` comprimido | — | +0,3 KB (duas URLs de miniatura por produto) |

### 5.10 O visual não mudou (comparação pixel a pixel, relógio congelado)

21 capturas (celular 390 px, tablet 820 px e computador 1366 px; `/bebidas` em 6 posições de rolagem e `/`), antes × depois: **nenhum deslocamento de layout, cor, tamanho ou posição**. As únicas diferenças (média de
0,03 a 0,9 em 255 por pixel; 0,1% a 4% dos pixels, mais nas telas com mais cartões) estão em duas coisas, conferidas no mapa de calor: o **serrilhado das bordas do texto** (tirar o `backdrop-blur` dos cartões muda o
modo como o navegador suaviza as letras) e as **bordas dos copos** (a lista usa a cópia de 400 px da foto, reduzida pelo navegador de outro jeito que a de 1200 px). Duas capturas do mesmo site dão diferença zero.

## 6. Verificação: nada quebrou

Rodado na versão final, **tudo verde** (nada foi pulado nem desligado):

| Verificação | Resultado |
| ----------- | --------- |
| `npm run typecheck` / `npm run build` | sem erros; pacote principal 359 KB (106 KB comprimido) |
| Testes unitários (`npm run test:unit`) | **262 / 262** (inclui os novos: miniaturas, reaproveitamento dos dados, `early.js` e a foto adiantada) |
| Testes de API (28 suítes, banco PostgreSQL de teste) | **2 896 verificações, 0 falhas** (inclui `api-test27`, as miniaturas; o servidor não mudou depois desta bateria) |
| Testes de navegador (Chromium, 21 arquivos, celular e computador) | **1 943 verificações, 0 falhas** (inclui `e2e-thumbs` e `e2e-slides`, novos), repetidos por inteiro depois da última mudança |
| Testes que **podem falhar**: `e2e-slides` rodado contra a versão sem a correção dos carrosséis | falhou em 5 verificações (os slides escondidos eram pedidos junto com o primeiro); com a correção, passa |

O que isso cobre, item a item do pedido: cadastro e login (e-mail de qualquer provedor, código de 5 min, login do painel com código) — `e2e-login`, `e2e-logincode`, `e2e-adminlogin`, `e2e-providers`, `e2e-verify`, `e2e-emails`,
`api-test26`; cardápio, busca, categorias, preços e promoções — `e2e`, `e2e-info`; carrinho, totais, taxas (entrega, cartão) e gelo/combos — `e2e`, `e2e-ice`, `e2e-combo`, `e2e-card`; pagamentos Pix e cartão — `e2e-pix`,
`e2e-card`, `api-test14` a `16`; acompanhamento do pedido — `e2e-track`; painel e permissões — `e2e-hardening`, `e2e-adminlogin`, `api-test10` a `12`; cadastro, edição e exclusão de produto e upload ao Blob — `e2e-thumbs`,
`e2e-cover`, `api-test27`; atualização de status — `e2e`, `e2e-track`; layout celular × computador — `e2e-cover`, `e2e-info`, `e2e-thumbs` e a comparação visual (5.10).

Conferido também, à mão, com as ferramentas de `tests/perf/`: nenhuma foto é baixada duas vezes e não há aviso no console com a foto adiantada; o vídeo da página inicial só começa depois da primeira bebida e respeita
*economia de dados* e *reduzir movimento* (teste com um vídeo de teste, já que o real está bloqueado aqui).

## 7. Resolvido × pendente

### Resolvido (medido, seção 5)

- Salto de layout na primeira visita: de 0,60 para **0** (celular e tablet) e de 0,02 para 0 (computador).
- Peso e memória das fotos nas listas (miniaturas): ~7× menos bytes por foto; rolar o cardápio inteiro baixa 5× menos, a espera pelas fotos da tela cai de ~30–60 s para ~1–3 s, a memória do navegador cai de 801 para 300 MB.
- Foto principal (capa, 1ª promoção, 1ª bebida da página inicial): descoberta na leitura do HTML e sem a concorrência dos slides escondidos: 7,8 → 4,9 s em `/bebidas`, 3,6 → 1,6 s na página inicial.
- Busca: 3× mais rápida por letra; JavaScript de cada toque em "Adicionar" ~40% menor (a duração total do toque não mudou).
- Cardápio pedido em paralelo com o JavaScript (primeiro produto na tela ~150 ms mais cedo) e pacote principal 7 KB (comprimido) menor. **O TBT não melhorou** (igual).
- Página inicial: foto principal sem disputar rede com o vídeo e com as outras bebidas; vídeo respeita *reduzir movimento* e *economia de dados*; logo e gelo bem menores.
- Partida a frio da função: de 256 para 86 ms (sem `nodemailer` nem SDK do Blob na importação).

### Pendente (de propósito ou por não ser possível aqui)

- **Gerar as miniaturas das fotos que já existem em produção**: depende do dono clicar em *Produtos → Gerar miniaturas* depois do deploy (seção 9). Até lá o site mostra a foto original,
  exatamente como hoje.
- **Região das funções da Vercel × região do Neon**: se estiverem longe, cada consulta paga ~100 a 150 ms de ida e volta e **nenhuma otimização de código compensa isso**. É uma
  configuração do projeto, não do código (seção 9).
- **Medição real**: Lighthouse em produção, Core Web Vitals de usuários reais e testes em aparelhos de verdade (Android de entrada, iPhones antigos). Veja a seção 8.
- **Vídeo da página inicial** (arquivo externo no CloudFront): não há como ver o tamanho real daqui. Se for grande (vários MB), vale comprimi-lo ou servir uma versão menor para celular
  (o código já espera a foto principal e respeita economia de dados e *reduzir movimento*).
- **LCP de `/bebidas` no celular ainda acima de 2,5 s no laboratório (Lighthouse 5,5 s; medição direta 4,9 s)**: a tela precisa de ~700 KB (2 banners + fotos dos primeiros produtos) e o 4G lento entrega ~200 KB/s.
  Os banners do teste têm ~200 KB cada; o painel já reduz os do celular a 1000–1200 px, mas o tamanho real das fotos da loja é o que decide. Vale conferir no Search Console (seção 9) e, se for o caso, trocar por banners mais leves.
- **Animações contínuas do topo da página** (gelos flutuando, brilhos): custam ~12% de uma thread com a tela no topo e a CPU 4× mais lenta; **mantidas** (fazem parte da identidade visual) e já param com *reduzir movimento*.
- **Banners e imagens do Hero/Site** continuam com uma só versão por imagem (os banners já têm a de celular e a de computador). Se a loja subir fotos muito grandes ali, a mesma ideia das
  miniaturas pode ser aplicada.
- **CSS único** (96 KB, 15,5 KB comprimidos, painel e site juntos): separar o do painel economizaria só ~2 KB comprimidos no site. Medido e **não compensa**.
- **`/api/account/me` em toda página**: uma chamada pequena e assíncrona (não atrasa o desenho). Pular a chamada para quem nunca entrou exigiria um indicador no navegador (cookie legível), que
  tem risco de mostrar "Login" para quem está logado; **deixado como está de propósito**.
- Suporte a iOS muito antigo: o pacote foi conferido com o esbuild para **Safari 15** (iPhone 6s/7 em diante); iOS 12 a 14 não foram testados (não faz parte desta tarefa mexer no alvo da compilação).


## 8. O que NÃO foi possível medir (e por quê)

Medido **só no laboratório** (Chromium com CPU e rede simulados, banco e Blob de teste). **Não dá para medir daqui**, e por isso **nada abaixo foi inventado**:

- **Internet real**: latência até a Vercel e o Neon, partida a frio da função, região das funções, o tempo que a CDN da Vercel leva para entregar (a compressão Brotli foi *simulada* por um proxy).
- **Aparelhos reais**: GPU, memória e térmica de celulares de entrada e de iPhones antigos. A CPU lenta é simulada e **não** reproduz o custo de composição na GPU (o ganho do desfoque tirado dos
  cartões foi medido em renderização por software e deve ser tratado como indicativo).
- **As fotos reais** da loja e o **vídeo da página inicial** (arquivo externo, bloqueado nos testes): usou-se um cardápio sintético (fotos geradas pelo caminho do painel) e, num teste à parte, um
  vídeo de teste de 5 MB só para provar que o mecanismo (esperar a foto, respeitar economia de dados e *reduzir movimento*) funciona.
- **Conexão antecipada com o Blob** (`preconnect`): o mecanismo foi testado (o endereço certo é aberto uma única vez, só para o Blob), mas o **ganho** só aparece com as fotos num endereço diferente do site, como em produção.
- **Lighthouse em produção** e **Core Web Vitals de campo**: só com o site no ar. O Lighthouse daqui é o de laboratório (rede simulada) sobre o site de teste.
- **Memória e CPU de aparelhos reais**: a memória (5.3) é a do Chromium no Linux; a de um celular de verdade varia, mas a proporção (fotos decodificadas 532 → 69 MB) é a mesma.
- **Safari/Firefox/iOS**: a foto adiantada usa `fetchpriority` e `rel=preload` com `media`; navegadores sem esses recursos ignoram e o site carrega como antes (testado só no Chromium).


## 9. O que o dono precisa fazer depois do deploy

1. **Publicar** (este trabalho **não foi enviado**: está num commit local na branch `claude/desempenho`, esperando a sua autorização; um deploy de produção aplica a migration `0025`, que só **acrescenta duas colunas opcionais**).
2. **Gerar as miniaturas**: *Produtos → Gerar miniaturas (N)* → confirmar → deixar a página aberta até "Miniaturas geradas" (~1 s por foto; se fechar, é só continuar depois). Veja o item 15 de
   [`OPERACAO.md`](OPERACAO.md#8-depois-de-cada-deploy-5-minutos).
3. **Conferir a região das funções da Vercel e a do Neon** (item 16 de `OPERACAO.md`). Mesma região (ou a mais próxima dos clientes) é o maior ganho que o código não consegue dar.
4. **Olhar o vídeo da página inicial** no CloudFront: se tiver mais de ~3 a 4 MB, comprimir (ou oferecer uma versão menor para celular).
5. **Depois de alguns dias no ar**: abrir o relatório *Core Web Vitals* do Google Search Console e comparar LCP, INP e CLS dos celulares com a meta (LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1).


## 10. Como medir de novo

Veja [`tests/perf/README.md`](../tests/perf/README.md): preparar o cardápio sintético, subir duas versões lado a lado e rodar as ferramentas. Em produção, as medições de
verdade são: **Lighthouse** do Chrome (aba *Lighthouse* do DevTools, modo celular, em janela anônima) sobre `/` e `/bebidas`, a aba *Rede* do DevTools (peso e quantidade de
requisições; as fotos da lista devem ter de 10 a 30 KB cada) e, com o tempo, o relatório **Core Web Vitals** do Google Search Console (dados de usuários reais).
