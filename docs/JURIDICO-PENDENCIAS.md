# Textos e regras que precisam de validação jurídica

> **Este arquivo NÃO é parecer jurídico.** O sistema foi montado para cumprir o que está descrito aqui, mas os **textos** que o cliente lê
> (e a **legislação aplicável**: federal, estadual e municipal) precisam ser conferidos por quem entende do assunto antes de a loja
> depender deles. Nenhuma lei foi citada de memória neste arquivo: onde falta a referência, ela está marcada como **a confirmar**.

## 1. Venda de bebida alcoólica a maiores de 18 anos

**O que o sistema faz**

| Momento | O que acontece | Onde está no código |
| ------- | -------------- | ------------------- |
| Primeira visita (`/`, `/bebidas`, `/checkout`) | Janela "Venda proibida para menores de 18 anos" com **Tenho 18 anos ou mais** / **Tenho menos de 18 anos**. A resposta fica **só no navegador** (`copocheio:age-v1`). Quem diz que é menor vê uma tela explicando e não entra no cardápio. Páginas livres: privacidade, conta, acompanhar pedido, página 404. | `src/site/AgeGate.tsx` |
| Checkout | Se há bebida alcoólica no carrinho, a caixa **"Declaro que tenho 18 anos ou mais…"** é obrigatória. Sem ela o botão não envia. | `src/site/Checkout.tsx` |
| Servidor | O banco **recusa** pedido com bebida alcoólica sem `age_confirmed: true` (booleano, não texto), mesmo que alguém fale direto com a API. Grava `age_declared_at` e a versão do texto aceito (`age_declaration_version`). | `db/migrations/0027_age_and_customer_cancel.sql` (`create_order`) |
| Painel | Pedido com bebida alcoólica mostra **"Conferir documento 18+"**. Marcar como **entregue** exige o clique em **"Conferi: 18 anos ou mais"**; sem isso o servidor recusa (`age_check_required`). Quem confere fica registrado (`age_checked_at`, `age_checked_by_name`). Se o cliente não comprovar, o botão **"Recusar entrega (maioridade não comprovada)"** cancela o pedido com o motivo e devolve o estoque. A comanda impressa traz "CONFERIR DOCUMENTO COM FOTO: 18 ANOS OU MAIS". | `src/admin/Orders.tsx`, `server/routes/orders.ts` |
| Dados | **Não** se guarda documento, foto, data de nascimento nem CPF. Só: declarou (sim) e quando, versão do texto, e quem conferiu na entrega e quando. | — |

**Limites que a loja precisa conhecer (e aceitar)**

- A janela e a caixa do checkout são **autodeclaração**: não provam idade. Quem prova é a **conferência do documento na entrega/retirada**, feita por uma pessoa.
- O sistema **não bloqueia** o entregador de entregar sem conferir (ele é humano): só impede de marcar "entregue" no painel sem registrar a conferência.
- Produtos novos e antigos nascem como **bebida alcoólica** (`alcoholic = true`), que é o lado seguro. Quem vende refrigerante, água, gelo etc. precisa **desmarcar "Bebida alcoólica"** em *Produtos*. Um pedido só com itens sem álcool não pede declaração nem conferência.

**Textos a validar (copiar do código; a versão é `AGE_TEXT_VERSION`, hoje `v1`, e deve subir para `v2` quando o texto mudar)**

1. Janela de entrada: "Venda proibida para menores de 18 anos. Aqui se vendem bebidas alcoólicas. Para continuar, confirme que você tem 18 anos ou mais. Na entrega ou na retirada pedimos um documento oficial com foto, e o pedido não é entregue a quem não comprovar a maioridade."
2. Tela de recusa: "Só atendemos maiores de 18 anos. Bebidas alcoólicas não podem ser vendidas a menores de 18 anos…"
3. Caixa do checkout: "Declaro que tenho 18 anos ou mais. Sei que a entrega (ou retirada) só acontece com a apresentação de documento oficial com foto e que o pedido não é entregue a quem não comprovar a maioridade." Erro: "Confirme que você tem 18 anos ou mais para finalizar o pedido."
4. Aviso na página de acompanhamento: "Deixe um documento oficial com foto à mão: na entrega (ou retirada) conferimos que você tem 18 anos ou mais. Sem comprovação de maioridade, o pedido não é entregue."
5. "Beba com moderação" (rodapé da janela): **a confirmar** se há frase/formato obrigatório para a propaganda e a venda de bebida alcoólica.
6. Política de privacidade: marcador "Maioridade (18+)" e a menção ao armazenamento local do navegador.

**Perguntas para o responsável jurídico**

- A autodeclaração + conferência na entrega atende ao que a legislação aplicável exige de quem vende bebida alcoólica a distância? Falta algum procedimento (por exemplo, guardar registro da conferência por mais tempo)? **A confirmar.**
- O pedido deve ficar condicionado à conferência do documento antes de ser aceito? Hoje o pedido é aceito (o pagamento é feito à loja) e a conferência é na entrega.
- Há restrição de horário, local ou de entrega a terceiros (portaria, outra pessoa que recebe) para bebida alcoólica? O sistema não trata isso. **A confirmar.**
- Prazo de guarda de `age_declared_at`, `age_checked_at` e `age_checked_by_name`: hoje acompanham o pedido (não são apagados sozinhos; ver *Docs → OPERACAO.md*, item 7).

## 2. Cancelamento pelo cliente

**O que o sistema faz** (`customer_cancel_order`, `server/orderCancel.ts`)

- O cliente cancela pela página do pedido (link de acompanhamento) ou por *Minha conta → pedido*. Não precisa de login com o link; com conta, só o dono do pedido consegue.
- Só enquanto o pedido está **aguardando pagamento** ou **novo** e **sem dinheiro recebido** (regra `order_cancel_why`). Se a loja já confirmou/está preparando/saiu para entrega, ou se há pagamento recebido ou sendo processado, a página mostra o motivo e leva ao WhatsApp da loja: aí só a loja cancela.
- O cancelamento é **uma transação**: muda o estado, devolve o estoque **uma única vez** (repetir o pedido não devolve de novo), grava motivo e autor no histórico, cancela a cobrança Pix pendente na operadora (se falhar, marca "precisa de conferência" no painel) e dispara o e-mail "pedido cancelado".
- **Pedido já pago online:** o cliente NÃO cancela sozinho; a página diz "Este pedido já foi pago. Para cancelar, fale com a loja: a devolução do valor é combinada com ela e não acontece automaticamente." Quando a loja cancela, a devolução do dinheiro é um passo do **dono no painel** (Pagamentos → "Devolver pagamento") e só aparece como devolvida quando a operadora confirmar.

**Textos a validar:** a caixa "Cancelar pedido" (motivo, confirmação, mensagem de pedido que não pode mais ser cancelado, aviso sobre devolução do pagamento) em `src/site/Tracking.tsx` e o e-mail "pedido cancelado" (`db/migrations`, gatilho `order_cancelled`).

**Perguntas para o responsável jurídico:** o prazo e as condições de cancelamento/arrependimento aplicáveis a esta loja (compra à distância de alimento/bebida) e o prazo para devolver o dinheiro. **A confirmar** — o sistema hoje não promete prazo de devolução.

## 3. Pagamento e devolução

- Texto sobre devolução: o sistema **não devolve dinheiro** (o pagamento é feito à loja: dinheiro, cartão na entrega ou chave PIX). A devolução é combinada com a loja e o dono marca o pedido como "reembolsado" à mão. O pagamento pelo site (ValidaPay) foi retirado do sistema.
- O status manual de pedido (por exemplo, "cancelado") **não é** uma transação financeira.
- Nota fiscal: o sistema **não emite** nota fiscal. Se a loja precisar, é um processo separado (contador/emissor); nada foi integrado nem inventado aqui.
- **Páginas de políticas (migration 0033)**: `/termos`, `/trocas-e-cancelamentos`, `/entrega`, `/pagamento-e-reembolso` e `/contato-e-responsavel`. O texto padrão descreve **o que o sistema faz hoje** e foi escrito para **não prometer** prazos, valores, garantias nem direitos, **nem citar leis**.
  O owner edita em *Configurações → Termos e políticas*; cada página mostra "ainda não revisada juridicamente" até alguém marcar como revisada (quem e quando); **editar o texto tira essa marca**. Itens a validar:
  1. Prazo e condições de **arrependimento/cancelamento** e de troca (o texto padrão só diz que o cliente cancela até a loja confirmar e que o resto se combina pelo WhatsApp). **A confirmar** o que a legislação aplicável exige.
  2. Prazo para a devolução do dinheiro (o texto padrão não promete prazo: diz que a devolução é combinada com a loja e que o prazo depende da forma de pagamento e do banco).
  3. Forma de pagamento: o texto diz que o Pix é enviado para a chave da loja e que o site não coleta dados de cartão. Conferir.
  4. **Contato e responsável**: a razão social, o CNPJ e o endereço do responsável **não existem no sistema** e **não foram inventados**; a loja precisa escrevê-los na página (o bloco de WhatsApp/Instagram/endereço que a loja já cadastrou aparece automaticamente).
  5. Condições de entrega (bairros atendidos, tempo estimado "é uma previsão") e de retirada.

## 4. Política de privacidade (LGPD)

A página `/privacidade` descreve o que o sistema realmente faz, mas **razão social, CNPJ, encarregado (DPO) e canal de contato** precisam ser preenchidos pela loja, e o texto revisado por quem entende de LGPD (já dito em *OPERACAO.md*, seção 9). Acrescentamos: maioridade (18+) e o item de armazenamento local do navegador.

## 5. Outros pontos que tocam o jurídico ou o fiscal

| Tema | O que o sistema faz | O que precisa de validação |
| ---- | ------------------- | -------------------------- |
| **Avaliações** (migration 0034) | O cliente avalia o pedido entregue (nota 1–5 e comentário de até 500 letras). Nasce "aguardando"; **só aparece no site depois que a loja publica**; o público vê nota, comentário e data (sem nome, telefone nem número do pedido). A loja pode esconder ou apagar. | Política de moderação (publicar só o que for verdadeiro; não apagar avaliações negativas legítimas só por serem negativas — regra de conduta/consumidor **a confirmar**), prazo de guarda (hoje: até a loja apagar ou o pedido ser anonimizado) e o aviso no formulário ("não escreva dados pessoais"). |
| **Medição de visitas (GA4)**, opcional | Desligada. Se a loja ligar (`GA_MEASUREMENT_ID`), só mede quem **aceitar** o aviso; sem nome, telefone, e-mail, endereço nem itens; sem anúncios. A política de privacidade muda sozinha. | Base legal (consentimento), texto do aviso, transferência internacional de dados (o Google processa fora do Brasil) e a necessidade de atualizar a política. **A confirmar.** |
| **Programa de pontos** (migration 0035), se o dono ligar | Desligado e sem valores por padrão; o dono define as regras. Pontos só para quem tem conta, creditados na entrega, estornados se o pagamento é devolvido, trocados por cupom pessoal de valor fixo, sem valor em dinheiro, sem transferência. Excluir a conta apaga saldo, extrato e cupons. | Regulamento do programa (quem pode participar, validade dos pontos e do cupom, o que acontece em cancelamento/devolução, alteração ou fim do programa), tratamento tributário do desconto/benefício e a base legal do tratamento (a política de privacidade já descreve os dados). **A confirmar.** |
| **Cupons e entrega grátis** | Regras objetivas calculadas no banco; o pedido guarda o que foi aplicado. | Se há regra de publicidade/oferta (validade, limite de uso, "enquanto durarem os estoques") a informar ao cliente. **A confirmar.** |
| **Agendamento** | O cliente escolhe a faixa de horário; o sistema só recebe pedido dentro do horário de funcionamento. | Se a entrega agendada de bebida alcoólica tem restrição de horário no município. **A confirmar** (o sistema não trata). |
| **Dados do entregador** | A loja cadastra nome e telefone (opcional). O cliente vê só o primeiro nome, enquanto o pedido está a caminho. | Relação com o entregador (vínculo/terceirizado) e base legal do tratamento. **Fora do sistema.** |
| **Nota fiscal (NFC-e/NF-e)** | **Não é emitida.** O sistema não tem integração fiscal e nenhuma foi inventada. Detalhes em [`FISCAL.md`](FISCAL.md). | Regime tributário, obrigatoriedade e emissor: **definir com o contador**. Se for emitir, é um projeto próprio (cadastro fiscal dos produtos — NCM, CFOP, CST —, certificado digital, ambiente de homologação da SEFAZ). |

## 6. Como registrar a validação

Quando o responsável jurídico aprovar (ou ajustar) um texto: altere-o no código, **suba `AGE_TEXT_VERSION`** (em `src/site/AgeGate.tsx`; o servidor aceita `v1` a `v999`) para que o aceite antigo e o novo fiquem distinguíveis nos pedidos, e anote aqui a data e quem validou.

| Texto | Validado por | Data | Observações |
| ----- | ------------ | ---- | ----------- |
| Janela de maioridade (v1) | _pendente_ | | |
| Declaração no checkout (v1) | _pendente_ | | |
| Aviso de cancelamento | _pendente_ | | |
| Política de privacidade | _pendente_ | | |
| Termos de uso | _pendente_ | | marcar "revisada" também no painel |
| Cancelamento e trocas | _pendente_ | | idem |
| Entrega e retirada | _pendente_ | | idem |
| Pagamento e reembolso | _pendente_ | | idem |
| Contato e responsável (preencher razão social, CNPJ e endereço) | _pendente_ | | idem |
| Aviso da medição de visitas (só se ligar o GA4) | _pendente_ | | |
