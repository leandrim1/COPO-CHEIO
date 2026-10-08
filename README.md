# COPO CHEIO – Disk Bebidas

Site da Copo Cheio feito com React, TypeScript, Vite, Tailwind CSS e Lucide React.

```bash
npm install
npm run dev      # servidor de desenvolvimento
npm run build    # verifica os tipos e gera a versão de produção
```

## Páginas

| Rota        | Conteúdo                                                        |
| ----------- | --------------------------------------------------------------- |
| `/`         | Hero, Contato, chamada final ("Deu sede?") e rodapé             |
| `/bebidas`  | Cardápio: busca, categorias, favoritos e pedido pelo WhatsApp   |

Menu: **Início · Bebidas · Contato · Pedir agora**. "Bebidas" abre a página `/bebidas`; "Contato" rola até a seção de contato da Home.
O `vercel.json` faz o `/bebidas` abrir também quando a página é recarregada ou acessada direto.

Todo o código da interface está em `src/App.tsx`.

## Adicionar produtos

Os produtos ficam em **`public/produtos.json`** (hoje vazio: `[]`). Cada produto é um objeto:

```json
[
  {
    "id": "milkshake-chocolate-maracuja",
    "name": "Milkshake de Chocolate com Maracujá",
    "category": "Milkshakes",
    "price": 22.9,
    "description": "Milkshake cremoso com calda de chocolate, maracujá e picolé de manga.",
    "image": "/img/milkshake-chocolate-maracuja.webp",
    "featured": true
  }
]
```

- `name`, `price` (número, em reais) e `category` são os campos principais. `id` é opcional (precisa ser único).
- `description` e `image` são opcionais. Sem imagem aparece um copo no lugar.
- `featured: true` põe o produto em **"Os favoritos da galera"** (até 4).
- As **categorias** da página nascem sozinhas dos produtos, na ordem em que aparecem.
- Imagens: coloque em `public/img/` e use o caminho `/img/arquivo.webp`. Prefira **fundo transparente** (PNG ou WebP) e foto quadrada.

## Dados da loja

No topo de `src/App.tsx`, no objeto `STORE` (ou pelas variáveis de ambiente do deploy). O que ficar vazio **não aparece** no site.

| Campo           | Variável               | Hoje                                  |
| --------------- | ---------------------- | ------------------------------------- |
| `whatsapp`      | `VITE_WHATSAPP`        | vazio (só números: `5511999999999`)   |
| `instagram`     | `VITE_INSTAGRAM`       | `copocheiodisk`                       |
| `address`       | `VITE_ADDRESS`         | vazio (com endereço, aparecem o mapa e o "Como chegar") |
| `hours`         | `VITE_HOURS`           | `Segunda à Sexta - 09:00 às 23:00`    |
| `deliveryTime`  | `VITE_DELIVERY_TIME`   | `30 a 45 min`                         |
| `deliveryFee`   | `VITE_DELIVERY_FEE`    | `R$ 5,00`                             |

Sem o número do WhatsApp, os botões abrem o WhatsApp para a pessoa escolher o contato. Com o número, abrem a conversa direto com a mensagem do pedido pronta.

## Pedido

O cliente adiciona bebidas na página `/bebidas`, abre "Ver pedido", confere quantidades e total, informa endereço e observações (opcionais) e envia tudo numa mensagem pronta para o WhatsApp. O pedido fica guardado no navegador.
