# Auditoria geral do COPO CHEIO — checklist e plano priorizado

Estado em 20/10/2026, depois das Etapas A a F. Legenda dos estados:

* **Aprovado** — implementado, validado no servidor/banco e coberto por teste automático que foi executado (resultados em `tests/README.md` e no relatório final).
* **Precisa de correção** — existe, mas há defeito ou lacuna conhecida que deve ser corrigida.
* **Parcialmente implementado** — o código existe, mas falta validação externa, configuração do proprietário ou parte do escopo.
* **Bloqueado** — depende de terceiros (credencial, serviço, decisão jurídica/fiscal) e não pode ser concluído só por código.
* **Não se aplica** — avaliado e deliberadamente não implementado, com o motivo.

> **Bateria completa executada em 20/10/2026** (PostgreSQL local, serviços externos simulados): verificação de tipos estrita (`tsc -b`, site e servidor) e build de produção sem erros; **292** testes unitários; **39** suítes de API (**3.505** verificações, 0 falhas); **27** arquivos de navegador (Chromium, celular e computador), todos aprovados; axe-core sem violações. Não há ESLint configurado no projeto (veja o item 42).

> "Aprovado" **não** significa "validado em produção": nada aqui foi testado contra a ValidaPay real, contra o Neon de produção ou com clientes reais. Os testes usam PostgreSQL local, ValidaPay/ViaCEP/Blob/e-mail **simulados**.

## 1. Site público

| # | Funcionalidade | Estado | Observações / onde |
| - | -------------- | ------ | ------------------ |
| 1 | Início (Hero, Contato, chamada final), rodapé | Aprovado | `src/App.tsx`; axe sem violações; `tap` de 44 px nos controles pequenos |
| 2 | Cardápio: busca, categorias, favoritos, ESGOTADO, banners | Aprovado | `api-test11`, `e2e`, `e2e-cover`, `e2e-slides` |
| 3 | Combos e escolha do gelo | Aprovado | regra no banco: `api-test13`, `api-test16`, `e2e-ice`, `e2e-combo` |
| 4 | Carrinho e checkout (taxa por bairro, pedido mínimo, troco, observações) | Aprovado | `api-test11`, `e2e` |
| 5 | Horário de funcionamento, pausa de pedidos, **feriados e horários especiais** | Aprovado | migration 0030; `api-test32`, `e2e-extras` |
| 6 | **Confirmação de maioridade (18+)** | **Parcialmente implementado** | Autodeclaração (janela de entrada + caixa no checkout) exigida **no banco**, mais conferência do documento na entrega, registrada. Não prova idade (ninguém prova pelo navegador) e **o texto precisa de validação jurídica** — `docs/JURIDICO-PENDENCIAS.md`. `api-test28`, `e2e-agegate` |
| 7 | **Cancelamento do pedido pelo cliente** | Aprovado | até a loja confirmar e sem dinheiro recebido; estoque devolvido uma vez; cancela a cobrança Pix na operadora (melhor esforço). `api-test28`, `e2e-agegate` |
| 8 | Acompanhamento por link/número | Aprovado | `api-test4`, `e2e-track` |
| 9 | Conta do cliente: cadastro com e-mail de **qualquer provedor**, login com código, recuperação de senha | Aprovado | `api-test5/7/23/26`, `e2e-account/verify/recover/logincode/providers` |
| 10 | **Cupons** e **entrega grátis por valor** | Aprovado | migration 0029; `api-test30`, `e2e-coupon` |
| 11 | **Agendamento** de entrega/retirada | Aprovado | migration 0030; desligado por padrão; `api-test32`, `e2e-extras` |
| 12 | **CEP** (ViaCEP pelo servidor) e **endereços extras** na conta | Aprovado | migration 0031; `api-test31/33`, `e2e-extras`. O ViaCEP real não foi chamado (servidor falso nos testes) |
| 13 | **Avaliações** dos pedidos | Aprovado | migration 0034; moderação obrigatória antes de ir ao site; `api-test34`, `e2e-reviews` |
| 13b | **Programa de pontos (fidelidade)** | **Aprovado (desligado por padrão)** | Migration 0035; **sem nenhum valor inventado**: o dono define pontos por R$ 1, pontos para trocar, valor e validade do cupom e só então liga. Crédito quando o pedido de **conta** é entregue (sobre os itens depois do desconto), estorno se o pagamento é devolvido, extrato só de acréscimo, troca atômica por **cupom pessoal** (usa o motor de cupons), acerto manual do owner com motivo. `api-test38`, `e2e-loyalty`. As regras do programa precisam de revisão jurídica/fiscal (`docs/JURIDICO-PENDENCIAS.md`) |
| 14 | **Entregadores** (essencial) | Aprovado | nome gravado no pedido; o cliente vê só o primeiro nome; `api-test34`, `e2e-reviews`. Sem app do entregador, rota ou rastreio por GPS (fora do escopo) |
| 15 | Termos, cancelamento/trocas, entrega, pagamento/reembolso, **contato e responsável** | **Parcialmente implementado** | Páginas separadas, texto editável pelo owner, "não revisado juridicamente" sinalizado. Os textos padrão **não** são parecer jurídico; CNPJ/razão social/endereço do responsável **não existem** até a loja preencher |
| 16 | Política de privacidade (LGPD) | **Parcialmente implementado** | Descreve o que o sistema faz (inclui CEP, avaliações, cupom, agendamento, medição opcional). Falta validação jurídica e o encarregado (DPO) da loja |
| 17 | Site instalável (PWA) | Aprovado | `public/sw.js` guarda **só** estático; verificado em navegador real (offline, sem cache de API). `e2e-site` |
| 18 | SEO: títulos, canônica, Open Graph, JSON-LD, `sitemap.xml`, `robots.txt` | Aprovado | `api-test12/36`. Falta cadastrar no Google Search Console (manual) |
| 19 | Medição de visitas (GA4) | **Parcialmente implementado** | Opcional, só com consentimento, sem dado pessoal; **precisa** do `GA_MEASUREMENT_ID` e de liberar o Google na CSP (decisão do proprietário). Não validado contra o Google real |
| 20 | Acessibilidade e alvos de toque (celular) | **Parcialmente implementado** | axe-core (WCAG 2.2 A/AA + boas práticas + regras experimentais) com **0 violações** em celular e computador, incluindo o Hero (nome do link da logo, região da vitrine, pontinhos de 24 px); alvos de toque de 44 px sem mudar o desenho (`e2e-site`). **Não testado** com leitor de tela real nem com zoom de 200 % |

## 2. Pagamentos

| # | Funcionalidade | Estado | Observações |
| - | -------------- | ------ | ----------- |
| 21 | Dinheiro, cartão na entrega, Pix com chave da loja | Aprovado | `api-test11` |
| 22 | **Pix online (ValidaPay)** | **Parcialmente implementado** | Adaptador completo e testado contra servidor falso baseado na documentação (`api-test14/15`). **Nunca falou com a ValidaPay de verdade.** Homologação no sandbox pendente (`docs/PAGAMENTO-ONLINE.md`) |
| 23 | **Cartão online** (migration 0020, tela `/pagar/`) | **Parcialmente implementado** | `api-test22`, `e2e-card` (SDK com chamadas interceptadas). Não validado em produção; fluxo de antifraude e Id Público dependem da conta real |
| 24 | Webhooks assinados, idempotentes, com confirmação na operadora | Aprovado | `api-test15/22`; assinatura HMAC, janela de 5 min, repetição e fora de ordem |
| 25 | **Cancelamento financeiro**: Pix vencido encerrado na operadora | Aprovado | `api-test35` (rotina automática: cobrança cancelada na operadora, 10 min de nova tentativa e então o pedido é cancelado e o estoque volta; Pix pago com aviso perdido é liberado, nunca cancelado) |
| 26 | **Reembolso pela API** | **Bloqueado (desligado por padrão)** | Implementado (migration 0028, `api-test29`), mas o escopo `wallet/write` da ValidaPay também autoriza saque/transferência; só liga com `VALIDAPAY_REFUNDS=on` depois de confirmar com a ValidaPay e testar no sandbox. O status manual "reembolsado" **não é** transação financeira |
| 27 | Nota fiscal (NFC-e) | **Bloqueado / Não se aplica** | Sem integração fiscal (nada no código). A API de notas da ValidaPay emite **somente NFS-e (serviço)**, que provavelmente não serve para venda de bebidas (mercadoria → NFC-e/NF-e). Depende do regime tributário e do contador. Requisitos e plano em `docs/FISCAL.md`; nada foi inventado ou ligado |

## 3. Painel

| # | Funcionalidade | Estado | Observações |
| - | -------------- | ------ | ----------- |
| 28 | Login com senha + código por e-mail + 2FA opcional, sessões, permissões owner/admin | Aprovado | `api-test10/24/25` |
| 29 | Pedidos ao vivo, status, histórico, impressão, conferência de maioridade | Aprovado | `e2e`, `api-test11/28` |
| 30 | Produtos, categorias, estoque (alerta de **estoque baixo configurável**, no painel **e por e-mail**), banners, site | Aprovado | `api-test11/33/37`, `e2e-extras` |
| 31 | Clientes, privacidade (LGPD) e anonimização | Aprovado | `api-test12` |
| 32 | **Exportação CSV** (pedidos, clientes, estoque) | Aprovado | só owner para dados pessoais; proteção contra fórmulas; `api-test31`, `tests/unit/csv.test.mjs` |
| 33 | E-mails e entregabilidade (painel, fila, promoções) | Aprovado | `api-test17-21`; domínio próprio/SPF/DKIM/DMARC dependem do proprietário (item 41) |
| 34 | Registro de atividades (auditoria) | Aprovado | inclui exportações, política, cupons, estorno, moderação |
| 35 | Estado do sistema (banco, imagens, e-mail, URL, **rotina automática**) | Aprovado | `e2e-reviews` |

## 4. Infraestrutura e qualidade

| # | Item | Estado | Observações |
| - | ---- | ------ | ----------- |
| 36 | **Tarefas agendadas** (Pix vencido, fila de e-mails, limpeza) | **Parcialmente implementado** | Cron diário na Vercel (limite do plano gratuito) + varredura de passagem + agendador externo opcional (`docs/OPERACAO.md`). Sem agendador externo, um Pix que vence à noite numa loja parada só é encerrado na próxima execução |
| 37 | Monitoramento | **Parcialmente implementado** | `/api/health` para monitor externo, logs JSON com `request_id`, relatório de CSP e de erros do navegador, estado da rotina no painel, **e-mail aos donos** quando a rotina automática falha/para ou o estoque fica baixo (`api-test37`), alertas de e-mail (entregabilidade) e falhas de pagamento sinalizadas no painel. **Não existe** alerta automático de queda do site nem de pico de erros: exige serviço externo |
| 38 | Proteção contra abuso (limites, isca, idempotência) | Aprovado | `docs/SEGURANCA.md` seção 8 |
| 39 | CAPTCHA | **Não se aplica (por ora)** | Decisão registrada com gatilho e opção (Turnstile) em `docs/SEGURANCA.md` seção 8 |
| 40 | Segurança geral | Aprovado | `docs/SEGURANCA.md`. Pendente: pentest independente; Tailwind 3→4 para zerar 5 alertas **só de desenvolvimento** |
| 41 | E-mail: SPF/DKIM/DMARC | **Bloqueado** | Exige domínio próprio; guia e verificador no painel (`docs/EMAIL-RELATORIO.md`). Estratégia preservada (SMTP Gmail para o administrador; provedor transacional para clientes) |
| 42 | Lint | **Precisa de correção (baixa prioridade)** | O projeto não tem configuração de ESLint; a conferência é `tsc` estrito (site e servidor) + testes. Introduzir lint é decisão de equipe (nova dependência) |
| 43 | README e documentação | Aprovado | README, `docs/OPERACAO.md`, `docs/SEGURANCA.md`, `docs/PWA-SEO-ANALYTICS.md`, `docs/JURIDICO-PENDENCIAS.md`, `tests/README.md` |

## 5. Itens avaliados e não implementados

| Item | Estado | Motivo e próximo passo |
| ---- | ------ | ---------------------- |
| **Notificações por WhatsApp/SMS** | **Bloqueado** | WhatsApp Business API e SMS são serviços **pagos** (e o WhatsApp exige modelos aprovados). Não foi adicionado serviço pago (regra do projeto). O aviso ao cliente é por e-mail (pedido recebido, confirmado, saiu, entregue, cancelado, pagamento) e o link de WhatsApp da loja continua |
| **Notificações push no navegador** | **Não se aplica** | Exigiria dependência nova, chaves VAPID e consentimento próprio; o benefício é pequeno diante do e-mail e do acompanhamento ao vivo |
| **App/rota/GPS do entregador** | **Não se aplica** | O essencial (quem leva, nome no pedido) está pronto. Rastreio exige app e coleta de localização (LGPD) |
| **Offline completo** | **Não se aplica** | Preço e estoque desatualizados seriam um defeito real |

## 6. Plano priorizado do que falta

**P0 — antes de divulgar / ligar pagamento online (depende do proprietário)**

1. Revisão jurídica dos textos de maioridade, termos, políticas e privacidade; preencher razão social/CNPJ/endereço do responsável (`docs/JURIDICO-PENDENCIAS.md`).
2. Implantação segura (migrations 0027–0035 num branch do Neon antes de produção; `docs/OPERACAO.md`, "Roteiro de implantação segura").
3. Marcar no painel quais produtos **não** são bebida alcoólica (item 17 do pós-deploy).
4. Cadastrar `CRON_SECRET`.

**P1 — para ligar o Pix/cartão online**

5. Homologar a ValidaPay no **sandbox** (roteiro em `docs/PAGAMENTO-ONLINE.md`): Pix, webhook assinado, vencimento, cartão, antifraude. Só depois, produção, acompanhando os primeiros pagamentos.
6. Confirmar com a ValidaPay o contrato de devolução e a permissão `wallet/write`; só então `VALIDAPAY_REFUNDS=on`.
7. Agendador externo para a rotina de vencimento (a cada 5–30 min), se for vender com Pix online.

**P2 — qualidade e operação**

8. Domínio próprio e SPF/DKIM/DMARC; teste dos e-mails no Gmail/Outlook reais (`docs/EMAIL-RELATORIO.md`).
9. Monitor de disponibilidade em `/api/health` e aviso de queda (serviço externo).
10. Teste manual de acessibilidade com leitor de tela e zoom; teste de velocidade num celular fraco real (`docs/DESEMPENHO.md`).
11. Search Console + sitemap; decidir sobre o GA4 (e a CSP).
12. Pentest independente.

**P3 — evolução**

13. NFC-e (após o contador), Tailwind 4, lint, CAPTCHA se houver abuso, revisão jurídica das regras do programa de pontos antes de ligá-lo.
