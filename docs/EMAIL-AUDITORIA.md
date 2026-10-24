# Auditoria dos e-mails do COPO CHEIO (etapa 1 de 6 — somente leitura)

> **Status (implementado depois desta auditoria).** O que está abaixo é a **foto de antes** (14/10/2026). O resultado da implementação, com as regras, as variáveis, o DNS, os testes e as
> pendências, está em **[`EMAIL.md`](EMAIL.md)**. Decisões do dono que moldaram o plano: **manter só o SMTP atual** (o provedor Resend ficou pronto, **desligado**, para quando houver domínio),
> **ainda não há domínio próprio**, e-mails de pedido também para **visitantes (com travas)** e **promoções completas** (consentimento, descadastro de um clique, campanhas pelo painel).
>
> | Achado | Situação |
> | ------ | -------- |
> | E-01 sem rastreamento | **Corrigido**: cada mensagem tem registro (tipo, destinatário, estado, tentativas, `Message-ID`), sem corpo/código/link |
> | E-02 SMTP não emite eventos | **Limite do SMTP, explicitado**: o painel mostra "não informado" para entrega/devolução/spam; só o provedor opcional (Resend, ainda não testado contra o serviço real) avisa |
> | E-03 sem domínio próprio autenticado | **Pendente (depende de você)**: guia de DNS e verificador no painel; DMARC começa em `p=none`; nenhum registro foi inventado |
> | E-04 sem fila nem nova tentativa | **Corrigido**: fila com espera crescente (2 min → 12 h); avisos de segurança não se perdem mais |
> | E-05 sem teto global de envio | **Corrigido**: teto diário (`EMAIL_DAILY_LIMIT`, padrão 450 no Gmail), promoções com parte própria; código de login nunca espera |
> | E-06 sem e-mail de pedido/pagamento | **Corrigido**: 7 tipos, enfileirados pelo banco, sem duplicar |
> | E-07 sem consentimento nem descadastro | **Corrigido**: caixa desmarcada, vale após confirmar o e-mail, descadastro de um clique (RFC 8058), preferências, texto da política atualizado |
> | E-08 abuso contra terceiros | **Mitigado**: tetos por endereço (4/tipo, 12 no pedido, 2 promoções, 40 no total), supressão, domínio conferido, link "não quero e-mails de pedidos neste endereço" |
> | E-09 sem correlação nos logs | **Corrigido**: o `Message-ID` é o id do registro (`<id@domínio>`); o log continua sem endereço, código ou link |
> | E-10 cabeçalhos | **Corrigido**: transacional leva `Auto-Submitted`; promoção leva `List-Unsubscribe` + `List-Unsubscribe-Post`; `MAIL_REPLY_TO` opcional |
> | E-11 assunto com código | **Preservado e protegido**: o registro guarda só o nome do tipo para e-mails com segredo |
> | E-12 links no domínio da Vercel | **Pendente (depende de domínio)**: use `SITE_URL` com o domínio próprio quando houver |
> | E-13 sem agendador | **Mitigado**: fila anda por atividade e por um cron **diário** (`CRON_SECRET`); limite do plano Hobby |
> | E-14 segredos | **Mantido**: nenhum segredo versionado; chaves só no servidor; webhooks assinados |


Data: 14/10/2026 · Escopo: tudo o que envia, valida, registra ou depende de e-mail no projeto. **Nada do sistema foi alterado nesta etapa**; este
arquivo é o único acréscimo. O que não dá para ver daqui (valores das variáveis na Vercel, DNS do seu domínio, logs de produção) está marcado
como **"não verificável"** e vira pergunta ou tarefa para você no fim.

## 1. Como o envio funciona hoje

| Peça | Onde | O que faz |
| ---- | ---- | --------- |
| Envio | `server/mail.ts` | `sendMail()` usa **SMTP comum via `nodemailer`** (um envio por chamada, sem conexão guardada, tempos curtos de 5/5/7 s por causa do limite da função na Vercel). Variáveis: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (+ `SMTP_PORT`, `SMTP_SECURE`, `MAIL_FROM`). **Não há provedor fixo no código** |
| Provedor realmente usado | Vercel → Environment Variables | **Não verificável.** A documentação (`README.md`, "Configurar o envio") indica como caminho mais simples uma conta **Gmail** com senha de app, "sem domínio próprio"; o código também aceita Brevo, Resend (`smtp.resend.com`), SES, SendGrid etc. |
| Remetente | `MAIL_FROM` ou `Copo Cheio <SMTP_USER>` | Com Gmail, o remetente é o próprio `@gmail.com` |
| Endereço do site nos links | `server/mailBrand.ts` (`SITE_URL`) | Sem `SITE_URL`, usa o domínio de produção da Vercel (o endereço de produção usado até aqui é `copocheio-nu.vercel.app`, citado em `tests/README.md`). Nunca vem do cabeçalho da requisição (bom) |
| Layout | `server/mailLayout.ts`, `server/mailTemplates.ts` | UM layout (tabelas, estilos inline, botão VML para Outlook, modo escuro, texto simples gerado junto, preheader). Sem pixel de rastreamento |
| Login/conta do cliente | `server/routes/account.ts`, `server/verification.ts`, `server/passwordReset.ts` | E-mail + senha (scrypt); conta nasce `pending_verification`; só vale depois de provar a caixa de e-mail (código de 6 dígitos com HMAC + link de 256 bits); recuperação por link de uso único |
| Login do painel | `server/adminAccess.ts`, `server/routes/session.ts` | Senha + código do aplicativo (2FA opcional); aviso por e-mail quando entra de um aparelho novo |
| Estado no painel | `server/routes/mailadmin.ts`, `src/admin/Customers.tsx` | Diz se está configurado (só nomes de variáveis, nunca valores) e permite o e-mail de teste (owner) |
| Proteções de domínio | `server/mailDomain.ts`, `server/emailAddress.ts`, `server/disposableDomains.ts` | Formato, normalização, domínio descartável/reservado, MX/A/AAAA (só recusa quando a inexistência é **confirmada**) |
| Testes | `tests/mailsink.mjs`, `tests/dnsmock.mjs`, `api-test5/5-modes/6/7`, `e2e-verify/recover/mail-off` | SMTP de mentira + DNS simulado: dá para provar toda a lógica local sem provedor real |

### Os 7 e-mails que o sistema envia hoje

| # | E-mail | Quando | Falha de envio vira… |
| - | ------ | ------ | -------------------- |
| 1 | Código + link de confirmação | cadastro, reenvio, login de conta pendente | erro claro para a pessoa (400 destino recusado / 503 tente de novo); o código novo é descartado |
| 2 | "Você já tem uma conta" | alguém tenta cadastrar um e-mail que já tem conta | **silêncio** (de propósito: não revelar quem tem conta) |
| 3 | Link de redefinição de senha | "Esqueci minha senha" | resposta igual para todo mundo; o link novo é descartado |
| 4 | "Sua senha foi alterada" | senha trocada pelo link | **perdido em silêncio** (só `console.error`) |
| 5 | "Novo acesso ao painel" | admin entra de aparelho novo | **perdido em silêncio** |
| 6 | "A loja gerou um link de nova senha" | owner gera link no painel | resposta do painel diz `notified: false` |
| 7 | Confirmação de teste | owner no painel | erro com o motivo |

### O que NÃO existe hoje (e o pedido cita)

Confirmação de pedido, mudança de status, pagamento confirmado, entrega, cancelamento/reembolso, notificação de pedido novo para a loja,
cupons, campanhas e promoções, **consentimento e descadastro**. O checkout já pede um **e-mail opcional** (`src/site/Checkout.tsx`, grava em
`orders.customer_email`), mas hoje ele só serve para vincular o pedido a uma conta: nenhuma mensagem é enviada para ele.

## 2. Achados

Gravidade pelo efeito na entrega/segurança, não pelo esforço de corrigir.

| ID | Gravidade | Achado | Evidência |
| -- | --------- | ------ | --------- |
| E-01 | **Alta** | **Nenhum rastreamento.** `sendMail()` devolve `void`: não há identificador de mensagem, registro de destinatário/tipo/resultado nem histórico. "Aceito pelo SMTP" é tudo o que se sabe; entregue, devolvido, spam, aberto e clicado são invisíveis | `server/mail.ts:64-105`; só existe `email_verifications.sent_at` (migration 0005) |
| E-02 | **Alta** | **SMTP puro não emite eventos.** Devolução (bounce) assíncrona, reclamação de spam e entrega não chegam ao sistema; o endereço ruim continua recebendo tentativas (só os limites por conta/IP seguram) | `server/mail.ts` (não há webhook, não há lista de supressão) |
| E-03 | **Alta** | **Provavelmente sem domínio próprio autenticado.** O site está em `*.vercel.app` (DNS que você não controla) e o remetente sugerido é `@gmail.com`. Sem domínio seu não há SPF/DKIM/DMARC **da loja**; o Gmail pessoal tem teto diário de envio, reputação compartilhada e pode barrar automação. **Não verificável** o que está configurado hoje | `README.md:361-383`, `tests/README.md:95` |
| E-04 | Média | **Sem fila nem nova tentativa.** Falha transitória (timeout, 4xx, limite do provedor) vira erro na hora ou **perda silenciosa** dos avisos de segurança (#4, #5) | `server/passwordReset.ts:69-77`, `server/adminAccess.ts:60-72` |
| E-05 | Média | **Sem teto global de envio** (por dia/minuto do provedor). Só existem limites por IP e por conta; estourar o limite do provedor derruba **também** os códigos de login, sem aviso prévio | `server/verification.ts:56-58` |
| E-06 | Média | **Lacuna funcional:** nenhum e-mail de pedido/pagamento/entrega/cancelamento, embora o e-mail do cliente já seja coletado | `src/site/Checkout.tsx:439`, `server/routes/orders.ts` |
| E-07 | Média | **Sem consentimento nem descadastro** e sem separação formal transacional × promocional. A política de privacidade não cita e-mail promocional | busca por `consent/unsubscribe/marketing`: nada |
| E-08 | Média | **Abuso por terceiros:** o aviso "você já tem conta" (#2) e o código de confirmação (#1) podem ser provocados por qualquer pessoa para o e-mail de uma vítima (hoje: 1 aviso/hora e até 10 códigos/dia por endereço). Sem teto **por destinatário** entre todos os tipos e sem supressão após reclamação | `server/verification.ts:100-111`, `0005:107-111` |
| E-09 | Baixa | **Sem identificador de correlação** no log; o `console.error` registra só código/comando/motivo mascarado (**bom** por não vazar endereço, mas não dá para ligar uma falha a um envio) | `server/mail.ts:92-93` |
| E-10 | Baixa | **Cabeçalhos mínimos:** só `Auto-Submitted` e `X-Auto-Response-Suppress` (adequados a transacionais). Sem `Reply-To`, sem marca de mensagem. Quando houver promocional, **não** pode usá-los e precisa de `List-Unsubscribe` + `List-Unsubscribe-Post` | `server/mail.ts:87` |
| E-11 | Baixa | O **assunto do e-mail de código contém o código** (prática comum para códigos). Um registro futuro de envios **não pode guardar o assunto** desses e-mails, nem corpo nem links | `server/mailTemplates.ts:34` |
| E-12 | Baixa | Links e logo apontam para o domínio da Vercel; para reputação, o ideal é o mesmo domínio (ou subdomínio) do remetente | `server/mailBrand.ts:61` |
| E-13 | Info | Não há agendador (cron). O projeto usava o padrão "de passagem" (`sweep`, do módulo de pagamentos online, hoje retirado). Na Vercel **Hobby** o cron só roda 1×/dia | docs da Vercel (abaixo) |
| E-14 | Info | Variáveis só no servidor; `.gitignore` protege `.env*`; **nenhum segredo versionado** (busca no código e no histórico); `/api/health` público só diz "de pé"; o painel mostra só **nomes** das variáveis que faltam; o log mascara endereços | `git grep` limpo; `server/index.ts:48-65` |

## 3. O que já está bom e será preservado

Anti-enumeração (respostas iguais + tempo mínimo), código com HMAC e "pepper", 15 min de validade, 5 tentativas, espera de 60 s entre envios, 5/h e
10/dia por conta, 15 e-mails/h por IP, cookie secreto contra pré-sequestro de cadastro, normalização do e-mail, bloqueio de domínios descartáveis
(sem barrar apelidos legítimos), HTML responsivo com modo escuro e texto simples, nenhum pixel de rastreamento nos e-mails de conta (continua
assim: **abertura e clique só serão medidos em e-mails promocionais**, nunca em códigos/senhas).

## 4. O que os provedores de caixa de entrada exigem (consultado em 14/10/2026)

Resumo conferido em fontes públicas (a página oficial do Google não abriu neste ambiente; os números abaixo vêm de resumos de terceiros que
citam as regras e **devem ser confirmados** nas páginas oficiais antes de decisões finais):

- **Gmail/Google:** regras valem desde fev/2024, com fiscalização mais firme a partir de nov/2025. **Todos** os remetentes: SPF ou DKIM, TLS,
  DNS reverso válido, formato RFC 5322 e taxa de reclamação de spam baixa (meta **< 0,10%**, nunca **≥ 0,30%**). **Remetente em massa**
  (≥ 5.000 mensagens/dia para contas pessoais Google): SPF **e** DKIM com alinhamento ao domínio do "From", DMARC publicado (pode ser `p=none`) e
  **descadastro com um clique** (RFC 8058) em mensagens promocionais, atendido em até 2 dias.
- **Outlook.com/Hotmail/Live (Microsoft):** desde **05/05/2025**, remetentes de alto volume (≥ 5.000 mensagens/dia para os serviços de e-mail
  pessoais da Microsoft com o mesmo domínio no "From") precisam de SPF e DKIM **passando** e DMARC publicado; o descumprimento vai primeiro para
  **Lixo** e pode virar rejeição (`550 5.7.515`). A página oficial da Microsoft trata o envio para o lixo antes da rejeição.
- **Para uma loja pequena** (bem abaixo de 5.000/dia) esses limites formais não obrigam, mas SPF + DKIM + DMARC alinhados continuam sendo o que
  mais pesa para cair na **Caixa de entrada** e não em Spam/Promoções.
- **Limites do Gmail como remetente:** contas pessoais têm teto diário (fontes citam ~500 destinatários/dia) e o Google Workspace 2.000/dia
  por usuário; o Google pode mudar esses limites sem aviso.
- **Nenhum provedor garante pasta.** Promoções/Spam dependem de reputação, conteúdo e comportamento dos destinatários. O que o sistema pode fazer
  é cumprir os requisitos, medir (entrega, devolução, reclamação) e corrigir.

## 5. Plano de implementação (etapas 2 a 6)

Princípios: **nada é removido** (o SMTP atual continua funcionando como está, e é o padrão se nada novo for configurado); falha do novo
registro **nunca** impede o envio de um código de login; segredo, código e link **nunca** vão para o registro.

1. **Banco (migration 0019, só acrescenta):** `email_messages` (registro de cada mensagem: id, tipo, categoria transacional/promocional, destinatário,
   status, id no provedor, tentativas, motivos), `email_events` (eventos dos webhooks, um por id do provedor), `email_suppressions` (hard bounce,
   reclamação, manual), `email_preferences` (consentimento e descadastro de marketing), `email_alerts`; funções SQL atômicas; retenção na limpeza
   automática e anonimização (LGPD).
2. **Serviço central `server/email/`:** um só ponto de saída (`deliver()`): classifica o tipo, confere supressão/consentimento/tetos, registra, envia
   por um **transporte** (SMTP atual ou API do provedor), trata erro e agenda nova tentativa com espera crescente (só para mensagens que podem ser
   guardadas sem segredo; código/link de senha continuam síncronos). Os 7 e-mails atuais migram para ele **sem mudar o comportamento visível**.
3. **Provedor com eventos:** adaptador **Resend** (API de envio com `Idempotency-Key` + webhook assinado no padrão Svix: `svix-id`,
   `svix-timestamp`, `svix-signature`, HMAC-SHA256, tolerância de 5 min), mais a interface para outros provedores. **Justificativa:** o SMTP não
   emite eventos; sem um provedor com webhooks não existe "entregue/devolvido/spam" confiável. O SMTP continua disponível.
4. **Webhooks autenticados e idempotentes** (`POST /api/email/webhook/resend`): assinatura conferida **antes** de gravar qualquer coisa, evento
   repetido não repete efeito, hard bounce e reclamação suprimem o endereço, soft bounce repetido também.
5. **Painel "E-mails e Entregabilidade":** totais, taxa de entrega, devolvidos, rejeitados, reclamações, histórico por cliente/tipo/período,
   status dos webhooks, **alertas** (taxas acima de limites conservadores, falhas de autenticação/configuração, teto de envio) e o
   **verificador de DNS** (SPF, DKIM, DMARC lidos do DNS real; sem inventar registro). Só administradores logados; ações sensíveis só o owner.
6. **Novos e-mails:** pedido recebido, status do pedido, pagamento confirmado, entrega, cancelamento/reembolso (transacionais, com teto por
   destinatário e sem duplicar), aviso de alerta para o owner, e **promocional** com consentimento (caixa desmarcada por padrão), página de
   preferências, `List-Unsubscribe`/`List-Unsubscribe-Post` e envio de campanha em lotes pelo painel.
7. **Testes:** unitários (assinatura com o **vetor de teste oficial do Svix**, classificação, DNS, fila), API (cadastro/verificação, senha, pedidos,
   duplicidade, falha temporária, endereço inválido/bounce, webhook sem/errado assinatura, proteção de credenciais), navegador (painel no
   celular) e **procedimento passo a passo para Gmail/Outlook reais** (ler SPF/DKIM/DMARC em "Mostrar original").
8. **Relatório final:** arquivos, variáveis, registros DNS (gerados a partir do que o provedor mostrar — **não inventados**), pendências.

**Impacto alto (por isso confirmo antes de publicar):** uma migration nova no banco de produção, mexida nos 7 pontos de envio de conta/login,
uma rota pública nova (webhook) e novas variáveis de ambiente (opcionais).

## 6. O que depende de você (detalhado no relatório final)

1. Um **domínio próprio** (ex.: `copocheio.com.br`, registrado em registro.br ou similar) e acesso ao DNS dele; apontá-lo para o projeto da Vercel e
   definir `SITE_URL`.
2. **Conta no provedor de envio** (recomendado: Resend), adicionar o domínio e **copiar os registros DNS que o próprio provedor mostrar**
   (SPF/MX do subdomínio de envio e DKIM) + o DMARC que eu indicar (`p=none` no início).
3. Criar a **chave de API** (só envio) e o **segredo do webhook** no painel do provedor e cadastrá-los na Vercel como *Sensitive*.
4. (Opcional, recomendado) Verificar o domínio no **Google Postmaster Tools** e enviar testes reais para Gmail e Outlook.

## 7. Limites do que se pode prometer

- Resposta de sucesso (HTTP 200 / "250 OK") **não** prova entrega. O sistema distingue: *enviado pelo sistema → aceito pelo provedor → entregue ao
  servidor do destinatário → aberto → clicado → spam (só com evidência: reclamação reportada)*.
- Abertura é pouco confiável (bloqueio de imagens, proteção de privacidade da Apple/Gmail): só aparece como **indício** e só em promocionais.
- Nenhum sistema sabe em qual **pasta** a mensagem caiu. Só dá para medir entrega, devolução e reclamação e seguir as boas práticas.

## Fontes consultadas (14/10/2026)

- Google — requisitos para remetentes (resumos): <https://redsift.com/blog/gmails-enforcement-ramps-up-what-bulk-senders-need-to-know>, <https://bird.com/explained/deliverability/what-are-the-gmail-and-yahoo-bulk-sender-requirements>
- Google — limites de envio do Workspace: <https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace>
- Microsoft — remetentes de alto volume (Outlook.com): <https://support.microsoft.com/outlook/fix-ndr-error-550-5-7-515-in-outlook-com>, <https://substrate.office.com/ip-domain-management-snds/postmaster/Policies>
- Resend — verificação de webhooks: <https://resend.com/docs/webhooks/verify-webhooks-requests>; tentativas: <https://resend.com/docs/webhooks/retries-and-replays>; chaves de idempotência: <https://resend.com/docs/dashboard/emails/idempotency-keys>; domínios: <https://resend.com/docs/dashboard/domains>; rastreamento: <https://resend.com/docs/dashboard/domains/tracking>
- Svix — verificação manual (vetor de teste): <https://docs.svix.com/receiving/verifying-payloads/how-manual>
- RFC 8058 (descadastro com um clique): <https://www.rfc-editor.org/rfc/rfc8058>
- Vercel — cron jobs: <https://vercel.com/docs/cron-jobs/usage-and-pricing>
