// O pacote oficial da ValidaPay (@validapay/tokenize) não traz tipos. Aqui está só o que a loja usa, conforme o código do pacote (versão 1.3.1).
declare module '@validapay/tokenize/browser' {
  export class ValidaPayError extends Error {
    code: string;
    details: unknown;
  }
  // Abre a sessão de pagamento (POST /v1/payment-sessions) e põe o script de antifraude na página; devolve o identificador do dispositivo.
  export function collectDevice(input: { publicId: string; environment?: 'production' | 'sandbox' }): Promise<{ deviceId: string | null }>;
  // Troca o cartão por um token de uso único (vale 5 minutos). O número e o CVV vão direto do navegador para a ValidaPay.
  export function tokenize(input: {
    publicId: string;
    environment?: 'production' | 'sandbox';
    card: { number: string; holderName: string; cvv: string; expiration: string };
    customer: { document: string; name: string; email: string };
  }): Promise<{ cardToken: string; cardTokenExpiresAt: string; cardBrand: string; cardLastFour: string }>;
}
