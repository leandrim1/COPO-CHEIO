// Aviso dos combos (pedido do dono da loja): quem adiciona um combo é lembrado de que trocar o energético tem diferença de preço.
// O combo é achado pelo NOME da categoria ("Combos"), sem acento nem diferença de maiúsculas; renomear a categoria para outra coisa desliga o aviso
// (não quebra nada). O mesmo texto também está na descrição dos combos, cadastrada no painel; aqui ele aparece NA HORA DE ADICIONAR e na linha do pedido.
export const COMBO_NOTE = 'CASO QUEIRAM TROCAR O ENERGÉTICO POR OUTRO, PAGAR A DIFERENÇA.';

const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

export const comboNote = (category: string | null | undefined): string | null => (/^combos?$/.test(plain(category ?? '')) ? COMBO_NOTE : null);

// Categoria dos energéticos (a lista que aparece em "QUERO TROCAR O ENERGÉTICO"): o nome começa com "Energético(s)", sem acento nem diferença de
// maiúsculas. "COPÃO COM ENERGÉTICO 2L JACK POWER" NÃO entra (é um copão, e o nome não começa com a palavra).
export const isEnergeticoCategory = (category: string | null | undefined): boolean => /^energeticos?\b/.test(plain(category ?? ''));
