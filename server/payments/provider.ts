import { createProvider, describeSetup } from './factory.js';
import type { PaymentProvider } from './types.js';

// A operadora configurada (ou nenhuma). Criada uma vez por instância do servidor.
let cached: PaymentProvider | null | undefined;

export function getProvider(): PaymentProvider | null {
  if (cached === undefined) cached = createProvider();
  return cached;
}

// Sem valores nem segredos: só o que o painel precisa mostrar (inclusive o NOME das variáveis que faltam).
export function providerSummary(): {
  configured: boolean;
  name: string | null;
  environment: 'sandbox' | 'production' | null;
  missing: string[];
  note: string | null;
  manages_accounts: boolean;
  // O cartão online existe para esta operadora (ela cobra no cartão e há o identificador público para o SDK do navegador).
  card_ready: boolean;
} {
  const provider = getProvider();
  const setup = describeSetup();
  return {
    configured: provider !== null,
    name: provider?.name ?? null,
    environment: provider?.merchant?.environment ?? setup.environment,
    missing: setup.missing,
    note: setup.note,
    manages_accounts: Boolean(provider?.merchant),
    card_ready: Boolean(provider?.createCardCharge && provider.cardCheckout),
  };
}

// Formas de pagamento em que o cliente paga pelo site. Espelha is_online_payment() do banco (migration 0014).
const ONLINE_METHODS = new Set(['pix_online', 'card_online']);
export const isOnlineMethod = (code: unknown): boolean => typeof code === 'string' && ONLINE_METHODS.has(code);
