# E-mails da Copo Cheio: envio, registro, entregabilidade e promoções

Este é o manual do sistema de e-mails. A auditoria que deu origem a ele está em [`EMAIL-AUDITORIA.md`](EMAIL-AUDITORIA.md); o layout visual dos e-mails
e a confirmação de conta estão no [`README.md`](../README.md#confirmação-do-e-mail-contas-de-clientes).

**Em uma frase:** todo e-mail do sistema sai por **um só caminho** (`deliver()`), que confere as regras de proteção, **registra** a mensagem (sem corpo,
código nem link), envia, trata falhas com nova tentativa e mostra tudo no painel **E-mails** — dizendo com franqueza o que sabe e o que **não** sabe.

## 1. O que o sistema consegue e o que não consegue saber

| Pergunta | Com SMTP comum (Gmail, Brevo, SES…) | Com o provedor opcional (Resend, API + avisos) |
| -------- | ----------------------------------- | ---------------------------------------------- |
| O servidor de e-mail **aceitou** a mensagem? | Sim (resposta do envio) | Sim (resposta da API) |
| O endereço foi **recusado na hora** (caixa inexistente, política)? | Sim, com o código SMTP (`550 5.1.1`…) | Sim |
| A mensagem foi **entregue** ao servidor do destinatário? | **Não informado** | Sim, por aviso assinado (webhook) |
| Foi **devolvida depois** (bounce)? | **Não informado** | Sim |
| O destinatário marcou como **spam**? | **Não informado** | Sim |
| Foi **aberta** / houve **clique**? | **Não medimos** | **Não medimos** (rastreio desligado de propósito) |
| Em qual **pasta** caiu (Entrada, Promoções, Spam)? | **Ninguém sabe** | **Ninguém sabe** |

Regras que o painel e os relatórios seguem:

- “Aceito pelo servidor” **nunca** é chamado de “entregue”. HTTP 200 / `250 OK` não prova que chegou na caixa de entrada.
- Números que o transporte não informa aparecem como **“não informado”**; nunca são estimados.
- Abertura e clique **não são medidos**: o pixel de rastreio e o redirecionador de links pioram a reputação e a privacidade, e os provedores de caixa de
  entrada já escondem esse dado. Os links dos e-mails vão direto ao site.
- Para saber a pasta onde um e-mail caiu, só abrindo uma mensagem real no Gmail e no Outlook (procedimento na seção 8).

## 2. Como um e-mail sai

```
rota / gatilho do banco ──► deliver() ──► regras ──► registro (email_messages) ──► transporte (SMTP ou API) ──► resultado no registro
                                              │                                          │
                                  bloqueada (suprimido, sem consentimento,       falhou temporariamente? ──► fila com espera crescente
                                  teto por endereço, domínio inválido...)
```

- **Tipos** (`server/email/kinds.ts`): cada tipo diz se é **transacional** (conta/pedido) ou **promocional**, se leva **segredo**, se é **síncrono** (tentado
  uma vez, na hora) ou **enfileirável**, e os tetos por endereço.
- **Segredo nunca é guardado.** Confirmação de e-mail (código), link de nova senha e e-mail de teste são **síncronos**: a mensagem pronta vive só na
  memória, o registro guarda apenas o **nome do tipo** no lugar do assunto, e se o envio falha a pessoa pede outro. Nada de corpo, código ou link no banco.
- **Enfileiráveis** (pedido, pagamento, avisos de segurança, promoções, alertas) guardam só uma **receita** (ids; nunca nome ou endereço de entrega): a
  mensagem é montada na hora de enviar, a partir dos dados de então. A receita é apagada quando a mensagem termina.
- **Falha do registro não bloqueia o código de login**: se o banco falhar ao registrar, o e-mail do código sai mesmo assim (testado).
- **Pedido e pagamento** enfileiram pelo **banco** (gatilhos em `order_status_history` e `orders.payment_status`, migration 0019): nenhuma rota precisa
  se lembrar de avisar. Uma mensagem por etapa por pedido (`order:<id>:<tipo>`), sem duplicar; erro do gatilho nunca derruba o pedido. Pedido pago pelo
  site recebe só “pagamento confirmado” (um e-mail, não dois).
- **E-mail que ficou velho não sai**: se o servidor de e-mail ficou fora e, quando volta, o pedido já passou da etapa, a mensagem é **cancelada** em vez de
  enviada fora de hora.

### Tipos de e-mail

| Tipo | Categoria | Modo | Segredo | Teto por endereço em 24 h |
| ---- | --------- | ---- | ------- | ------------------------- |
| Confirmação de e-mail (código) | transacional | síncrono | sim | 12 |
| Código para entrar na conta (a cada login) | transacional | síncrono | sim | 25 |
| Código de acesso ao painel (a cada login de administrador; equipe) | transacional (equipe) | síncrono | sim | 25 |
| Redefinição de senha (link) | transacional | síncrono | sim | 12 |
| E-mail de teste do painel / teste de campanha / exemplo de modelo (botão “Enviar exemplos para mim”) | transacional (equipe); o teste de campanha leva os cabeçalhos de promoção | síncrono | — | 10 / 20 / 30 |
| Aviso: você já tem uma conta | transacional | fila | não | 3 |
| Aviso: senha alterada · a loja gerou link de nova senha | transacional | fila | não | 5 |
| Aviso: novo acesso ao painel (equipe) | transacional | fila | não | 10 |
| Pedido recebido · confirmado · saiu para entrega · entregue · cancelado · pagamento confirmado · reembolso | transacional | fila | não | 4 de cada, **12 no grupo “pedido”** |
| Alerta de entregabilidade (dono) | transacional (equipe) | fila | não | 3 |
| Aviso da operação: estoque baixo/esgotado e rotina automática com problema (dono; `server/opsAlerts.ts`) | transacional (equipe) | fila | não | 3 |
| Campanha promocional | **promocional** | fila | não | **2** |

Teto geral de último recurso: **40 mensagens por endereço em 24 h**, somando todos os tipos. Os **testes do painel** (e-mail de teste, teste de campanha e exemplos) vão sempre para o
e-mail de quem pediu, têm teto próprio e **não entram nessa soma**: alguns cliques em “Enviar exemplos” não podem bloquear os avisos de verdade.

### Espera entre tentativas

Quando o servidor de e-mail falha por motivo **temporário** (rede, `4xx`, caixa cheia `5.2.2`), a mensagem enfileirável volta para a fila:
**2 min → 10 min → 1 h → 4 h → 12 h** (±10%, para a fila não acordar tudo junto). Erro de **usuário/senha ou configuração** espera **1 hora** (não adianta
insistir) e abre alerta. Recusa **definitiva** (`5.1.x` endereço inexistente) **não** repete e coloca o endereço na lista de supressão. Recusa por
**política** (`5.7.x`: spam, autenticação do remetente) não repete e **não** suprime o endereço (o problema é do remetente, não da caixa).

### Quando a fila anda

Não há agendador. A fila é processada “de passagem”, sem fazer ninguém esperar: depois de qualquer mudança em **pedido ou pagamento**, com o **painel
aberto** (a cada ≥ 10 s), quando o cliente consulta o pedido (a cada ≥ 15 s), uma vez por dia pelo **cron da Vercel** (`/api/cron/email`) e no botão
**Processar fila agora** (owner). Um processamento por vez por instância; o banco garante que duas instâncias nunca peguem a mesma mensagem (`for update skip
locked`, com concessão de 5 minutos para o caso de a função morrer no meio).

## 3. Proteções (o que o sistema barra antes de enviar)

| Proteção | O que faz | Aparece no painel como |
| -------- | --------- | ---------------------- |
| **Lista de supressão** | endereço recusado de vez, que reclamou de spam, ou colocado pelo owner: nada mais é enviado a ele, de nenhum tipo | “Bloqueado: endereço na lista de supressão” |
| **Consentimento** | promoção só para cliente **ativo, com e-mail confirmado e que aceitou** | “Sem consentimento” |
| **Preferência de pedidos** | quem pediu “não quero e-mails de pedidos neste endereço” (link no fim de cada e-mail) não recebe os avisos seguintes | “Pediu para não receber e-mails de pedidos” |
| **Interruptor dos e-mails de pedido** | `EMAIL_ORDER_NOTICES=off` na Vercel pausa **só** os e-mails de pedido e pagamento (para o caso de algo estranho aparecer); o que chegar durante a pausa fica registrado e **não** sai depois | “Bloqueado: avisos de pedido pausados pela loja” |
| **Domínio do endereço** | e-mail digitado num pedido (que ninguém confirmou) com domínio inexistente, descartável ou sem MX não é tentado | “Domínio inexistente, descartável…” |
| **Teto por endereço** | 4 por tipo, 12 no grupo pedido, 2 promoções, 40 no total, a cada 24 h | “Teto por endereço atingido” |
| **Teto diário do provedor** | `EMAIL_DAILY_LIMIT` (padrão **450** com Gmail, sem teto nos demais); promoções usam só `EMAIL_PROMO_DAILY_LIMIT` (padrão 40% do teto, ou 300): o que não cabe **espera sem gastar tentativa** | “Esperando o teto diário” |

O **teto diário nunca segura um código de login** (o cliente está esperando na tela): só pedidos, avisos e promoções esperam.

**E-mail de pedido para visitante (sem conta):** o endereço digitado pode não ser de quem pediu. Por isso o e-mail de pedido traz só o necessário (número, itens,
valores, **bairro**, forma de pagamento e o link de acompanhamento — nunca telefone, endereço completo, troco ou observações), passa pelas proteções acima e termina
com o link **“Não quero e-mails sobre pedidos neste endereço”**.

> **Limite que você precisa conhecer:** o **link de acompanhamento** do e-mail abre a mesma página que o cliente vê depois de pedir, e essa página mostra nome, endereço de entrega e
> observações do pedido. Se o cliente digitar por engano o e-mail de **outra pessoa que existe**, essa pessoa poderia abrir o link e ver esses dados. É o mesmo desenho de qualquer loja
> que manda “acompanhe seu pedido” por e-mail, e o risco é baixo (e-mail digitado errado quase sempre nem existe, e o domínio é conferido), mas ele existe. Se preferir o caminho mais
> restrito (e-mail de pedido **sem** o botão de acompanhamento para quem não tem conta), é uma mudança pequena em `server/email/render.ts` (`trackingUrl`).

## 4. Login, códigos de verificação e senhas

Já eram sólidos (README, “Confirmação do e-mail”) e foram **preservados**: código de 6 dígitos gerado no servidor (`crypto.randomInt`), vale 15 minutos na confirmação do cadastro (e **5 minutos** no código de login), uso único, 5
erros inutilizam o código, guardado só como HMAC; link de 256 bits (só o hash no banco); reenvio a cada 60 s, 5/h e 10/dia por conta; mensagens iguais para qualquer
e-mail (não revela quem tem conta); cadastro preso ao navegador; nenhum segredo em log. O que mudou:

- o envio passa pelo serviço central: fica **registrado** (sem o código) e **medido**;
- o aviso de segurança que antes se perdia em silêncio (“senha alterada”, “novo acesso ao painel”) agora **espera na fila e tenta de novo**;
- código e link de senha **nunca** vão para a fila nem para o registro.

### 4.1 E-mail de qualquer provedor (e como investigar quando um provedor não recebe)

**O que o cadastro e o login exigem do endereço**, e nada além disso:

| Camada | O que barra | O que **não** barra |
| ------ | ----------- | ------------------- |
| Formato (`server/emailAddress.ts`) | texto que não é um endereço (sem `@`, espaços, pontos duplicados, IP no lugar do domínio, domínio sem ponto ou com `_`) | qualquer domínio bem formado: `gmail.com`, `icloud.com`, `outlook.com.br`, `empresa.com.br`, `.edu.br`, `.gov.br`, domínio novo comprido (`.technology`), domínio com acento (vira *punycode* igual na internet), `+etiqueta`, maiúsculas |
| E-mail temporário (`server/disposableDomains.ts`) | serviços de caixa que some em minutos (mailinator etc.); os apelidos de privacidade (Hide My Email, SimpleLogin, addy.io, Firefox Relay) estão liberados | todo provedor de verdade, conhecido ou não |
| DNS (`server/mailDomain.ts`) | domínio que **comprovadamente** não existe ou que declara não receber e-mail (MX nulo) | qualquer domínio com MX, ou só com A/AAAA (regra do protocolo); falha, lentidão ou DNS fora do ar **deixam passar** (a prova de verdade é o código) |
| Confirmação | conta que não prova que lê a caixa | — |

Não há (nem deve haver) lista de domínios permitidos. A tela de cadastro e a de login dizem que **qualquer provedor serve** e o campo de e-mail desliga a maiúscula e a
autocorreção dos celulares. A dica *"Você quis dizer maria@gmail.com?"* (`src/site/emailHint.ts`) é só uma sugestão para erro de digitação; o endereço digitado vale se a pessoa ignorar.

**O que mudou nesta versão**

- **Código de login: 5 minutos** (era 10). A confirmação do cadastro continua com 15 minutos (e link de 24 h), porque o e-mail de quem acabou de abrir uma conta pode demorar mais.
- **Endereço que já foi recusado um dia não fica trancado.** Antes, uma única devolução definitiva (`hard_bounce`) punha o endereço na lista de supressão **para sempre**, e a
  lista barra todos os tipos de e-mail, inclusive o código que a própria pessoa pediu: o cliente nunca mais conseguia criar a conta nem entrar, mesmo depois de a caixa ser
  consertada. Agora **código e link pedidos pela própria pessoa** (confirmar e-mail, entrar, nova senha, entrar no painel; `survivesAutoSuppression` em `server/email/kinds.ts`)
  passam por cima de uma supressão **automática** antiga (devolução definitiva ou repetida): se o servidor do destinatário ainda recusar, o erro aparece na hora; se aceitar e a pessoa
  digitar o código (ou abrir o link), a supressão automática é **apagada**. Continuam valendo: o **bloqueio manual** do owner, a supressão para promoções e avisos, e os tetos por endereço.
- **"Corrigir ou trocar o e-mail"** na tela do código devolve o endereço digitado, selecionado, para a pessoa consertar o erro de digitação.
- Mensagens de erro sem exemplo de provedor (nada de "use Gmail, Outlook ou Yahoo").

**Remetente × destinatário.** O remetente é a conta que a loja usa para enviar (hoje o **Gmail da loja pelo SMTP**: `SMTP_*`); o destinatário é o endereço de qualquer cliente. Não existe
integração com **Google Apps Script** neste projeto (se um dia for criada, é um transporte novo em `server/email/transport.ts`, ao lado do SMTP e do Resend opcional). Dois
fatos valem para o Gmail como remetente, por SMTP ou por Apps Script:

1. **O Gmail aceita a mensagem e só depois tenta entregar.** O SMTP responde "aceito" mesmo quando o servidor do destinatário recusa depois (caixa inexistente, bloqueio de spam). A
   recusa chega como e-mail **“Mail Delivery Subsystem / Delivery Status Notification”** na caixa do Gmail da loja. O sistema registra **"aceito pelo servidor"**, nunca "entregue", e a
   tela do cliente nunca promete entrega: diz que o e-mail pode demorar e manda olhar spam, lixo eletrônico e promoções.
2. **Limites de envio.** O Gmail pessoal permite cerca de 500 envios por dia (o sistema usa 450 como teto, `EMAIL_DAILY_LIMIT`; ao passar do limite o Gmail devolve `550 5.4.5`). No Apps Script, a
   cota por dia é bem menor em conta pessoal: **100 destinatários** em `MailApp` (1.500 em Google Workspace), segundo a
   [documentação de cotas do Apps Script](https://developers.google.com/apps-script/guides/services/quotas). Cada cadastro gasta 1 e-mail de código e cada entrada outro, mais os de pedido:
   com bastante movimento, uma conta Gmail pessoal fica apertada; o caminho é um provedor transacional (veja a seção 9) ou o Gmail de um Google Workspace.

**Roteiro para "o cliente do provedor X não recebe o código"** (nesta ordem; só a última mexe no código):

1. **Painel → E-mails → Mensagens**: busque o endereço. *Falhou* mostra o código do servidor (`550 5.1.1` = caixa não existe: erro de digitação; `5.7.x` = o provedor recusou por política, spam ou
   autenticação do remetente). *Bloqueado* mostra o motivo. *Aceito* = o servidor de e-mail da loja entregou ao provedor (próximo passo).
2. **Painel → E-mails → visão geral → "Principais domínios de destino"** (por provedor): um provedor só com falhas ou só com "aceito" e reclamação de clientes aponta o problema por provedor.
3. Abra a caixa **do Gmail da loja** e procure por *Mail Delivery Subsystem*: o texto da devolução diz a causa exata (endereço inexistente, caixa cheia, mensagem recusada como spam).
4. Peça ao cliente para olhar **spam / lixo eletrônico / promoções** (Gmail), **Lixo eletrônico** (Outlook, iCloud) e **a pasta "Outros"** do Outlook, e para conferir o endereço (tela *"Corrigir ou trocar o e-mail"*).
5. **Painel → E-mails → Autenticação → "Enviar exemplos para mim"** para uma conta sua no mesmo provedor: abra "Mostrar original" (Gmail) ou os cabeçalhos e confira **SPF, DKIM e DMARC = PASS** (seção 8).
   Com o Gmail como remetente os três são do próprio Gmail; com um domínio próprio, é preciso configurá-los.
6. Se o limite diário do Gmail foi atingido (alerta de teto), os códigos continuam saindo até o teto de segurança; espere 24 h ou use um provedor transacional.
7. Só depois, se tudo isso estiver certo e **só um provedor** continuar recusando, investigue o conteúdo do e-mail (assunto, links) e a reputação do remetente. Não crie lista de provedores permitidos nem desligue a
   confirmação: o código é a prova de que a pessoa lê a caixa.

## 5. Promoções, consentimento e descadastro

- **Consentimento:** a caixa “Quero receber novidades e promoções…” vem **desmarcada**. Marcá-la no cadastro é só um **pedido pendente**: vira consentimento
  quando a pessoa usa o **código ou o link** do e-mail de confirmação (que cita a escolha). Assim ninguém consegue ligar as promoções do e-mail de outra pessoa,
  nem cadastrando de novo um e-mail que já tem conta. O link de nova senha **não** confirma consentimento. Fica registrado: data, origem (`cadastro`, `conta`,
  `link`) e versão do texto (`v1`). Se mudar o texto da caixa, troque `CONSENT_TEXT_VERSION` em `server/email/preferences.ts`.
- **Quem recebe:** só cliente ativo, e-mail confirmado, `marketing = true`, fora da lista de supressão. O painel mostra o número exato e o **owner confirma esse
  número** antes de enviar (se a lista mudou, o servidor recusa com o número novo).
- **Descadastro com um clique (RFC 8058):** toda promoção leva `List-Unsubscribe: <https://…/api/email/unsubscribe/<chave>>` e `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click`; o Gmail/Yahoo mostram “Cancelar inscrição” e fazem um `POST` sem login nem cookie (quem abre esse endereço num navegador, com `GET`, é levado à página de preferências e **nada muda**: programas de segurança “abrem” links sozinhos). O rodapé também leva o link da página de
  **preferências** (`/conta/emails/<chave>`), onde dá para cancelar as promoções e/ou os avisos de pedido. A chave tem 128 bits aleatórios guardados no banco: não
  depende de variável de ambiente, então links antigos continuam valendo.
- **Só promoções param.** Código, nova senha e avisos de pedido são transacionais: cancelar as promoções **não** bloqueia nenhum deles.
- **Reclamação de spam** (só quando o provedor avisa) suprime o endereço e desliga as promoções automaticamente.
- **Enviar uma campanha** (owner): *E-mails → Promoções → Nova campanha* → **Enviar teste para mim** (chega marcado “[Teste]”, só para o dono) → **Enviar para a lista**
  (confirma o número). O envio é em fila, respeitando o teto diário de promoções; quem se descadastra no meio não recebe o resto; dá para **parar** a qualquer momento.
  O envio continua sozinho enquanto a página está aberta (o painel “empurra” a fila) e também a cada pedido e uma vez por dia (cron).
- **Conteúdo:** o servidor recusa assunto com “Re:/Fwd:”, assunto todo em maiúsculas, botão que não seja `https`, botão com encurtador de link (bit.ly e parecidos) e
  quebra de linha nos campos de uma linha (injeção de cabeçalho).
- **Remetente de e-mail gratuito** (`@gmail.com`, `@outlook.com`…): o painel avisa e o envio **exige** marcar que entende o risco (limite baixo, possível bloqueio da
  conta, spam). Para promoções em volume, use domínio próprio e provedor transacional (seção 7).

## 6. Painel: *E-mails*

Menu lateral → **E-mails** (qualquer administrador **consulta**; só o **owner** age: reenviar, cancelar, processar a fila, suprimir/liberar endereço, criar/enviar
campanha). Tudo o que o owner faz entra no histórico de atividades. Nunca aparecem senha, código, link de senha nem corpo de e-mail.

| Aba | O que mostra |
| --- | ------------ |
| **Visão geral** | alertas abertos (com o que fazer); “como os e-mails saem” e o que esse transporte informa ou **não** informa; totais do período (aceitas, falharam, bloqueadas, na fila…), taxa de aceitação, taxa de entrega/devolução/spam **só se o provedor informar**; mensagens por dia; fila e teto diário; estado dos avisos do provedor; por tipo; principais domínios de destino; supressões; consentimento |
| **Mensagens** | histórico filtrável (estado, tipo, categoria, período, e-mail ou nº do pedido) com a linha do tempo de cada mensagem (tentativas, códigos SMTP, avisos do provedor) e o `Message-ID` para achá-la no Gmail/Outlook |
| **Promoções** | campanhas, público atual, teste, envio, andamento (enviadas, na fila, falhas, puladas), parar |
| **Supressões** | endereços que não recebem nada, motivo e origem; o owner coloca ou libera |
| **Autenticação** | verificador de **SPF, DKIM, DMARC e MX** do domínio do remetente (lê o DNS público); botão **Enviar exemplos para mim** (owner): manda para o seu e-mail um exemplo de cada modelo, marcado “[Teste]”; passo a passo e como conferir no Gmail/Outlook |

### Alertas

Avaliados no máximo a cada 10 minutos por instância (e no botão **Atualizar**). Cada alerta abre, se **resolve sozinho** quando o problema passa e avisa os **donos por
e-mail uma vez** (de novo só depois de 24 h, se continuar). Alertas só “informativos” não viram e-mail.

| Alerta | Gravidade | Quando |
| ------ | --------- | ------ |
| Usuário/senha (ou chave) do envio recusados | crítico | houve erro de autenticação e nenhuma mensagem foi aceita depois |
| Muitas falhas ao enviar | atenção / crítico | ≥ 10 mensagens em 24 h e ≥ 20% / 50% falharam (por motivo do servidor, não de endereço) |
| Endereços recusados acima do esperado | atenção / crítico | ≥ 3 e > 2% / ≥ 10% em 7 dias |
| Recusas por política (5.7.x) | atenção / crítico | ≥ 2 / ≥ 10 em 7 dias (aponta para SPF/DKIM/DMARC) |
| Mensagens paradas na fila | atenção | mensagem com hora vencida há mais de 30 minutos |
| Teto diário | atenção / crítico | ≥ 80% / 100% do `EMAIL_DAILY_LIMIT` |
| Reclamações de spam | atenção / crítico | **só com provedor que avisa**: ≥ 0,10% / 0,30% das aceitas em 30 dias |
| Devoluções definitivas | atenção / crítico | **só com provedor que avisa**: > 2% / ≥ 5% |
| Provedor sem avisos | atenção | **só com provedor que avisa**: mensagens aceitas e nenhum aviso em 24 h |
| Remetente é e-mail gratuito | informação | `MAIL_FROM` com Gmail, Outlook, Yahoo… |

## 7. Variáveis de ambiente (Vercel → Settings → Environment Variables)

Todas ficam **só no servidor**; marque as senhas e chaves como *Sensitive*. Nada disso vai para o navegador nem para o Git.

| Variável | Para quê | Obrigatória |
| -------- | -------- | ----------- |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | servidor SMTP (no Gmail: `smtp.gmail.com`, o Gmail da loja e a **senha de app**) | sim |
| `SMTP_PORT`, `SMTP_SECURE`, `MAIL_FROM` | porta (465 padrão), TLS, remetente (`Copo Cheio <loja@seudominio.com.br>`); `MAIL_FROM` é obrigatória se `SMTP_USER` não for um e-mail | não |
| `SITE_URL` | endereço do site nos links e na logo dos e-mails | recomendada |
| `CRON_SECRET` | texto aleatório longo (≥ 16 caracteres). **Liga o cron diário**: a Vercel o envia como `Authorization: Bearer …` e `/api/cron/email` recusa tudo sem ele | recomendada |
| `EMAIL_DAILY_LIMIT` | teto de e-mails aceitos em 24 h (`0` = sem teto). Padrão: 450 com Gmail, sem teto nos outros | não |
| `EMAIL_PROMO_DAILY_LIMIT` | parte desse teto que as promoções podem usar por dia. Padrão: 40% do teto, ou 300 sem teto | não |
| `MAIL_REPLY_TO` | endereço de resposta (`Reply-To`); sem ela, não é enviado | não |
| `EMAIL_ORDER_NOTICES` | `off` pausa os e-mails de pedido e pagamento (interruptor de segurança; não afeta códigos, senhas, avisos de segurança nem promoções). Sem ela: ligados | não |
| `EMAIL_PROVIDER` | `smtp` (padrão) ou `resend` | não |
| `RESEND_API_KEY` | chave de API **só de envio** (só com `EMAIL_PROVIDER=resend`) | só no modo Resend |
| `RESEND_WEBHOOK_SECRET` | segredo `whsec_…` do webhook (só com `EMAIL_PROVIDER=resend`); sem ele a rota de avisos nem existe (404) | só no modo Resend |

(`RESEND_API_URL` existe só para os testes e é **ignorada em produção**: a chave de API nunca vai para outro endereço.)

## 8. Autenticar o domínio e conferir de verdade (SPF, DKIM, DMARC)

**Situação hoje (sem domínio próprio):** enviando pelo SMTP do Gmail com remetente `@gmail.com`, o Google assina e autentica a mensagem como `gmail.com`; na prática a
entrega para caixas comuns costuma funcionar com **baixo volume**, mas: não existe SPF/DKIM/DMARC **da loja** para configurar, o remetente aparece como uma conta
pessoal, o limite diário é de uma conta pessoal (~500; o sistema usa 450) e promoções em massa podem bloquear a conta. **Confirme em “Mostrar original” (abaixo).**

**Quando tiver um domínio** (ex.: `copocheio.com.br`, registrado no Registro.br ou semelhante, com acesso ao DNS):

1. **Escolha como enviar.** (a) E-mail do próprio domínio (Google Workspace, Zoho, Microsoft 365) pelas variáveis `SMTP_*`; (b) um serviço de envio (Brevo, Amazon SES,
   SendGrid, Mailgun, Postmark ou Resend) **também por SMTP**, sem mudar nada no sistema; (c) Resend **pela API** (`EMAIL_PROVIDER=resend`), que traz entrega/devolução/spam.
2. **No DNS, crie exatamente os registros que o PROVEDOR mostrar** no painel dele: **SPF** (um único TXT por domínio) e **DKIM** (um ou mais CNAME/TXT com nome e valor
   exatos). **Copie dele; não invente valores** — este sistema também não os inventa.
3. **DMARC, começando só monitorando:** TXT em `_dmarc.seudominio.com.br` com `v=DMARC1; p=none; rua=mailto:alguem@seudominio.com.br`. `p=none` não bloqueia nada; só gera
   relatórios. Depois de algumas semanas sem e-mails legítimos reprovados, **você** decide se endurece (`quarantine`, depois `reject`).
4. Na Vercel: `MAIL_FROM` = `Copo Cheio <loja@seudominio.com.br>` (domínio autenticado), `SITE_URL`, redeploy. Em **E-mails → Autenticação**, clique **Verificar agora**.
5. **Teste em caixas reais:** em **E-mails → Autenticação**, clique em **Enviar exemplos para mim** (owner): chegam, no e-mail da conta com que você entrou no painel, **7 exemplos marcados
   “[Teste]”** (confirmação de conta, nova senha, pedido recebido, pagamento confirmado, saiu para entrega, cancelado e promoção), com dados inventados e sem nenhum link de confirmação, de nova senha ou de acompanhamento que funcione (só os links de preferências e de “Cancelar inscrição” são de verdade, e são do seu próprio endereço: se clicar em “Cancelar inscrição” na promoção de exemplo, o seu endereço deixa de receber promoções).
   Faça isso com um endereço **Gmail** e um **Outlook.com** (para ver nos dois, cadastre em **Configurações → Administradores** um segundo dono com o outro endereço e entre com ele).
   **Não encaminhe** a mensagem para conferir: encaminhar apaga o resultado original de SPF/DKIM/DMARC. Confira o cabeçalho de cada uma:

   - **Gmail:** abra a mensagem → ⋮ → **Mostrar original**. No topo: **SPF: PASS**, **DKIM: PASS**, **DMARC: PASS** (com o domínio da loja ao lado).
   - **Outlook.com / Hotmail:** abra a mensagem → **…** → **Exibir** → **Exibir origem da mensagem**; procure `Authentication-Results:` com `spf=pass`, `dkim=pass`, `dmarc=pass`.
   - Anote a **pasta** em que caiu. `FAIL`/`NONE` em algum item = o registro correspondente do DNS não está como o provedor pede.

   | Tipo de e-mail | Gmail: pasta | Gmail: SPF/DKIM/DMARC | Outlook: pasta | Outlook: spf/dkim/dmarc |
   | -------------- | ------------ | --------------------- | -------------- | ----------------------- |
   | Confirmação de conta | | | | |
   | Nova senha | | | | |
   | Pedido recebido | | | | |
   | Pagamento confirmado | | | | |
   | Saiu para entrega | | | | |
   | Pedido cancelado | | | | |
   | Promoção (exemplo) | | | | |

6. (Opcional, recomendado) Verifique o domínio no **Google Postmaster Tools** para acompanhar a reputação e a taxa de spam no Gmail.
7. (Quando o volume de promoções crescer) Considere enviar e-mails de conta/pedido e promoções por **subdomínios diferentes** (por exemplo `contato.seudominio.com.br` e `novidades.seudominio.com.br`), para que a reputação de um
   não afete o outro. Hoje o sistema usa **um único remetente** (`MAIL_FROM`) para tudo; separar exigiria um segundo remetente para as campanhas (não implementado).

O verificador do painel **só lê o DNS público**; ele não cria registros. Sobre DKIM, ele tenta os nomes de chave mais comuns (`google`, `selector1`, `resend`, `s1`…) e **avisa
que não achar não prova que não existe** (cada provedor escolhe o nome; informe o nome exato no campo “Nome da chave DKIM”).

### Foto do remetente (a bolinha com a letra “C” no Gmail)

A bolinha ao lado do nome “Copo Cheio” na caixa de entrada **não faz parte do e-mail**: o Gmail mostra a **foto de perfil do remetente**, e sem foto mostra a inicial do nome numa cor sorteada. Nenhum HTML, imagem ou cabeçalho do e-mail muda isso. Há dois caminhos:

1. **Agora, sem domínio e de graça:** coloque a logo como foto da **conta Google da loja** (a do `SMTP_USER`). Entre nela em <https://myaccount.google.com> → **Informações pessoais** → **Foto** e envie o arquivo [`foto-remetente-gmail.png`](foto-remetente-gmail.png) (512 × 512, a logo sobre fundo preto, pronta para o recorte redondo). O Gmail passa a mostrar a logo para quem recebe, depois de algum tempo (e só quando a foto do perfil é visível para o destinatário, regra do Google). Outros leitores (Outlook, aplicativos de e-mail) usam as próprias regras e podem continuar mostrando a inicial.
2. **Com domínio próprio (BIMI):** a logo da marca aparece direto na caixa de entrada de quem recebe, de qualquer remetente do domínio. Exige domínio com **DMARC em modo de aplicação** (`p=quarantine` ou `p=reject`; este manual começa em `p=none`), a logo em SVG no formato do BIMI e, no Gmail, um **certificado de marca** (VMC ou CMC, pago, emitido por uma autoridade certificadora). Confirme os requisitos atuais na documentação do Google antes de investir: eles mudam. Não é viável sem domínio.

## 9. Provedor opcional: Resend (API + avisos assinados)

Fica **desligado**. Só vale com `EMAIL_PROVIDER=resend`, e exige um **domínio próprio verificado** na Resend (SPF e DKIM) e `MAIL_FROM` com esse domínio.

1. Crie a conta, **adicione e verifique o domínio** (copie os registros DNS que ela mostrar), e crie uma **chave de API só de envio** → `RESEND_API_KEY`.
2. No painel da Resend, crie um **webhook** apontando para `https://SEU-SITE/api/email/webhook/resend`, marque os eventos de **entrega, atraso, devolução e reclamação** e copie o
   segredo `whsec_…` → `RESEND_WEBHOOK_SECRET`. Deixe o **rastreio de abertura/clique desligado** (recomendado pela própria Resend para e-mails de conta e pedido).
3. `EMAIL_PROVIDER=resend` e redeploy. **E-mails → Visão geral** passa a mostrar entrega, devolução e spam; **Avisos do provedor** mostra o último aviso aceito.

**Segurança dos avisos:** só vale aviso **assinado** (padrão Svix: `svix-id`, `svix-timestamp`, `svix-signature`, HMAC-SHA256) e **recente** (±5 min), com comparação em tempo
constante; o corpo é lido por inteiro **antes** de qualquer gravação; o mesmo aviso reenviado (`svix-id`) vale uma vez só; aviso fora de ordem nunca faz a mensagem “voltar atrás”;
devolução definitiva e reclamação suprimem o endereço; devolução temporária só suprime depois de **3 em 7 dias** (por 7 dias); tipo de devolução desconhecido **nunca** suprime.
Aviso de mensagem ainda não registrada recebe `503` (o provedor tenta de novo); aviso antigo de mensagem desconhecida é só ignorado (mas uma reclamação ainda protege o endereço).
O envio usa `Idempotency-Key` = id do registro: tentar de novo a mesma mensagem não a duplica.

> **O que NÃO foi verificado contra o serviço real:** o formato exato do corpo dos avisos e os textos das mensagens de erro da Resend. Foram implementados a partir da documentação
> pública e **testados contra um simulador** (`tests/api-test21.mjs`), com leitura defensiva. A assinatura Svix foi conferida com o **exemplo oficial da documentação da Svix**.
> Antes de depender disso em produção, faça um envio e um aviso reais no ambiente de testes da Resend e confira o painel.

## 10. Privacidade e retenção (LGPD)

- **O que é guardado:** para cada e-mail, destinatário, tipo, categoria, data, estado, tentativas, código SMTP e motivo **sem endereço** — nunca corpo, código, link nem assunto dos
  e-mails com segredo. **180 dias** (`purge_expired_data`); receitas de falhas antigas em 14 dias; alertas resolvidos em 90 dias.
- **Excluir a conta, o owner excluir uma conta ou anonimizar uma pessoa** remove o endereço dos registros de e-mail, das preferências e da lista de supressão (`email_forget`).
- Preferências sem informação útil saem em 1 ano; pedido de promoções feito no cadastro e nunca confirmado, em 30 dias.
- A política de privacidade do site descreve e-mails de serviço, promoções (com consentimento), o registro de envios e os prazos.

## 11. Testes

| Suíte | O que prova |
| ----- | ----------- |
| `tests/unit/email-core.test.mjs` | classificação de respostas SMTP reais (definitivo × temporário × política × configuração), espera entre tentativas, tipos e configuração |
| `tests/unit/email-deliverability.test.mjs` | assinatura Svix (**exemplo oficial**, adulteração, hora, várias assinaturas), leitura dos avisos, análise de SPF/DKIM/DMARC, decisão dos alertas |
| `tests/unit/email-templates.test.mjs` | **compatibilidade dos templates**: HTML de tabelas, sem script/formulário/pixel, só https, texto = HTML, tamanho, assunto, escape de dados, cabeçalhos de descadastro só nas promoções |
| `tests/api-test17.mjs` | registro de cada e-mail, endereço inexistente, falha temporária, fila, usuário/senha recusados, política, segredo fora do registro, painel e permissões |
| `tests/api-test18.mjs` | e-mails de pedido e pagamento: gatilhos, sem duplicar, texto de entrega × retirada, e-mail velho cancelado, travas contra abuso, preferências, interruptor `EMAIL_ORDER_NOTICES=off` |
| `tests/api-test19.mjs` | consentimento, descadastro de um clique (e o `GET` que só leva às preferências), campanhas (público, número confirmado, teto, cancelar, descadastro no meio, cabeçalhos do teste), LGPD, cron |
| `tests/api-test20.mjs` | visão geral, DNS, alertas (abrem, avisam uma vez, se resolvem), teto diário, remetente gratuito, “Enviar exemplos para mim” (7 modelos, cabeçalhos, limite por hora, fora do teto de 40 por endereço) |
| `tests/api-test21.mjs` | provedor opcional (simulador): envio, chave de idempotência, erros da API, avisos assinados (autenticidade, repetição, ordem, supressão) |
| `tests/e2e-emails.cjs` | navegador: caixa de promoções, Minha conta, página de preferências, painel no celular e no computador, campanha de ponta a ponta, exemplos, atalhos em Clientes e no pedido, administrador comum |

`bash tests/run-api.sh` roda todas as suítes de API; `npm run test:unit`, os unitários; `bash tests/run-e2e.sh e2e-emails`, o navegador (precisa de `npm run build`).
Os testes usam um **servidor SMTP de mentira**, um **DNS de mentira** e um **simulador da API do provedor**: **nenhum e-mail real é enviado e nenhum domínio real é consultado**.

**Não é testável aqui** (e por isso está no procedimento manual da seção 8): chegada em caixa de entrada real, pasta (Entrada/Promoções/Spam), SPF/DKIM/DMARC reais do seu domínio e o
comportamento de cada leitor de e-mail com o seu layout.

## 12. Operação e problemas comuns

| Sintoma | O que fazer |
| ------- | ----------- |
| Alerta “O servidor de e-mail recusou o usuário ou a senha” | Confira `SMTP_USER`/`SMTP_PASS` (no Gmail, **senha de app** de 16 letras, com verificação em duas etapas), redeploy e use **Processar fila agora**: o que esperou sai |
| “Mensagens paradas na fila” | **Processar fila agora**; se continuar, abra a mensagem: o motivo está na linha do tempo |
| “Teto diário atingido” | Códigos de login continuam saindo; pedidos e promoções esperam. Para mais volume, use um provedor transacional |
| “Recusas por política (5.7.x)” | Reputação ou autenticação do remetente: veja **Autenticação** e a seção 8 |
| Cliente diz que não recebeu | Procure o e-mail dele em **Mensagens**: *Aceito* (peça para olhar o spam), *Bloqueado* (veja o motivo), *Falhou* (veja o motivo), ou nada (o endereço não chegou a ser usado) |
| Endereço digitado errado por engano e suprimido | **Supressões → Liberar** (owner). Para códigos de cadastro e login isso já não é preciso: a supressão **automática** não os impede e é apagada quando a pessoa confirma o código (seção 4.1) |
| Aparece na caixa do Gmail da loja um aviso “Mail Delivery Subsystem” / “Delivery Status Notification” | É uma **devolução depois do envio** (o servidor do destinatário recusou). O sistema **não lê** essa caixa (SMTP não avisa devolução): se o endereço não existe, coloque-o em **Supressões**. Com o provedor opcional (seção 9) isso é automático |
| Apareceu algo estranho nos e-mails de pedido (texto errado, e-mails repetidos, reclamação de cliente) | **Pause** só os e-mails de pedido: cadastre `EMAIL_ORDER_NOTICES=off` na Vercel e faça um novo deploy. Códigos de login, nova senha e promoções continuam. Depois de corrigir, apague a variável |
| Cron diário falhando com 401 | Falta `CRON_SECRET` na Vercel (o cron só liga com ele) |

## 13. Limites conhecidos e pendências

- **Sem domínio próprio** não há SPF/DKIM/DMARC da loja: o painel diz isso e o verificador de DNS fica “não se aplica” enquanto o remetente for `@gmail.com`.
- **SMTP não informa entrega, devolução nem spam**; só o provedor opcional informa (e ele ainda não foi exercitado contra o serviço real).
- **O link de acompanhamento dos e-mails de pedido mostra nome, endereço e observações a quem recebe o e-mail**: se o cliente digitar o e-mail de outra pessoa que existe, ela os vê (seção 3).
- **Abertura e clique não são medidos** (decisão de privacidade e reputação).
- **Pasta de destino** (Entrada/Promoções/Spam) é desconhecida por qualquer sistema.
- **Processamento sem agendador:** a fila anda por atividade e pelo cron **diário** (limite do plano gratuito da Vercel). Sem tráfego nem painel aberto, uma nova tentativa pode esperar até o cron.
- **Se a função da Vercel for interrompida no meio de um envio SMTP**, a mensagem pode ser reenviada depois de 5 minutos (entrega “pelo menos uma vez”); com o provedor opcional, a chave de idempotência evita a duplicata.
- **Promoções em volume por conta Gmail pessoal** não são recomendadas (limite diário, risco de bloqueio): use domínio próprio + provedor transacional.
- **Rascunhos e campanhas** não têm agendamento de data/hora (o envio começa quando o owner confirma).

## 14. Como criar um tipo de e-mail novo

1. Escreva o texto em `server/mailTemplates.ts` (conta) ou `server/email/templates.ts` (pedido, promoção, alerta), usando `renderEmail` e os blocos do layout.
2. Registre o tipo em `server/email/kinds.ts` (categoria, segredo, síncrono/fila, tetos) e, se for enfileirável, faça `server/email/render.ts` montá-lo a partir da receita.
3. Envie com `deliver()` (`server/email/service.ts`). Não chame o SMTP direto: assim o e-mail ganha registro, proteções, fila e painel.
4. Acrescente o caso em `tests/unit/email-templates.test.mjs` (compatibilidade) e um teste de API.
