// Única porta de entrada das operadoras de pagamento.
//
// A operadora é a ValidaPay (server/payments/validapay.ts). Ela só liga quando TODAS as variáveis obrigatórias estão no ambiente do
// servidor (VALIDAPAY_ENV, VALIDAPAY_CLIENT_ID, VALIDAPAY_CLIENT_SECRET e VALIDAPAY_WEBHOOK_SECRET; opcional VALIDAPAY_WEBHOOK_TOKEN).
// Sem elas, ou com um valor inválido, o pagamento online fica indisponível: o painel não deixa ligar o "Pix online" e o servidor recusa
// cobranças com um aviso claro. Nada é simulado aqui. Os testes automatizados trocam este módulo, na hora de montar a API de teste,
// por um simulador ou por um servidor ValidaPay falso (tests/): nada disso faz parte do código que vai para produção.
import type { PaymentProvider } from './types.js';
import { validaPayFromEnv } from './validapay.js';
import type { ValidaPaySetup } from './validapay.js';

let setup: ValidaPaySetup | undefined;
const current = (): ValidaPaySetup => (setup ??= validaPayFromEnv(process.env));

export function createProvider(): PaymentProvider | null {
  return current().provider;
}

// O que o painel pode dizer sobre a configuração: só NOMES de variáveis que faltam, nunca valores.
export function describeSetup(): { environment: 'sandbox' | 'production' | null; missing: string[]; note: string | null } {
  const { environment, missing, note } = current();
  return { environment, missing, note };
}
