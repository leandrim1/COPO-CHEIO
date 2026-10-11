// Contrato entre o servidor da loja e uma operadora de pagamento.
//
// É o contrato DA LOJA (o que ela precisa saber e fazer), não o de uma operadora. Cada operadora ganha um adaptador que o cumpre,
// traduzindo para a API dela; nenhum nome de campo, endereço ou regra daqui vem da documentação de uma operadora específica.
// Valores sempre em centavos (inteiros).

export type ChargeStatus = 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed' | 'refunded';

// O que a operadora diz sobre o repasse da comissão (divisão) de uma cobrança.
export type SplitObservation = {
  // applied: repassado · failed: não foi possível repassar · pending: ainda não · none: a cobrança não informa divisão
  state: 'applied' | 'failed' | 'pending' | 'none';
  // Valor que a operadora confirma ter repassado à conta master, quando ela informa. É a evidência da comissão efetivada.
  commissionCents?: number | null;
  detail?: string | null;
};

// A cobrança como a operadora a descreve numa consulta ou num aviso.
export type ChargeSnapshot = {
  providerChargeId: string;
  status: ChargeStatus;
  // O status como a operadora escreve (só para diagnóstico).
  providerStatus?: string | null;
  amountCents: number | null;
  feeCents?: number | null;
  netCents?: number | null;
  paidAt?: Date | null;
  refundedCents?: number | null;
  split?: SplitObservation | null;
  detail?: string | null;
};

export type CreatePixInput = {
  // Referência da loja para esta tentativa; também serve de chave de idempotência.
  paymentId: string;
  orderNumber: number;
  amountCents: number;
  // Parcela da conta master (a comissão), em centavos, conforme o modelo de divisão da operadora.
  commissionCents: number;
  // Identificador da conta (subconta) do estabelecimento na operadora.
  merchantAccountId: string;
  expiresInSeconds: number;
  description: string;
};

export type CreatedPix = {
  providerChargeId: string;
  // Pix "copia e cola"; o QR Code é desenhado a partir dele.
  qrPayload: string;
  expiresAt: Date;
  providerStatus?: string | null;
};

// Um aviso (webhook) depois de verificado e traduzido.
export type WebhookEvent = {
  // Identificador do aviso na operadora; sem ele, um resumo do conteúdo. Dois avisos iguais têm a mesma chave.
  dedupeKey: string;
  type: string;
  providerChargeId: string | null;
  // A referência da loja (PaymentId), se a operadora a devolve.
  reference: string | null;
  // O que o aviso diz da cobrança. É só uma dica: o servidor confirma na operadora quando ela permite consulta.
  snapshot: ChargeSnapshot | null;
};

export interface PaymentProvider {
  // Nome interno ('validapay', ...). Fica gravado em cada cobrança e em cada subconta.
  readonly name: string;
  // true: a cobrança pode ser consultada direto na operadora (é assim que o servidor confirma um pagamento).
  // false: só os avisos verificados valem.
  readonly canLookup: boolean;
  createPixCharge(input: CreatePixInput): Promise<CreatedPix>;
  getCharge(providerChargeId: string): Promise<ChargeSnapshot>;
  // Confere a autenticidade do aviso (assinatura) e o traduz. Lança um erro 'invalid_webhook' se não for autêntico.
  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<WebhookEvent[]>;
}

// Erros dos adaptadores. Identificados por `kind` (e não por classe) para um adaptador poder viver em outro módulo.
//  • rejected: a operadora recusou o pedido (dados inválidos, conta sem permissão...). Definitivo: tentar igual não adianta.
//  • unavailable: sem resposta, tempo esgotado ou erro dela. Ambíguo: pode ou não ter criado a cobrança.
//  • invalid_webhook: o aviso não é autêntico (assinatura ausente ou errada).
//  • malformed_webhook: o aviso é autêntico, mas o conteúdo não faz sentido.
export type ProviderErrorKind = 'rejected' | 'unavailable' | 'invalid_webhook' | 'malformed_webhook';

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const providerErrorKind = (error: unknown): ProviderErrorKind | null => {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return kind === 'rejected' || kind === 'unavailable' || kind === 'invalid_webhook' || kind === 'malformed_webhook' ? kind : null;
};
