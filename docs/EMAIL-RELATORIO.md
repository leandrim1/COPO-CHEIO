# Relatório final: e-mails e entregabilidade da Copo Cheio

Data: 14/10/2026 · Branch de trabalho: `claude/copd-cheid-hero-section-ufzva2` · Migration nova: `0019_email_deliverability.sql`
**Nada foi publicado.** Publicar esta branch aplica a migration no banco de produção e faz o deploy; isso só acontece com a sua autorização (seção 9).

Documentos irmãos: a **auditoria** (foto de antes) está em [`EMAIL-AUDITORIA.md`](EMAIL-AUDITORIA.md); o **manual** (como tudo funciona, regras, painel, DNS, operação) está em [`EMAIL.md`](EMAIL.md).

## 1. Resumo

| O que você pediu | Situação |
| ---------------- | -------- |
| Enviar os e-mails por uma infraestrutura **autenticada** | **Parcial, e a parte que falta depende de você.** Todo e-mail sai por **um só caminho** e pelo SMTP que você já usa. Sem domínio próprio não existe SPF/DKIM/DMARC **da loja** para configurar; o que existe é a autenticação do próprio provedor (hoje, Gmail). O painel traz o verificador de DNS e o passo a passo para quando houver domínio. **Não verificado aqui:** o cabeçalho real de uma mensagem no Gmail/Outlook (seção 8) |
| **Registrar eventos confiáveis** | **Sim, até onde o transporte informa.** Cada mensagem tem registro (tipo, destinatário, data, estado, tentativas, código SMTP, `Message-ID`), sem corpo, código nem link. Com **SMTP** só se sabe “aceito” ou “recusado”; entrega, devolução posterior e spam aparecem como **“não informado”** (nunca estimados). Esses três só existem com o provedor opcional (Resend), que está pronto e **desligado** |
| **Detectar falhas** | **Sim.** 10 alertas em português (usuário/senha recusados, falhas de envio, endereços recusados, recusas por política, fila parada, teto diário, reclamações, devoluções, provedor sem avisos, remetente gratuito); os críticos também avisam o dono por e-mail, uma vez |
| **Melhorar continuamente** | **Sim.** Painel **E-mails** (visão geral, mensagens, promoções, supressões, autenticação), botão **Enviar exemplos para mim**, procedimento para conferir Gmail/Outlook, cada alerta traz “o que fazer” |
| Não remover funcionalidade nem trocar serviço sem justificar | **Cumprido.** O SMTP continua sendo o único transporte ligado; os 7 e-mails que já existiam saem pelo caminho novo **sem mudar o que a pessoa vê**; o provedor Resend é opcional e vem desligado |

**O que o sistema não sabe e não promete** (por limite de qualquer sistema, não por falta de trabalho): em qual pasta a mensagem caiu (Entrada, Promoções, Spam); se foi aberta ou clicada (de propósito, não medimos); se foi “entregue” ou “devolvida depois” quando o envio é por SMTP. “Aceito pelo servidor” nunca é chamado de “entregue”.

## 2. Suas decisões (respostas às quatro perguntas)

| Pergunta | Sua resposta | Como ficou |
| -------- | ------------ | ---------- |
| Provedor de envio | **Manter só o SMTP atual** | SMTP é o padrão e o único ligado. Adaptador Resend pronto, desligado (`EMAIL_PROVIDER=resend`), testado só contra um simulador |
| Domínio | **Ainda não tenho** | Nenhum registro de DNS foi inventado. Guia + verificador no painel; DMARC começa em `p=none` |
| E-mails de pedido para visitantes | **Sim, com travas** | 7 e-mails de pedido/pagamento, também para quem não tem conta, com as travas da seção 4 e um interruptor de segurança (`EMAIL_ORDER_NOTICES=off`) |
| Promoções | **Tudo agora** | Consentimento, descadastro de um clique (RFC 8058), página de preferências e campanhas pelo painel |

## 3. O que foi corrigido (achado por achado)

| Achado da auditoria | Situação | Onde |
| ------------------- | -------- | ---- |
| **E-01** sem rastreamento nenhum | **Corrigido**: registro por mensagem (tipo, destinatário, estado, tentativas, `Message-ID`), sem corpo/código/link | `email_messages`, `server/email/ledger.ts` |
| **E-02** SMTP não emite eventos | **Limite do SMTP, explicitado** no painel; avisos de entrega/devolução/spam só com provedor que informa (Resend opcional, webhook assinado) | `server/email/webhooks.ts`, `svix.ts`, `resend.ts` |
| **E-03** sem domínio autenticado | **Pendente (depende de você)**: guia, verificador de SPF/DKIM/DMARC, nenhum valor inventado | `server/email/dns.ts`, painel → Autenticação, seção 7 |
| **E-04** sem fila nem nova tentativa | **Corrigido**: espera crescente 2 min → 10 min → 1 h → 4 h → 12 h (±10%); avisos de segurança deixam de se perder | `server/email/service.ts`, `errors.ts` |
| **E-05** sem teto global | **Corrigido**: teto diário (`EMAIL_DAILY_LIMIT`, 450 no Gmail), parte para promoções; **código de login nunca espera** | `server/email/config.ts`, `service.ts` |
| **E-06** sem e-mail de pedido/pagamento | **Corrigido**: 7 tipos, enfileirados por gatilhos do banco, uma vez por etapa | migration 0019, `server/email/templates.ts`, `render.ts` |
| **E-07** sem consentimento nem descadastro | **Corrigido**: caixa desmarcada, vale só depois de provar a caixa de e-mail, descadastro de um clique, preferências, política de privacidade atualizada | `server/email/preferences.ts`, `src/site/EmailPreferences.tsx` |
| **E-08** abuso contra terceiros | **Mitigado**: tetos por endereço, lista de supressão, domínio conferido, link “não quero e-mails de pedidos”, interruptor de pausa | `service.ts`, `kinds.ts` |
| **E-09** sem correlação nos logs | **Corrigido**: `Message-ID` = `<id do registro@domínio do remetente>`; o log segue sem endereço, código ou link | `server/email/transport.ts` |
| **E-10** cabeçalhos | **Corrigido**: transacional leva `Auto-Submitted`; promoção leva `List-Unsubscribe` + `List-Unsubscribe-Post` (e **não** leva `Auto-Submitted`); `MAIL_REPLY_TO` opcional | `service.ts` (`headersFor`) |
| **E-11** assunto com código | **Preservado e protegido**: o registro guarda só o nome do tipo para e-mails com segredo | `kinds.ts` (`sensitive`) |
| **E-12** links no domínio da Vercel | **Pendente (depende de domínio)**: use `SITE_URL` com o domínio próprio | `server/mailBrand.ts` |
| **E-13** sem agendador | **Mitigado**: a fila anda por atividade e por um cron **diário** (limite do plano gratuito da Vercel) | `vercel.json`, `server/routes/emailpublic.ts` |
| **E-14** segredos | **Mantido**: nenhum segredo versionado; chaves só no servidor; webhook assinado; o painel mostra só **nomes** de variáveis | seção 11 |

## 4. O que o sistema faz agora

- **Um só caminho de saída** (`deliver()` em `server/email/service.ts`): classifica o tipo (transacional × promocional, com ou sem segredo), confere as regras, registra, envia e anota o resultado. Os 7 e-mails que já existiam (confirmação, “você já tem conta”, nova senha, senha alterada, link gerado pela loja, novo acesso ao painel, e-mail de teste) foram migrados **sem mudar o comportamento visível**.
- **Segredo nunca é guardado:** código de confirmação, link de nova senha e e-mail de teste são enviados na hora, uma vez; o registro guarda só o nome do tipo. O registro **nunca** impede um código de login (se o banco falhar, o e-mail sai mesmo assim).
- **Fila com nova tentativa** para o que pode esperar (pedido, pagamento, avisos de segurança, promoções, alertas). Erro de usuário/senha espera 1 hora e abre alerta; endereço inexistente (`5.1.x`) não repete e entra na lista de supressão; recusa por política (`5.7.x`) não repete e **não** suprime o endereço.
- **Pedido e pagamento:** gatilhos no banco enfileiram um e-mail por etapa (`order:<id>:<tipo>`), sem duplicar, e um erro do gatilho nunca derruba o pedido. E-mail que ficou velho (o pedido já passou da etapa) é cancelado em vez de sair fora de hora. Pedido pago pelo site recebe só “pagamento confirmado”.
- **Travas para visitantes:** o e-mail digitado no pedido pode não ser de quem pediu. Por isso: domínio conferido (existe, não é descartável, recebe e-mail), tetos por endereço (4 por tipo, 12 no grupo pedido, 40 no total em 24 h), lista de supressão, link “não quero e-mails de pedidos neste endereço” no fim de cada mensagem, e o e-mail traz só o necessário (itens, valores, **bairro**; nunca telefone, endereço completo, troco ou observações).
- **Promoções:** só para cliente ativo, com e-mail confirmado, que aceitou; o dono confirma o **número exato** de destinatários; teto diário próprio; descadastro de um clique; remetente de e-mail gratuito exige aceitar o risco; assunto/botão/encurtador são validados no servidor.
- **Webhook do provedor (opcional):** só vale aviso **assinado** (Svix: `svix-id`, `svix-timestamp`, `svix-signature`, HMAC-SHA256, ±5 min, comparação em tempo constante), lido por inteiro antes de gravar, uma vez por `svix-id`, fora de ordem não faz a mensagem “voltar atrás”. Sem `RESEND_WEBHOOK_SECRET` a rota nem existe (404).
- **Interruptor de segurança:** `EMAIL_ORDER_NOTICES=off` na Vercel **pausa só** os e-mails de pedido e pagamento (código de login, nova senha, avisos de segurança e promoções seguem normais). O que chegar durante a pausa fica registrado como “bloqueado: pausado” e não sai depois.
- **Painel *E-mails*:** Visão geral, Mensagens (com linha do tempo e atalhos a partir de Clientes e do pedido), Promoções, Supressões e Autenticação (verificador de DNS e o botão **Enviar exemplos para mim**). Qualquer administrador consulta; só o **owner** age, e tudo entra no histórico de atividades. Nunca aparecem senha, código, link de senha nem corpo de e-mail.

## 5. Arquivos

**Banco** (só acrescenta; nenhuma tabela existente muda de forma): `db/migrations/0019_email_deliverability.sql`: 7 tabelas novas (`email_messages`, `email_events`, `email_suppressions`, `email_preferences`, `email_campaigns`, `email_alerts`, `email_webhook_state`), 8 funções novas (`email_norm`, `email_status_rank`, `email_apply_event`, `email_claim_due`, `email_forget`, `email_order_recipient`, `email_enqueue_order_status`, `email_enqueue_order_payment`), 2 gatilhos (`order_status_history_email`, `orders_payment_email`) e versões novas de `anonymize_person` e `purge_expired_data` (iguais às antigas para tudo o que já existia, mais as tabelas novas; retenção de 180 dias).

**Servidor, serviço central** (`server/email/`, novos): `service.ts` (entrega, fila, tentativas), `kinds.ts` (tipos e tetos), `ledger.ts` (registro), `render.ts` e `templates.ts` (monta o e-mail), `config.ts`, `errors.ts` (classifica respostas SMTP), `transport.ts` e `resend.ts` (transportes), `webhooks.ts` e `svix.ts` (avisos assinados), `preferences.ts` (consentimento e descadastro), `stats.ts`, `alerts.ts` e `alertText.ts` (painel e alertas), `dns.ts` (SPF/DKIM/DMARC), `types.ts`.

**Servidor, rotas:** novas `server/routes/emailadmin.ts` (painel) e `server/routes/emailpublic.ts` (cron, webhook, preferências, descadastro de um clique); alteradas `server/index.ts`, `server/mail.ts`, `server/mailLayout.ts`, `server/mailTemplates.ts`, `server/verification.ts`, `server/passwordReset.ts`, `server/adminAccess.ts`, `server/routes/{account,customers,mailadmin,orders,payments,tracking}.ts`.

**Front-end:** novos `src/admin/Emails.tsx`, `src/admin/emails/{Overview,Messages,Campaigns,Suppressions,Authentication}.tsx`, `src/admin/emails/labels.ts`, `src/site/EmailPreferences.tsx`, `src/site/accountUi.tsx`; alterados `src/App.tsx`, `src/admin/{AdminApp,Customers,Orders}.tsx`, `src/lib/types.ts`, `src/site/{Account,CustomerPages,Privacy}.tsx`.

**Configuração:** `vercel.json` (cron diário `/api/cron/email`), `package.json` e `package-lock.json` (`@vercel/functions`, para a fila rodar em segundo plano sem atrasar a resposta).

**Testes:** `tests/api-test17..21.mjs`, `tests/e2e-emails.cjs`, `tests/unit/email-{core,deliverability,templates}.test.mjs`, `tests/mailsink.mjs` (SMTP de mentira com falhas realistas), `tests/dnsmock.mjs`, e ajustes em `tests/{lib.mjs,server.mjs,run-api.sh,run-e2e.sh,api-test14.mjs,api-test16.mjs}` e `tests/README.md`.

**Documentação:** `docs/EMAIL-AUDITORIA.md`, `docs/EMAIL.md`, `docs/EMAIL-RELATORIO.md` (este), e ajustes em `README.md` e `docs/OPERACAO.md`.

## 6. Variáveis de ambiente

Todas ficam **só no servidor** (Vercel → Settings → Environment Variables; marque senhas e chaves como *Sensitive*). Nada vai para o navegador nem para o Git.

| Variável | Para quê | Obrigatória |
| -------- | -------- | ----------- |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | o SMTP que você já usa (no Gmail: `smtp.gmail.com`, o Gmail da loja e a **senha de app**) | sim (já existem) |
| `SMTP_PORT`, `SMTP_SECURE`, `MAIL_FROM` | porta, TLS e remetente (`Copo Cheio <loja@seudominio.com.br>`) | não |
| `SITE_URL` | endereço do site nos links e na logo dos e-mails | recomendada |
| **`CRON_SECRET`** | texto aleatório de 16+ caracteres que **liga o cron diário** (a Vercel o manda como `Authorization: Bearer …`; a rota recusa tudo sem ele) | **recomendada (nova)** |
| `EMAIL_DAILY_LIMIT` | teto de e-mails aceitos em 24 h (`0` = sem teto). Padrão: 450 com Gmail | não (nova) |
| `EMAIL_PROMO_DAILY_LIMIT` | parte desse teto para promoções. Padrão: 40% do teto, ou 300 sem teto | não (nova) |
| `MAIL_REPLY_TO` | endereço de resposta (`Reply-To`) | não (nova) |
| `EMAIL_ORDER_NOTICES` | `off` pausa os e-mails de pedido e pagamento | não (nova) |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | só se um dia você usar o Resend pela API (`EMAIL_PROVIDER=resend`) | não (novas) |

`RESEND_API_URL` existe só para os testes e é **ignorada em produção**.

## 7. DNS

**Hoje, sem domínio próprio, não há nada a configurar no DNS.** O remetente é uma conta Gmail: SPF, DKIM e DMARC são do Google, não seus. Nenhum registro foi inventado neste trabalho.

**Quando você tiver um domínio** (por exemplo, registrado no Registro.br), os registros são estes. Os **valores** vêm de quem fornece o serviço, nunca de mim:

| Registro | Onde criar | De onde vem o valor |
| -------- | ---------- | ------------------- |
| **SPF** (um único TXT por domínio) | DNS do domínio | **copie do painel do provedor de e-mail** (Google Workspace, Brevo, SES, Resend, Zoho…) |
| **DKIM** (CNAME ou TXT, nome e valor exatos) | DNS do domínio | **copie do painel do provedor**; o nome da chave muda de provedor para provedor |
| **DMARC** (TXT em `_dmarc.seudominio.com.br`) | DNS do domínio | modelo para começar só monitorando: `v=DMARC1; p=none; rua=mailto:um-endereco-seu@seudominio.com.br`. `p=none` não bloqueia nada. Depois de algumas semanas sem e-mails legítimos reprovados, **você** decide se endurece (`quarantine`, depois `reject`) |
| Site na Vercel (A/CNAME do domínio) | DNS do domínio | **os valores que a Vercel mostrar** em *Settings → Domains* |

Depois: `MAIL_FROM` com o domínio autenticado, `SITE_URL`, novo deploy, e **E-mails → Autenticação → Verificar agora** (o verificador só lê o DNS público; não cria nada).

## 8. O que depende de você ou do provedor (em ordem)

**Agora, sem domínio:**
1. **Autorizar a publicação** (seção 9). Sem isso nada disto vai ao ar.
2. Na Vercel, cadastrar **`CRON_SECRET`** (texto aleatório longo, *Sensitive*) para ligar o cron diário.
3. Conferir `SMTP_*`, `MAIL_FROM` e `SITE_URL`.
4. Depois do deploy: **E-mails → Autenticação → Enviar exemplos para mim** (7 e-mails “[Teste]” no seu e-mail), abrir no **Gmail → Mostrar original** e anotar **SPF/DKIM/DMARC** e a **pasta**; repetir no **Outlook.com** (cabeçalho `Authentication-Results`). Isso é o que eu **não consigo verificar daqui**. O procedimento e a tabela para anotar estão no manual, seção 8.
5. Conferir **E-mails → Visão geral**: sem alertas abertos, “Aceitas pelo servidor” subindo, fila vazia.
6. Decidir sobre o **link de acompanhamento** nos e-mails de pedido de visitantes (seção 11, risco 3).
7. Evitar promoções em volume pelo Gmail pessoal (limite diário e risco de bloqueio da conta). Para poucas dezenas de clientes, funciona com o aviso do painel.

**Quando tiver domínio:** registrar o domínio e apontá-lo para a Vercel; escolher como enviar (e-mail do próprio domínio pelo SMTP, serviço de envio por SMTP, ou Resend pela API); criar SPF/DKIM com os valores do provedor; DMARC `p=none`; `MAIL_FROM`, `SITE_URL`, novo deploy; Verificar agora; exemplos de novo no Gmail e no Outlook; (recomendado) **Google Postmaster Tools** para acompanhar a reputação. Se escolher o Resend: criar a conta, verificar o domínio, criar a chave só de envio e o webhook (eventos de entrega, atraso, devolução e reclamação), cadastrar `RESEND_API_KEY` e `RESEND_WEBHOOK_SECRET`, `EMAIL_PROVIDER=resend`, e **fazer um envio e um aviso reais no ambiente de teste do Resend antes de confiar** (seção 11, risco 4).

## 9. Publicação

- **O que acontece ao publicar:** a Vercel roda `vercel-build`, que aplica a migration **0019** no banco de produção (só em deploys de produção) e faz o deploy do site.
- **A migration só acrescenta:** tabelas, funções e gatilhos novos. Nenhuma tabela existente muda de forma. As duas funções existentes que são trocadas (`anonymize_person`, `purge_expired_data`) ficam iguais para tudo o que já existia. Foi exercitada em um banco com o formato antigo (api-test16): ela não gera e-mails retroativos de pedidos antigos.
- **Gatilhos nos pedidos:** a partir do deploy, cada mudança de etapa do pedido e cada pagamento marcado como pago/reembolsado passa a enfileirar um e-mail. **Isso vai para clientes reais.** Se algo parecer estranho, pause com `EMAIL_ORDER_NOTICES=off` (seção 6) e faça um novo deploy.
- **Desfazer sem apagar dados:** além do interruptor, os dois gatilhos podem ser removidos com `drop trigger order_status_history_email on order_status_history; drop trigger orders_payment_email on orders;` (as tabelas novas ficam, inofensivas).
- **Sem backup** foi a sua escolha nas migrations anteriores; esta é maior (tabelas e gatilhos novos). Um backup/branch do Neon antes do deploy continua sendo a forma mais barata de desfazer tudo. Cabe a você decidir.

## 10. Testes executados e resultados

Rodados em 14/10/2026 sobre o código final desta branch, com PostgreSQL 16 local, servidor SMTP de mentira, DNS de mentira e simulador do provedor: **nenhum e-mail real foi enviado, nenhum domínio real foi consultado e nenhum dado de produção foi tocado.**

| Camada | Como rodar | Resultado |
| ------ | ---------- | --------- |
| Tipos | `npm run typecheck` | sem erros |
| Unitários | `npm run test:unit` | **191 passam, 0 falham** (72 são de e-mail: 20 de classificação de respostas SMTP, tipos e configuração; 33 de assinatura Svix, DNS e alertas; 19 de compatibilidade dos templates) |
| Build | `npm run build` | ok |
| API | `bash tests/run-api.sh` | **22 suítes, 2.045 checagens, 0 falhas** |
| Navegador | `E2E_RETRIES=1 bash tests/run-e2e.sh` | **13 arquivos, todos passam** (veja a nota abaixo) |
| Dependências | `npm audit --omit=dev` | 0 vulnerabilidades |

**Suítes de e-mail (todas novas, 14/10/2026):** `api-test17` 59 · `api-test18` 87 · `api-test19` 99 · `api-test20` 68 · `api-test21` 51 (provedor opcional contra simulador) · `e2e-emails` 83 (celular e computador) · unitários `email-core`, `email-deliverability`, `email-templates`. As suítes que já existiam (`api-test` a `api-test16`, `e2e*`) continuam passando; só duas receberam ajustes de texto e de verificação da migration 0019 (`api-test14`, `api-test16`).

**Onde cada exigência do pedido é provada**

| Exigência | Prova |
| --------- | ----- |
| Cadastro e verificação de e-mail | `api-test5`, `api-test5-modes`, `api-test17` §1 e §6, `e2e-verify`, `e2e-emails` §1 |
| Login e redefinição de senha | `api-test7`, `api-test17` §6 (o registro nunca atrapalha o código de login), `e2e-recover` |
| Confirmação de pedido e de pagamento | `api-test18` §1 a §4 (recebido, confirmado, saiu, entregue, cancelado) |
| Envio duplicado | `api-test18` §2 e §5 (uma mensagem por etapa), `api-test19` (uma por pessoa e campanha), `api-test21` (chave de idempotência) |
| Falha temporária do provedor | `api-test17` §4 e §5, `api-test18` §6 (o pedido não é afetado; o aviso espera e sai) |
| Endereço inválido e devolução | `api-test17` §3 (`550 5.1.1` suprime e não repete), `api-test18` §7 (domínio e tetos), `api-test21` (devolução por aviso assinado) |
| Autenticação do webhook | `api-test21` (sem assinatura, assinatura errada, hora antiga, aviso repetido, fora de ordem) e o **exemplo oficial da Svix** em `email-deliverability` |
| Proteção de credenciais | `api-test17` §6 (código, link e corpo fora do registro), `api-test21` §2 (a chave do provedor só vai no cabeçalho do envio ao provedor), `api-test5-modes` e `e2e-mail-off` (o painel lista só os **nomes** das variáveis que faltam) |
| Celular | `e2e-emails` (390 px, sem rolagem horizontal em todas as abas e na lista de exemplos) |
| Compatibilidade dos templates | `email-templates` (tabelas, estilos inline, sem script/formulário/pixel, só https, texto igual ao HTML, tamanho, escape de dados) e `api-test6` |
| Interruptor, exemplos, descadastro por `GET`, teto geral sem testes | `api-test18` §11, `api-test20` §5, `api-test19` §4 e §7 |

**Nota sobre os testes de navegador.** Em duas baterias o teste principal `e2e` (que não é de e-mail) falhou de forma intermitente no passo "sessão revogada": o painel pergunta ao servidor se a sessão vale a cada 8 s, e o clique do teste caía quase junto com essa pergunta (instrumentei o teste e confirmei o horário). O produto se comporta certo nos dois casos (o servidor manda o dono para o login). O `e2e-ice` falhou uma vez por depender de uma animação de 200 ms sob carga. Corrigi os dois passos para não dependerem desse tempo (`tests/e2e.cjs`, `tests/e2e-ice.cjs`) sem enfraquecer o que provam; depois disso a bateria completa passou de primeira e o `e2e` passou mais 3 vezes seguidas isoladamente.

**O que os testes não provam:** chegada em caixa de entrada real, pasta (Entrada, Promoções, Spam), SPF/DKIM/DMARC reais do seu domínio, comportamento de cada leitor de e-mail com o layout, e o Resend contra o serviço de verdade. Isso depende do procedimento manual (seção 8).

## 11. Pendências, limites e riscos conhecidos

1. **SMTP não informa entrega, devolução posterior nem spam.** O painel diz “não informado”. Devoluções do Gmail chegam como e-mail na caixa da loja (“Mail Delivery Subsystem”), que o sistema **não lê**: se o endereço não existe, coloque-o em **Supressões**.
2. **Sem domínio próprio** não há SPF/DKIM/DMARC da loja; o remetente aparece como uma conta pessoal, com limite diário (~500; o sistema usa 450) e risco de bloqueio em promoções em volume.
3. **O link de acompanhamento nos e-mails de pedido** abre a mesma página que o cliente vê depois de pedir (nome, endereço de entrega e observações). Se o cliente digitar por engano o e-mail de **outra pessoa que existe**, ela poderia ver esses dados. É o desenho comum de “acompanhe seu pedido”, o risco é baixo (o domínio é conferido e e-mail errado quase sempre nem existe), mas existe. O caminho mais restrito (e-mail de pedido **sem** o botão para quem não tem conta) é uma mudança pequena em `server/email/render.ts` (`trackingUrl`); decida se quer.
4. **Resend não foi exercitado contra o serviço real.** O formato exato dos avisos e das mensagens de erro foi implementado a partir da documentação pública e testado contra um **simulador**; a assinatura Svix foi conferida com o **exemplo oficial** da documentação da Svix. Teste em ambiente de testes do Resend antes de depender disso.
5. **Fila sem agendador:** anda por atividade (pedidos, painel aberto) e por um cron **diário** (limite do plano gratuito da Vercel). Sem tráfego, uma nova tentativa pode esperar até o cron.
6. **Entrega “pelo menos uma vez”:** se a função da Vercel for interrompida no meio de um envio SMTP, a mensagem pode ser reenviada depois de 5 minutos. Com o Resend, a chave de idempotência evita a duplicata.
7. **Abertura e clique não são medidos** (decisão de privacidade e reputação). **Pasta de destino** é desconhecida por qualquer sistema.
8. **Um único remetente** (`MAIL_FROM`) para tudo; separar conta/pedido de promoções em subdomínios diferentes exigiria um segundo remetente (não implementado).
9. **Campanhas não têm agendamento de data/hora** (o envio começa quando o dono confirma).
10. **Não é testável aqui:** chegada em caixa real, pasta de destino, SPF/DKIM/DMARC reais do seu domínio e o comportamento de cada leitor de e-mail com o layout. Tudo isso está no procedimento manual (manual, seção 8).

**Segurança conferida:** nenhuma chave, senha ou token em arquivo versionado (busca no diff e nos arquivos novos); `npm audit --omit=dev` sem vulnerabilidades; chaves só no servidor; o painel mostra só **nomes** de variáveis; webhook sem segredo cadastrado nem existe (404) e, com segredo, só aceita aviso assinado e recente.
