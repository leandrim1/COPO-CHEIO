// Escolha do gelo: tipos, textos e as regras puras do carrinho (sem React, para poder ser testado à parte).
//
// As categorias que pedem a escolha são marcadas no banco (categories.ice_choice_required); o site só lê essa marca. Cada linha do
// pedido é "produto + gelo": o mesmo copão com gelos diferentes são duas linhas, cada uma com a sua quantidade.

export type IceChoice = 'normal' | 'flavored';

export const ICE_CHOICES: readonly IceChoice[] = ['normal', 'flavored'];

export const ICE_QUESTION = 'Qual gelo você prefere?';
export const ICE_REQUIRED_MESSAGE = 'Escolha o tipo de gelo para continuar.';

export const ICE_INFO: Record<IceChoice, { label: string; emoji: string }> = {
  normal: { label: 'Gelo normal', emoji: '🧊' },
  flavored: { label: 'Gelo de sabor', emoji: '🍓' },
};

export const isIceChoice = (value: unknown): value is IceChoice => value === 'normal' || value === 'flavored';

// Texto curto para listas e mensagens: "Gelo normal", "Gelo de sabor" (vazio quando o item não tem escolha).
export const iceLabel = (value: unknown): string => (isIceChoice(value) ? ICE_INFO[value].label : '');

// ---- Carrinho ------------------------------------------------------------------------------------
// O carrinho é { chave: quantidade }. A chave é o id do produto (produto sem escolha de gelo, o formato de sempre) ou
// "id-do-produto:normal" / "id-do-produto:flavored" (produto que pede o gelo).

export type Cart = Record<string, number>;

// Mais do que isso de um mesmo produto (somando todos os gelos) o servidor recusa.
export const MAX_PER_PRODUCT = 99;

export const lineKey = (productId: string, ice: IceChoice | null): string => (ice ? `${productId}:${ice}` : productId);

export function parseLineKey(key: string): { productId: string; ice: IceChoice | null } | null {
  const at = key.lastIndexOf(':');
  if (at < 0) return key ? { productId: key, ice: null } : null;
  const productId = key.slice(0, at);
  const ice = key.slice(at + 1);
  return productId && isIceChoice(ice) ? { productId, ice } : null;
}

export function countFor(cart: Cart, productId: string): number {
  let total = 0;
  for (const [key, qty] of Object.entries(cart)) if (parseLineKey(key)?.productId === productId) total += qty;
  return total;
}

// O que foi guardado no aparelho (pode ser de uma versão antiga do site, ou estar corrompido): só entra o que é válido.
export function normalizeCart(raw: unknown): Cart {
  const cart: Cart = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return cart;
  for (const [key, qty] of Object.entries(raw)) {
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0 || !parseLineKey(key)) continue;
    cart[key] = Math.min(qty, MAX_PER_PRODUCT);
  }
  return cart;
}

// Soma `qty` na linha `key`, sem passar de 99 unidades do produto (somados todos os gelos).
function put(cart: Cart, key: string, qty: number): Cart {
  const parsed = parseLineKey(key);
  const next = { ...cart };
  if (!parsed || qty <= 0) {
    delete next[key];
    return next;
  }
  delete next[key];
  const others = countFor(next, parsed.productId);
  const room = Math.max(0, MAX_PER_PRODUCT - others);
  if (room > 0) next[key] = Math.min(qty, room);
  return next;
}

export const addToCart = (cart: Cart, productId: string, ice: IceChoice | null, qty = 1): Cart => put(cart, lineKey(productId, ice), (cart[lineKey(productId, ice)] ?? 0) + qty);

export const setLineQty = (cart: Cart, key: string, qty: number): Cart => put(cart, key, qty);

// Troca o gelo de uma linha: a quantidade vai para a linha do gelo novo (somando, se ela já existir).
export function changeLineIce(cart: Cart, key: string, ice: IceChoice | null): Cart {
  const parsed = parseLineKey(key);
  const qty = cart[key];
  if (!parsed || !qty) return cart;
  const target = lineKey(parsed.productId, ice);
  if (target === key) return cart;
  const without = { ...cart };
  delete without[key];
  return put(without, target, (without[target] ?? 0) + qty);
}

// Depois que o cardápio chega: tira o que não está mais nele e acerta as linhas ao que cada produto pede AGORA (se a categoria deixou
// de pedir o gelo, a linha volta a ser só o produto; se passou a pedir, a linha que veio sem escolha continua no pedido, marcada como
// "falta escolher"). `requiresIce` devolve undefined para produto desconhecido. Devolve o mesmo objeto quando nada muda.
export function settleCart(cart: Cart, requiresIce: (productId: string) => boolean | undefined): Cart {
  let next: Cart = {};
  let changed = false;
  for (const [key, qty] of Object.entries(cart)) {
    const parsed = parseLineKey(key);
    const requires = parsed ? requiresIce(parsed.productId) : undefined;
    if (!parsed || requires === undefined) {
      changed = true;
      continue;
    }
    const target = requires ? key : parsed.productId;
    if (target !== key) changed = true;
    next = put(next, target, (next[target] ?? 0) + qty);
  }
  if (!changed && Object.keys(next).length === Object.keys(cart).length && Object.entries(next).every(([key, qty]) => cart[key] === qty)) return cart;
  return next;
}
