import { money } from './format';

// Aviso dos combos (pedido do dono da loja): quem adiciona um combo é lembrado de que trocar o energético tem diferença de preço.
// O combo é achado pelo NOME da categoria ("Combos"), sem acento nem diferença de maiúsculas; renomear a categoria para outra coisa desliga o aviso
// (não quebra nada). O mesmo texto também está na descrição dos combos, cadastrada no painel; aqui ele aparece NA HORA DE ADICIONAR e na linha do pedido.
export const COMBO_NOTE = 'CASO QUEIRAM TROCAR O ENERGÉTICO POR OUTRO, PAGAR A DIFERENÇA.';

const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

export const comboNote = (category: string | null | undefined): string | null => (/^combos?$/.test(plain(category ?? '')) ? COMBO_NOTE : null);

// Categoria dos energéticos: o nome começa com "Energético(s)", sem acento nem diferença de maiúsculas. "COPÃO COM ENERGÉTICO 2L JACK POWER" NÃO entra
// (é um copão, e o nome não começa com a palavra).
export const isEnergeticoCategory = (category: string | null | undefined): boolean => /^energeticos?\b/.test(plain(category ?? ''));

// "2L" no nome do produto: "2L", "2 L", "2Lt", "2 litros", "2000ml". O número tem de ser exatamente 2: "12L", "2,5L" e "1,2L" NÃO valem.
const TWO_LITERS = /(^|[^0-9.,])(2\s*(l|lt|lts|litro|litros)|2000\s*ml)(?![a-z])/;
export const isTwoLiters = (name: string | null | undefined): boolean => TWO_LITERS.test(plain(name ?? ''));

// Os produtos da lista "QUERO TROCAR O ENERGÉTICO" (pedido do dono): só energéticos de 2L. É energético quem está numa categoria "Energéticos"
// ou tem o nome começando por "Energético"; é de 2L quem tem "2L" no nome. Combos e copões (que só citam o energético no meio do nome) não entram.
export const isEnergetico2L = (product: { name: string; category: string }): boolean =>
  (isEnergeticoCategory(product.category) || /^energeticos?\b/.test(plain(product.name))) && isTwoLiters(product.name);

// ---- Troca do energético (preço) -----------------------------------------------------------------
// As mesmas contas do banco (create_order, migrations 0017 e 0018): a linha do combo trocado custa o combo + a diferença, e a diferença é
// "preço do energético novo − valor do energético que vem no combo", nunca abaixo de zero (se o novo for igual ou mais barato, não há
// desconto nem devolução: o preço do combo se mantém). O preço de cada energético é o de agora (promoção em vigor vale). O banco recalcula
// tudo ao criar o pedido.
type PriceLike = { price: number; promoPrice: number | null };
export type SwapProduct = PriceLike & {
  id: string;
  name: string;
  category: string;
  soldOut: boolean;
  // Combos: o produto do cardápio que é o energético que vem nele (o painel escolhe) e/ou o VALOR dele (quando não é um produto do cardápio).
  swapBaseId: string | null;
  swapBasePrice: number | null;
  // Os energéticos que o cliente pode escolher na troca deste combo (lista do painel). Vazia = qualquer energético de 2L.
  swapOptionIds: string[];
};

const cents = (p: PriceLike) => Math.round((p.promoPrice ?? p.price) * 100);

// A diferença por combo, em reais: o novo menos o valor do que vem no combo, nunca abaixo de zero.
export const swapDifference = (to: PriceLike, basePrice: number): number => Math.max(0, cents(to) - Math.round(basePrice * 100)) / 100;

// O produto do cardápio que é o energético que vem no combo (se o painel escolheu um).
export const swapBaseOf = <T extends SwapProduct>(products: T[], combo: SwapProduct): T | undefined => (combo.swapBaseId ? products.find((p) => p.id === combo.swapBaseId) : undefined);

// O valor do energético que vem no combo: o preço de agora do produto escolhido; senão o valor digitado no painel; senão não há base (null)
// e o combo não aceita troca.
export function swapBasePrice(products: SwapProduct[], combo: SwapProduct): number | null {
  const base = swapBaseOf(products, combo);
  if (base) return cents(base) / 100;
  return combo.swapBasePrice;
}

// Como chamar o energético que vem no combo na tela: o nome do produto ou, se não é um produto do cardápio, o valor dele.
export function swapBaseLabel(products: SwapProduct[], combo: SwapProduct): string {
  const base = swapBaseOf(products, combo);
  if (base) return base.name;
  return combo.swapBasePrice === null ? '' : `energético de ${money(combo.swapBasePrice)}`;
}

// Os energéticos pelos quais o combo pode ser trocado: os que o painel escolheu para ele ou, sem lista, qualquer energético de 2L. Nunca o
// próprio combo nem o energético que já vem nele.
export function swapOptions<T extends SwapProduct>(products: T[], combo: SwapProduct): T[] {
  if (swapBasePrice(products, combo) === null) return [];
  const explicit = combo.swapOptionIds.length > 0;
  return products.filter((p) => p.id !== combo.id && p.id !== combo.swapBaseId && (explicit ? combo.swapOptionIds.includes(p.id) : isEnergetico2L(p)));
}

export const canSwap = <T extends SwapProduct>(products: T[], combo: SwapProduct): boolean => swapOptions(products, combo).length > 0;

// A troca de uma linha do pedido ainda vale? (o combo tem energético/valor definido e o novo ainda está entre as opções)
export function swapStillValid<T extends SwapProduct>(products: T[], comboId: string, toId: string): boolean {
  const combo = products.find((p) => p.id === comboId);
  return Boolean(combo && swapOptions(products, combo).some((p) => p.id === toId));
}
