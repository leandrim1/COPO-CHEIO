# Site instalável (PWA), buscadores (SEO), medição de visitas e acessibilidade

O que existe no código, o que a loja precisa fazer para ligar e o que ficou de fora de propósito.

## 1. Site instalável (PWA)

| Arquivo | Para quê |
| --- | --- |
| `public/manifest.webmanifest` | Nome, cores, ícones (`/icon-192.png`, `/logo.png` 512×512) e `start_url`: o Chrome/Android oferece "Instalar app" e o iPhone "Adicionar à Tela de Início" (o ícone do iPhone é o `apple-touch-icon.png`). |
| `public/sw.js` | *Service worker* mínimo e seguro. Veja abaixo. |
| `public/offline.html` | Página simples de "Você está sem conexão", mostrada só quando a **navegação** falha por falta de rede. |
| `src/main.tsx` | Registra o service worker **somente em produção** e **não** sob automação de teste (`navigator.webdriver`). |

**O que o service worker guarda no aparelho:** apenas arquivos estáticos públicos — o JavaScript/CSS/imagens versionados em `/assets/`, as imagens do site (`/img/`, `/email/`, logo, gelo, ícones) e a página `offline.html`. No máximo 120 arquivos; os mais velhos saem primeiro; versões antigas do cache são apagadas ao ativar uma nova.

**O que ele NUNCA guarda:** nenhuma página (HTML), nenhuma resposta de `/api/*` (cardápio, preços, estoque, pedidos, conta, painel), nada de `/pedido`, `/acompanhar-pedido`, `/conta`, `/admin`, nenhuma requisição que não seja `GET`, nenhuma resposta com `Set-Cookie`. Tudo isso vai direto para a rede, como se o service worker não existisse — por isso **preço, estoque e status de pedido nunca aparecem velhos** e o checkout/login não mudam.

**Atualização:** `sw.js` e `manifest.webmanifest` são servidos com `Cache-Control: max-age=0, must-revalidate` (vercel.json). Para forçar a troca de todo o cache num dia, mude `CACHE = 'copocheio-static-v1'` em `public/sw.js`.

**Como validar depois do deploy (5 minutos):** Chrome → DevTools → Application → *Manifest* (sem erros, ícones carregando), *Service Workers* (ativo), depois *Network → Offline* e recarregue: aparece "Você está sem conexão"; volte a ficar online e o site volta ao normal. Lighthouse → *Installable* deve passar.

**Limitação:** não há modo offline do cardápio nem pedido offline (preço/estoque desatualizados seriam um problema real). Notificações push não existem.

## 2. Buscadores (SEO)

* **`/robots.txt`** e **`/sitemap.xml`** são gerados pelo servidor (`server/routes/seo.ts`, reescritas no `vercel.json`) porque o `Sitemap:` precisa do endereço completo do site — o mesmo `SITE_URL` (ou o domínio de produção da Vercel) que já vale para os e-mails. Sem endereço configurado o `robots.txt` sai sem a linha `Sitemap:` e o `sitemap.xml` responde 404.
* **O que entra no sitemap** (só páginas públicas e estáveis): `/`, `/bebidas`, `/privacidade`, `/termos`, `/trocas-e-cancelamentos`, `/entrega`, `/pagamento-e-reembolso`, `/contato-e-responsavel`. **Não entram:** checkout, pedido, acompanhamento, conta, pagamento, painel, `/api`. Produto não tem endereço próprio (o cardápio é uma página só), então não há uma URL por produto para listar.
* **Bloqueios no `robots.txt`:** `/api/`, `/pedido/`, `/acompanhar-pedido/`, `/conta`. O painel não é citado de propósito (para não anunciá-lo) e fica fora do Google por `X-Robots-Tag: noindex, nofollow` + `<meta name="robots">`; o mesmo vale para checkout, pedido, acompanhamento e conta.
* **Título, descrição, canônica, Open Graph e dados estruturados** por página: a Vercel manda robôs (Google, Bing, WhatsApp, Facebook…) para `/api/__page`, que devolve o mesmo site com o `<head>` já escrito (título/descrição vêm do painel → Site → SEO). Dados estruturados `schema.org/Store` (nome, telefone, endereço, horários) **só entram com o que a loja cadastrou** — nada é inventado. As páginas de termos e políticas têm título próprio e canônica; endereço inexistente responde **404 de verdade**.
* **Depois do deploy:** cadastre o site no Google Search Console e envie `https://SEU-SITE/sitemap.xml`. Não é possível fazer isso por código.

## 3. Medição de visitas (Google Analytics 4) — opcional, desligada por padrão

**Estado:** o código está pronto e coberto por teste unitário (`tests/unit/analytics.test.mjs`), mas **só funciona depois de dois passos manuais da loja** e **não foi validado contra o Google real** (não há como fazer isso daqui).

1. Na Vercel, cadastre **`GA_MEASUREMENT_ID`** = o identificador do fluxo web do GA4 (formato `G-XXXXXXXXXX`; não é segredo). Valor fora desse formato é ignorado. O servidor entrega o identificador ao site em `GET /api/site` (campo `analytics_id`).
2. **Libere o Google na política de segurança (CSP)** do `vercel.json` — hoje ela bloqueia qualquer script externo, e é por isso que o GA não carrega sozinho. No bloco `"source": "/(.*)"` (o primeiro de `headers`), acrescente:
   * `script-src 'self'` → `script-src 'self' https://www.googletagmanager.com`
   * `connect-src 'self'` → `connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com`
   * (`img-src` já aceita `https:`.)

   **Trade-off que o proprietário decide:** liberar um script externo enfraquece um pouco a proteção contra XSS (hoje nenhum domínio de terceiros pode executar código no site). O `gtag.js` do Google é de um domínio confiável e o identificador é fixo, mas a política deixa de ser "somente o próprio site". Sem este passo, com o identificador cadastrado, o aviso de medição aparece, mas o Google é bloqueado pelo navegador (aparece em `/api/csp-report`).

**Como funciona (LGPD):**

* Sem identificador: nada acontece — nenhum aviso, nenhum script, nenhuma conexão.
* Com identificador: aparece **um aviso curto** ("Aceitar" / "Recusar"). **Só depois do "Aceitar"** o script do Google é baixado. "Recusar", ou ignorar, = nenhuma conexão com o Google. A escolha fica no aparelho (`copocheio:analytics-v1`) e pode ser mudada a qualquer momento na **Política de privacidade → Medição de visitas** (recusar apaga os cookies `_ga*` e para o envio na hora).
* **O que é enviado:** a visita à página (só o *tipo* da página: `/pedido/ABC123` vira `/pedido`; `/conta/redefinir/<token>` vira `/conta`; o painel e a tela do cartão **nunca** são medidos), `begin_checkout` (valor dos itens) e `purchase` (valor total, número do pedido e forma de pagamento). Cada evento sai **uma vez** (não duplica por recarregar/voltar).
* **O que NÃO é enviado:** nome, telefone, e-mail, endereço, código de acompanhamento, dados de cartão/Pix, itens do pedido, CEP, observações. Sinais do Google e personalização de anúncios ficam desligados (`allow_google_signals: false`, `allow_ad_personalization_signals: false`).
* A **Política de privacidade** muda sozinha: diz "sem ferramentas de estatística de terceiros" quando a medição está desligada e descreve o Google Analytics (opt-in) quando está ligada.
* **Pendência jurídica:** o texto do aviso e a base legal (consentimento) precisam da validação do responsável jurídico (`docs/JURIDICO-PENDENCIAS.md`).

**Alternativa sem terceiros:** se a loja preferir não abrir a CSP, a opção é uma contagem própria (sem cookies) no servidor. Não foi implementada; é uma decisão do proprietário.

## 4. Acessibilidade e alvos de toque (mobile)

Auditoria automática (axe-core 4, regras WCAG 2.0/2.1/2.2 A e AA + boas práticas) em celular (390 px) e computador (1280 px), páginas: início, cardápio (com produtos), checkout, acompanhar pedido, conta, recuperar senha, privacidade e as quatro páginas de políticas.

* **Corrigido (sem mudar o visual):**
  * Hero: o nome acessível do link da logo agora **contém o texto visível** ("COPO CHEIO Disk Bebidas, página inicial", antes havia um travessão que quebrava a correspondência — regra `label-content-name-mismatch`, necessária para quem comanda o site por voz);
    a vitrine de bebidas virou uma **região com nome** ("Bebidas em destaque"; antes o conteúdo ficava fora de qualquer região); os **pontinhos do carrossel** passaram de 20 × 20 para 24 × 24 px (WCAG 2.2 · 2.5.8), compensando a posição para o desenho ficar no mesmo lugar.
  * Carrosséis de banners: pontinhos de 18 × 18 para 24 × 24 px, também na mesma posição.
  * Checkout: um `<p>` solto dentro de `<dl>` (a dica de "entrega grátis" saiu da lista).
  * Painel › Avaliações: o filtro passava da largura do celular (rolagem lateral); agora quebra a linha.
  * Resultado: **0 violações** (axe-core com WCAG 2.0/2.1/2.2 A e AA, boas práticas **e regras experimentais**) em `/` e `/bebidas` no celular (390 px) e no computador (1280 px).
* **Alvos de toque:** controles pequenos e isolados ganharam uma área de toque de 44 × 44 px **sem mudar o desenho** (classe `.tap` em `src/index.css`, um elemento invisível centrado no botão): pontinhos do carrossel, botões −/+ do pedido e da troca de energético, botão "Adicionar", links do rodapé, Instagram, "Login", "Início"/"Acompanhar pedido" do topo do cardápio e as categorias. O botão ⓘ do horário já tinha o mesmo recurso.
* **Não alterado (de propósito):** links dentro de frases (rodapé legal, "política de privacidade" no checkout) — a regra de tamanho de alvo do WCAG 2.2 (2.5.8) isenta links em texto corrido, e dar mais altura a eles mudaria a composição do texto.
* O que não dá para medir sem pessoas: leitura com leitor de tela real (NVDA/VoiceOver/TalkBack), contraste em todas as combinações de fotos enviadas pela loja e uso com zoom de 200 %. Recomenda-se um teste manual antes de divulgar.
