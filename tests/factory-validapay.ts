// SÓ PARA OS TESTES: no lugar de server/payments/factory.ts (o servidor de teste troca um pelo outro ao montar a API com PAYMENTS_SIM=validapay).
// Monta o adaptador REAL da ValidaPay, mas apontado para o servidor ValidaPay FALSO de tests/validapay-fake.mjs. Credenciais fictícias.
import { createValidaPayProvider } from '../server/payments/validapay.js';
import type { PaymentProvider } from '../server/payments/types.js';

export function createProvider(): PaymentProvider | null {
  const base = process.env.FAKE_VALIDAPAY_URL;
  if (!base) return null;
  return createValidaPayProvider({
    environment: process.env.FAKE_VALIDAPAY_ENV === 'production' ? 'production' : 'sandbox',
    clientId: 'client-id-de-teste',
    clientSecret: 'client-secret-de-teste',
    webhookSecret: process.env.FAKE_VALIDAPAY_WEBHOOK_SECRET ?? '',
    webhookToken: process.env.FAKE_VALIDAPAY_WEBHOOK_TOKEN || null,
    apiUrl: base,
    authUrl: `${base}/auth/token`,
    requestTimeoutMs: Number(process.env.FAKE_VALIDAPAY_TIMEOUT_MS ?? 2500),
    // Cartão: identificador público de mentira (o SDK do navegador o usa) e, nos testes, um prazo curto para a cobrança no cartão.
    publicId: process.env.FAKE_VALIDAPAY_PUBLIC_ID === undefined ? 'pub_teste_0001' : process.env.FAKE_VALIDAPAY_PUBLIC_ID || null,
    cardAccount: process.env.FAKE_VALIDAPAY_CARD_ACCOUNT === 'master' ? 'master' : 'merchant',
    cardTimeoutMs: Number(process.env.FAKE_VALIDAPAY_CARD_TIMEOUT_MS ?? 2500),
  });
}

export function describeSetup() {
  return { environment: process.env.FAKE_VALIDAPAY_ENV === 'production' ? ('production' as const) : ('sandbox' as const), missing: [] as string[], note: null };
}
