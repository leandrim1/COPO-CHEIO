import type { PublicOrder } from './types';

// Pedido recém-criado: a página de confirmação abre na hora, sem esperar outra consulta.
export const orderCache = new Map<string, PublicOrder>();
export const seedOrder = (token: string, order: PublicOrder) => orderCache.set(token, order);
