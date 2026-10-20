# Nota fiscal — o que existe, o que não existe e o que é preciso decidir

> **Este arquivo não é orientação fiscal nem contábil.** O sistema **não emite nota fiscal** e **não declara conformidade fiscal**. Nada foi integrado nem inventado. A decisão (qual nota, por qual emissor, quando) é do **contador** da loja.

## 1. O que existe hoje no sistema

* **Investigação feita no código (20/10/2026):** não há tabela, coluna, rota, tela, variável de ambiente nem dependência de emissão fiscal. Não há NCM, CFOP, CST/CSOSN, alíquota, série, numeração fiscal nem certificado digital em nenhum lugar.
* O que o sistema gera é um **recibo/comanda do pedido** (tela de confirmação, e-mails de pedido, impressão da comanda no painel). **Recibo de pedido não é nota fiscal** e a tela/e-mails não dizem que é.
* O sistema guarda para cada pedido: itens com preço da hora, subtotal, taxa de entrega, desconto (cupom), taxa de serviço/cartão (quando há pagamento online), total, forma e situação do pagamento. Esses dados servem de **base** para uma futura emissão, mas **não bastam** (faltam os dados fiscais do produto e do emitente).

## 2. O que a ValidaPay oferece (consultado na documentação oficial em 20/10/2026)

A ValidaPay tem uma API de notas fiscais (`/v1/invoices/notas`, escopos `nota.fiscal/read` e `nota.fiscal/write`) **que emite somente NFS-e (nota fiscal de SERVIÇO)**. A própria documentação diz: *"Hoje o único modelo suportado é `NFSE`"*. Ela exige a **configuração fiscal da empresa emissora** (CNPJ, regime tributário, certificado digital A1, tributos padrão) e depende do padrão da **prefeitura** do município.

**Consequência importante:** a venda de bebidas é **venda de mercadoria** (comércio), que normalmente se documenta com **NFC-e** (consumidor final, SEFAZ do estado) ou **NF-e**, e **não** com NFS-e. Portanto **a API de notas da ValidaPay, como documentada, provavelmente não atende** a venda de bebidas. Só poderia se aplicar a algo que seja **serviço** de fato (por exemplo, se o contador entender que a taxa de entrega é um serviço faturado à parte). **A confirmar com o contador.** Não foi ligada, testada nem simulada.

## 3. O que o contador precisa definir

1. **Regime tributário** da loja (MEI, Simples Nacional, Lucro Presumido…) e se o **MEI** está obrigado a emitir nota para consumidor final (regra de cada estado/município — **a confirmar**).
2. **Qual documento** emitir na venda: NFC-e, NF-e ou nenhum para o consumidor final; e o tratamento da **taxa de entrega** e das **taxas de serviço/cartão** repassadas ao cliente.
3. **Quando** emitir: na confirmação do pedido, no pagamento ou na entrega; e como tratar **cancelamento** (pedido cancelado, devolução de pagamento) e **pedido com pagamento na entrega**.
4. **Dados fiscais por produto:** NCM, CFOP, CST/CSOSN, alíquotas, origem, unidade, código de barras (GTIN), e o tratamento de **bebida alcoólica** (tributos específicos, substituição tributária, selo/IPI, conforme o estado).
5. **Emissor:** emitir pelo próprio sistema do contador/ERP, por um emissor de NFC-e de terceiros (serviço pago) ou pela SEFAZ diretamente. A escolha define custo, certificado digital A1 (tem validade e custo), CSC/ID token da NFC-e e o ambiente de homologação.
6. **Obrigações acessórias** (SPED, apuração, guias) — fora do escopo do site.

## 4. O que seria preciso construir (só depois das decisões acima)

| Parte | O que muda no sistema |
| ----- | --------------------- |
| Dados do emitente | Cadastro (razão social, CNPJ, IE, endereço, regime, CSC) no painel — **sem** guardar o certificado em texto aberto; preferir que o certificado fique no emissor |
| Dados fiscais do produto | Colunas novas em `products` (NCM, CFOP, CST/CSOSN, origem, unidade, GTIN) e tela de edição; validação no servidor |
| Dados do consumidor | CPF/CNPJ na nota é **opcional** para NFC-e em geral (**a confirmar**); hoje o checkout **não coleta CPF/CNPJ**. Coletar exige base legal e aviso na política de privacidade |
| Emissão | Rota de servidor que chama o emissor escolhido, **idempotente** (uma nota por pedido), com fila/nova tentativa e estado (`pendente`, `autorizada`, `rejeitada`, `cancelada`), sem bloquear o pedido |
| Cancelamento | Ligado ao cancelamento do pedido e à devolução do pagamento, dentro do prazo do estado |
| Entrega da nota | Link/PDF/XML no e-mail e na página do pedido; guarda do XML pelo prazo legal (**a confirmar**) |
| Testes | Ambiente de **homologação** da SEFAZ/emissor; nenhuma nota real durante o desenvolvimento |

**Estimativa de esforço (depende totalmente do emissor):** de alguns dias (emissor com API pronta de NFC-e) a semanas (integração direta com a SEFAZ). Não implementar antes de o contador decidir.

## 5. Regras que valem desde já

* Não chamar o recibo do pedido de "nota fiscal" (o sistema não o faz).
* Não declarar à clientela que há emissão de nota enquanto não houver.
* Se a loja emitir notas por fora do sistema, o **número do pedido** (`#1001…`) é a ponte entre o recibo e a nota; o painel permite exportar os pedidos em CSV para o contador (*Pedidos → Exportar CSV*, só o owner).
