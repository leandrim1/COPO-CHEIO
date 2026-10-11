import { createProvider } from './factory.js';
import type { PaymentProvider } from './types.js';

// A operadora configurada (ou nenhuma). Criada uma vez por instância do servidor.
let cached: PaymentProvider | null | undefined;

export function getProvider(): PaymentProvider | null {
  if (cached === undefined) cached = createProvider();
  return cached;
}

// Sem valores nem segredos: só o que o painel precisa mostrar.
export function providerSummary(): { configured: boolean; name: string | null } {
  const provider = getProvider();
  return { configured: provider !== null, name: provider?.name ?? null };
}

// Formas de pagamento em que o cliente paga pelo site. Espelha is_online_payment() do banco (migration 0014).
const ONLINE_METHODS = new Set(['pix_online']);
export const isOnlineMethod = (code: unknown): boolean => typeof code === 'string' && ONLINE_METHODS.has(code);
