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
// As mesmas contas do banco (create_order, migration 0017): a linha do combo trocado custa o combo + a diferença, e a diferença é
// "preço do energético novo − preço do que vem no combo", nunca abaixo de zero (se o novo for igual ou mais barato, não há desconto
// nem devolução). O preço de cada energético é o de agora (promoção em vigor vale). O banco recalcula tudo ao criar o pedido.
type PriceLike = { price: number; promoPrice: number | null };
export type SwapProduct = PriceLike & { id: string; name: string; category: string; swapBaseId: string | null; soldOut: boolean };

const cents = (p: PriceLike) => Math.round((p.promoPrice ?? p.price) * 100);

export const swapDifference = (to: PriceLike, base: PriceLike): number => Math.max(0, cents(to) - cents(base)) / 100;

// O energético que vem no combo (o painel define em cada produto) e os energéticos de 2L pelos quais ele pode ser trocado.
export const swapBaseOf = <T extends SwapProduct>(products: T[], combo: SwapProduct): T | undefined => (combo.swapBaseId ? products.find((p) => p.id === combo.swapBaseId) : undefined);

export function swapOptions<T extends SwapProduct>(products: T[], combo: SwapProduct): T[] {
  const base = swapBaseOf(products, combo);
  return base ? products.filter((p) => p.id !== base.id && isEnergetico2L(p)) : [];
}

export const canSwap = <T extends SwapProduct>(products: T[], combo: SwapProduct): boolean => swapOptions(products, combo).length > 0;

// A troca de uma linha do pedido ainda vale? (o combo tem energético definido e o novo ainda existe, é de 2L e é outro produto)
export function swapStillValid<T extends SwapProduct>(products: T[], comboId: string, toId: string): boolean {
  const combo = products.find((p) => p.id === comboId);
  const to = products.find((p) => p.id === toId);
  const base = combo ? swapBaseOf(products, combo) : undefined;
  return Boolean(combo && to && base && to.id !== base.id && isEnergetico2L(to));
}
