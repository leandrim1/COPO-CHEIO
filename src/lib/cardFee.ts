// Taxa de processamento do cartão que o cliente paga (cálculo em centavos inteiros, sem ponto flutuante).
//
//   total = arredondar((base + tarifa fixa) / (1 − percentual))          taxa do cliente = total − base
//
// É a MESMA conta de card_fee_cents() no banco (migration 0020) e de server/payments/cardFee.ts. O banco é quem cobra de verdade
// (create_order); esta cópia só serve para mostrar o resumo na tela enquanto a pessoa mexe no pedido, e o servidor confere o total de novo. Metade do centavo
// arredonda para cima. Exemplo: base R$ 100,00, 5,37% e R$ 0,37 → total R$ 106,07 e taxa R$ 6,07 (a ValidaPay desconta 5,37% de 106,07 = 5,70,
// mais 0,37 = 6,07, e sobram exatamente os R$ 100,00).
//
// A diferença de um centavo entre a taxa que o cliente paga e a tarifa que a operadora desconta é esperada (a operadora arredonda a parte
// percentual por conta própria): a loja aceita até 1 centavo e sinaliza o que passar disso (ver FEE_TOLERANCE_CENTS).

export type CardFeeConfig = { bps: number; fixedCents: number };

// Limites de bom senso (iguais às restrições da tabela payment_fee_settings).
export const MAX_FEE_BPS = 2500;
export const MAX_FIXED_CENTS = 1000;
// Diferença aceita, em centavos, entre a taxa cobrada do cliente e a tarifa informada pela operadora.
export const FEE_TOLERANCE_CENTS = 1;

const isCount = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

export function cardTotalCents(baseCents: number, config: CardFeeConfig): number {
  if (!Number.isSafeInteger(baseCents) || baseCents <= 0) throw new RangeError('base inválida');
  if (!isCount(config.bps, MAX_FEE_BPS) || !isCount(config.fixedCents, MAX_FIXED_CENTS)) throw new RangeError('taxa inválida');
  const denominator = BigInt(10000 - config.bps);
  const numerator = (BigInt(baseCents) + BigInt(config.fixedCents)) * 10000n;
  // Arredondar N/D para o centavo mais próximo, metade para cima: floor((2N + D) / 2D).
  return Number((2n * numerator + denominator) / (2n * denominator));
}

export const cardFeeCents = (baseCents: number, config: CardFeeConfig): number => cardTotalCents(baseCents, config) - baseCents;

// "5,37" ou "5.37" (por cento) → pontos-base (537). null se não for um percentual válido com até duas casas.
export function parsePercentToBps(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace('%', '').trim() : '';
  const match = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || 0);
  return bps <= MAX_FEE_BPS ? bps : null;
}

// "0,37" ou "0.37" (reais) → centavos (37). null se não for um valor válido com até duas casas.
export function parseMoneyToCents(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(/^R\$\s*/i, '') : '';
  const match = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || 0);
  return cents <= MAX_FIXED_CENTS ? cents : null;
}

// ---- Pix online: taxa de serviço (o cliente paga 2,5%; o estabelecimento outros 2,5%; os 5% vão para a master) ------------------------------------------
// Parte de um valor em pontos-base (250 = 2,5%), em centavos inteiros; metade do centavo arredonda para cima. É a MESMA conta de service_fee_cents() no banco.
export const MAX_SERVICE_BPS = 1000;

export function serviceFeeCents(baseCents: number, bps: number): number {
  if (!Number.isSafeInteger(baseCents) || baseCents < 0) throw new RangeError('base inválida');
  if (!isCount(bps, MAX_SERVICE_BPS)) throw new RangeError('percentual inválido');
  return Number((BigInt(baseCents) * BigInt(bps) + 5000n) / 10000n);
}
