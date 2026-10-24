import { normalizePicks, picksToken, tokenToPicks } from './flavors';
import type { FlavorPick } from './flavors';

// Escolha do gelo: tipos, textos e as regras puras do carrinho (sem React, para poder ser testado à parte).
//
// Os produtos que pedem a escolha são marcados no banco (products.ice_choice_required, escolhidos no painel); o site só lê essa marca. Cada linha do
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
// O carrinho é { chave: quantidade }. A chave é o id do produto (produto sem escolha de gelo, o formato de sempre),
// "id-do-produto:normal" / "id-do-produto:flavored" (produto que pede o gelo) ou "id-do-combo@id-do-energético" (combo com o energético
// trocado: cada unidade trocada é uma unidade do combo, só que com outro energético, e o preço dela leva a diferença) ou
// "id-do-combo|unidade|sabores" / "id-do-combo|unidade|sabores|id-do-energético" (combo com gelos saborizados: CADA unidade do combo é uma linha própria,
// com a sua escolha de sabores, e nunca se mistura com outra; "unidade" é só um código para as linhas não se confundirem).

export type Cart = Record<string, number>;

// Mais do que isso de um mesmo produto (somando todos os gelos) o servidor recusa.
export const MAX_PER_PRODUCT = 99;

export type Flavored = { unit: string; picks: FlavorPick[] };

export const lineKey = (productId: string, ice: IceChoice | null, swapTo: string | null = null, flavored: Flavored | null = null): string =>
  flavored ? `${productId}|${flavored.unit}|${picksToken(flavored.picks)}${swapTo ? `|${swapTo}` : ''}` : swapTo ? `${productId}@${swapTo}` : ice ? `${productId}:${ice}` : productId;

export type ParsedKey = { productId: string; ice: IceChoice | null; swapTo: string | null; flavors: FlavorPick[] | null; unit: string | null };

export function parseLineKey(key: string): ParsedKey | null {
  if (key.includes('|')) {
    const [productId, unit, token, swapTo, extra] = key.split('|');
    const flavors = tokenToPicks(token ?? '');
    const okSwap = swapTo === undefined || (swapTo !== '' && !/[@:|]/.test(swapTo));
    return productId && !/[@:]/.test(productId) && unit && /^[a-z0-9]{1,16}$/.test(unit) && flavors && okSwap && extra === undefined ? { productId, ice: null, swapTo: swapTo ?? null, flavors, unit } : null;
  }
  const swapAt = key.indexOf('@');
  if (swapAt >= 0) {
    const productId = key.slice(0, swapAt);
    const swapTo = key.slice(swapAt + 1);
    return productId && swapTo && !/[@:]/.test(swapTo) && !productId.includes(':') ? { productId, ice: null, swapTo, flavors: null, unit: null } : null;
  }
  const at = key.lastIndexOf(':');
  if (at < 0) return key ? { productId: key, ice: null, swapTo: null, flavors: null, unit: null } : null;
  const productId = key.slice(0, at);
  const ice = key.slice(at + 1);
  return productId && isIceChoice(ice) ? { productId, ice, swapTo: null, flavors: null, unit: null } : null;
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
    const parsed = typeof qty === 'number' && Number.isInteger(qty) && qty > 0 ? parseLineKey(key) : null;
    if (!parsed) continue;
    // Linha de combo com gelos: cada unidade é uma linha (quantidade 1).
    cart[key] = parsed.flavors ? 1 : Math.min(qty as number, MAX_PER_PRODUCT);
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
  if (room > 0) next[key] = Math.min(parsed.flavors ? 1 : qty, room);
  return next;
}

export const addToCart = (cart: Cart, productId: string, ice: IceChoice | null, qty = 1): Cart => put(cart, lineKey(productId, ice), (cart[lineKey(productId, ice)] ?? 0) + qty);

export const setLineQty = (cart: Cart, key: string, qty: number): Cart => put(cart, key, qty);

// Troca o gelo de uma linha: a quantidade vai para a linha do gelo novo (somando, se ela já existir).
export function changeLineIce(cart: Cart, key: string, ice: IceChoice | null): Cart {
  const parsed = parseLineKey(key);
  const qty = cart[key];
  if (!parsed || parsed.swapTo || parsed.flavors || !qty) return cart;
  const target = lineKey(parsed.productId, ice);
  if (target === key) return cart;
  const without = { ...cart };
  delete without[key];
  return put(without, target, (without[target] ?? 0) + qty);
}

// Depois que o cardápio chega: tira o que não está mais nele e acerta as linhas ao que cada produto pede AGORA (se o produto deixou
// de pedir o gelo, a linha volta a ser só o produto; se passou a pedir, a linha que veio sem escolha continua no pedido, marcada como
// "falta escolher"). `requiresIce` devolve undefined para produto desconhecido. `swapOk` diz se a troca de energético de uma linha ainda
// vale (o combo ainda tem energético definido e o novo ainda existe e é de 2L): se não vale, a linha volta a ser o combo normal.
// Devolve o mesmo objeto quando nada muda.
// `comboIces` diz quantos gelos saborizados o produto traz agora (0 = nenhum): a linha de um combo que deixou de trazer gelos volta a ser só o combo
// (trocado, se a troca ainda vale); a de um combo que ainda traz gelos mantém a escolha (se um sabor esgotou, a linha continua, marcada "escolha de novo").
export function settleCart(
  cart: Cart,
  requiresIce: (productId: string) => boolean | undefined,
  swapOk?: (productId: string, swapTo: string) => boolean,
  comboIces?: (productId: string) => number,
): Cart {
  let next: Cart = {};
  let changed = false;
  for (const [key, qty] of Object.entries(cart)) {
    const parsed = parseLineKey(key);
    const requires = parsed ? requiresIce(parsed.productId) : undefined;
    if (!parsed || requires === undefined) {
      changed = true;
      continue;
    }
    const swapValid = parsed.swapTo ? (swapOk ? swapOk(parsed.productId, parsed.swapTo) : true) : false;
    let target: string;
    if (parsed.flavors) {
      if ((comboIces?.(parsed.productId) ?? 0) > 0) target = parsed.swapTo && !swapValid ? lineKey(parsed.productId, null, null, { unit: parsed.unit as string, picks: parsed.flavors }) : key;
      else target = swapValid ? lineKey(parsed.productId, null, parsed.swapTo) : parsed.productId;
    } else target = parsed.swapTo ? (swapValid ? key : parsed.productId) : requires ? key : parsed.productId;
    if (target !== key) changed = true;
    next = put(next, target, (next[target] ?? 0) + qty);
  }
  if (!changed && Object.keys(next).length === Object.keys(cart).length && Object.entries(next).every(([key, qty]) => cart[key] === qty)) return cart;
  return next;
}

// ---- Combos com gelos saborizados ----------------------------------------------------------------
// Cada unidade do combo é uma linha (quantidade 1) com a SUA escolha de sabores: aumentar a quantidade no pedido abre a escolha de novo (nunca copia a de outra
// unidade) e duas unidades com sabores diferentes nunca se misturam. `unit` é um código curto que só serve para as linhas não se confundirem.
export const flavoredKeys = (cart: Cart, productId: string): string[] =>
  Object.keys(cart).filter((key) => {
    const parsed = parseLineKey(key);
    return parsed?.productId === productId && parsed.flavors !== null;
  });

export function addFlavoredLine(cart: Cart, productId: string, picks: readonly FlavorPick[], unit: string, swapTo: string | null = null): Cart {
  const normalized = normalizePicks(picks);
  if (!normalized.length) return cart;
  return put(cart, lineKey(productId, null, swapTo, { unit, picks: normalized }), 1);
}

// Troca os sabores de UMA linha (a linha fica no mesmo lugar do pedido e mantém o código da unidade e o energético trocado).
export function setLineFlavors(cart: Cart, key: string, picks: readonly FlavorPick[]): Cart {
  const parsed = parseLineKey(key);
  const normalized = normalizePicks(picks);
  if (!parsed || !(key in cart) || !normalized.length) return cart;
  // Linha que ainda não tinha sabores (combo guardado antes de existirem os gelos): uma unidade dela vira a unidade com escolha, no mesmo lugar; as outras (se
  // havia mais de uma) continuam sem escolha, para cada uma ganhar a sua.
  if (!parsed.flavors) {
    const qty = cart[key];
    const unit = `u${Math.abs(hash(key)).toString(36)}`;
    const target = lineKey(parsed.productId, null, parsed.swapTo, { unit, picks: normalized });
    if (qty > 1) return put({ ...cart, [key]: qty - 1 }, target, 1);
    return renameKey(cart, key, target);
  }
  return renameKey(cart, key, lineKey(parsed.productId, null, parsed.swapTo, { unit: parsed.unit as string, picks: normalized }));
}

const hash = (text: string): number => {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
};

// Muda o nome de uma chave sem mudar a ordem das linhas no pedido.
function renameKey(cart: Cart, from: string, to: string): Cart {
  if (from === to) return cart;
  const next: Cart = {};
  for (const [key, qty] of Object.entries(cart)) {
    if (key === from) next[to] = (next[to] ?? 0) + qty;
    else next[key] = (next[key] ?? 0) + qty;
  }
  return next;
}

// ---- Troca de energético (combos) ----------------------------------------------------------------
// Passa `delta` unidades do combo entre a linha normal ("id") e a linha com o energético trocado ("id@energético"):
// delta > 0 troca (só dá para trocar o que está na linha normal); delta < 0 devolve ao energético original.
// Num combo com gelos saborizados cada unidade é uma linha própria: a troca muda só o energético da linha, e a escolha de sabores fica.
export function swapUnits(cart: Cart, productId: string, energeticId: string, delta: number): Cart {
  const plain = lineKey(productId, null);
  const swapped = lineKey(productId, null, energeticId);
  let next = cart;
  let left = Math.abs(delta);
  for (const key of flavoredKeys(cart, productId)) {
    if (left <= 0) break;
    const parsed = parseLineKey(key);
    if (!parsed?.flavors || !parsed.unit) continue;
    if (delta > 0 && parsed.swapTo === null) {
      next = renameKey(next, key, lineKey(productId, null, energeticId, { unit: parsed.unit, picks: parsed.flavors }));
      left -= 1;
    } else if (delta < 0 && parsed.swapTo === energeticId) {
      next = renameKey(next, key, lineKey(productId, null, null, { unit: parsed.unit, picks: parsed.flavors }));
      left -= 1;
    }
  }
  if (left <= 0) return next;
  if (delta > 0) {
    const move = Math.min(left, next[plain] ?? 0);
    if (move <= 0) return next;
    return put(put(next, plain, (next[plain] ?? 0) - move), swapped, (next[swapped] ?? 0) + move);
  }
  const move = Math.min(left, next[swapped] ?? 0);
  if (move <= 0) return next;
  return put(put(next, swapped, (next[swapped] ?? 0) - move), plain, (next[plain] ?? 0) + move);
}

// Quantas unidades do combo estão com o energético `energeticId` e quantas ainda estão com o energético original.
export const swappedCount = (cart: Cart, productId: string, energeticId: string): number =>
  (cart[lineKey(productId, null, energeticId)] ?? 0) + flavoredKeys(cart, productId).filter((key) => parseLineKey(key)?.swapTo === energeticId).length;
export const plainCount = (cart: Cart, productId: string): number =>
  (cart[lineKey(productId, null)] ?? 0) + flavoredKeys(cart, productId).filter((key) => parseLineKey(key)?.swapTo === null).length;

// Muda o total de unidades de um produto (o contador do cartão do produto): aumentar entra na linha normal; diminuir tira primeiro da linha
// normal, depois das de gelo e por fim das de energético trocado.
export function setProductTotal(cart: Cart, productId: string, total: number): Cart {
  const current = countFor(cart, productId);
  if (total === current) return cart;
  if (total > current) return put(cart, productId, (cart[productId] ?? 0) + (total - current));
  const rank = (key: string) => (parseLineKey(key)?.swapTo ? 2 : parseLineKey(key)?.ice ? 1 : 0);
  const keys = Object.keys(cart)
    .filter((key) => parseLineKey(key)?.productId === productId)
    .sort((a, b) => rank(a) - rank(b));
  const next = { ...cart };
  let remove = current - Math.max(0, total);
  for (const key of keys) {
    if (remove <= 0) break;
    const take = Math.min(remove, next[key]);
    if (next[key] - take > 0) next[key] -= take;
    else delete next[key];
    remove -= take;
  }
  return next;
}
