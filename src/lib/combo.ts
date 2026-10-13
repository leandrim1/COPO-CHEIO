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
