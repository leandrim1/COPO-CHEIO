// Gelos saborizados dos combos: tipos, textos e as regras puras da escolha (sem React, para poder ser testado à parte).
//
// Um combo que traz gelos (products.combo_ice_count, definido no painel; em geral 4) só vai para o pedido com a escolha dos sabores, entre os produtos que a loja
// marcou como gelo saborizado (products.flavored_ice). Os sabores NUNCA são uma lista fixa do site: vêm do cadastro de produtos. A escolha é por unidade do combo.

export type FlavorPick = { id: string; qty: number };

export const MAX_COMBO_ICES = 12;

export const FLAVORS_REQUIRED_MESSAGE = 'Escolha os sabores dos gelos do combo para continuar.';

export const flavorsTitle = (count: number): string => `Escolha os ${count} gelos saborizados`;
export const flavorsHint = (count: number): string => `Escolha os sabores dos ${count} gelos que acompanham seu combo.`;
export const flavorsCounter = (picked: number, count: number): string => `Gelos selecionados: ${picked} de ${count}`;

export const sumPicks = (picks: readonly FlavorPick[]): number => picks.reduce((sum, p) => sum + p.qty, 0);

// Junta o mesmo sabor numa entrada só, tira o que não tem quantidade e põe em ordem fixa (a mesma escolha sempre vira o mesmo texto).
export function normalizePicks(picks: readonly FlavorPick[]): FlavorPick[] {
  const byId = new Map<string, number>();
  for (const pick of picks) {
    if (!pick || typeof pick.id !== 'string' || !Number.isInteger(pick.qty) || pick.qty <= 0) continue;
    byId.set(pick.id, (byId.get(pick.id) ?? 0) + pick.qty);
  }
  return [...byId].map(([id, qty]) => ({ id, qty })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Na chave do carrinho: "id.qtd+id.qtd" (os ids são UUIDs, que não têm "." nem "+").
export const picksToken = (picks: readonly FlavorPick[]): string =>
  normalizePicks(picks)
    .map((p) => `${p.id}.${p.qty}`)
    .join('+');

export function tokenToPicks(token: string): FlavorPick[] | null {
  if (!token) return null;
  const picks: FlavorPick[] = [];
  for (const part of token.split('+')) {
    const dot = part.lastIndexOf('.');
    const id = part.slice(0, dot);
    const qty = Number(part.slice(dot + 1));
    if (dot < 0 || !ID.test(id) || !Number.isInteger(qty) || qty < 1 || qty > MAX_COMBO_ICES) return null;
    picks.push({ id, qty });
  }
  const normalized = normalizePicks(picks);
  return normalized.length === picks.length && sumPicks(normalized) <= MAX_COMBO_ICES ? normalized : null;
}

export const samePicks = (a: readonly FlavorPick[], b: readonly FlavorPick[]): boolean => picksToken(a) === picksToken(b);

// A escolha de uma unidade do combo, como a API recebe: [{ product_id, quantity }].
export const picksToPayload = (picks: readonly FlavorPick[]): { product_id: string; quantity: number }[] => normalizePicks(picks).map((p) => ({ product_id: p.id, quantity: p.qty }));

// "2 × Morango" (nome do produto como está no cadastro, sem inventar nem abreviar).
export const pickText = (qty: number, name: string): string => `${qty} × ${name}`;
