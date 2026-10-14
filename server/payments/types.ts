// Contrato entre o servidor da loja e uma operadora de pagamento.
//
// É o contrato DA LOJA (o que ela precisa saber e fazer), não o de uma operadora. Cada operadora ganha um adaptador que o cumpre,
// traduzindo para a API dela; nenhum nome de campo, endereço ou regra daqui vem da documentação de uma operadora específica.
// Valores sempre em centavos (inteiros).

export type ChargeStatus = 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed' | 'refunded';

// O que a operadora diz sobre o repasse da comissão (divisão) de uma cobrança.
export type SplitObservation = {
  // applied: repassado · failed: não foi possível repassar · pending: ainda não (ou a operadora não permite saber) · none: a cobrança não informa divisão
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
  // O dinheiro entrou, mas a operadora diz que está em contestação ou foi desfeito (disputa, chargeback): sinalizar para conferência.
  disputed?: boolean;
};

export type CreatePixInput = {
  // Referência da loja para esta tentativa. Volta nos avisos e identifica a cobrança se a resposta da criação se perder.
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

// Cobrança no cartão de crédito. O cartão NUNCA passa por aqui: o navegador troca o cartão por um `cardToken` (SDK da operadora) e é o token que chega.
export type CreateCardInput = {
  // Identificador desta tentativa na loja. Vai à operadora como chave de idempotência: a MESMA tentativa nunca cobra duas vezes.
  paymentId: string;
  orderNumber: number;
  // Valor TOTAL a cobrar (itens + entrega + taxa do cartão), em centavos, calculado no banco.
  amountCents: number;
  cardToken: string;
  deviceId: string;
  customer: { name: string; email: string; document: string; phone: string };
  description: string;
};

export type CardChargeResult = {
  providerChargeId: string;
  // paid: aprovada · declined: recusada pelo banco/operadora (definitivo) · duplicate: a operadora já tinha esta tentativa (a cobrança original é adotada)
  // · processing: a operadora ainda não decidiu (a loja consulta e espera o aviso)
  outcome: 'paid' | 'declined' | 'duplicate' | 'processing';
  providerStatus?: string | null;
  // Motivo da recusa, em texto curto e sem dado do cartão.
  reason?: string | null;
};

// O que o navegador precisa para trocar o cartão por um token (o identificador público da conta não é segredo).
export type CardCheckoutConfig = { publicId: string; environment: 'sandbox' | 'production' };

export type CreatedPix = {
  providerChargeId: string;
  // Pix "copia e cola"; o QR Code é desenhado a partir dele.
  qrPayload: string;
  expiresAt: Date;
  providerStatus?: string | null;
};

// Dados da loja que algumas operadoras pedem em toda consulta (a conta do estabelecimento) ou que ajudam a conferir o repasse.
export type ProviderContext = {
  merchantAccountId?: string | null;
  // A comissão calculada pela loja: com ela o adaptador procura a evidência do repasse (e só confirma se achar).
  commissionCents?: number | null;
};

export type CancelResult = {
  cancelled: boolean;
  // not_cancelable: a cobrança já não está em aberto (paga, vencida ou cancelada) · not_found: a operadora não a conhece
  reason?: 'not_cancelable' | 'not_found';
};

// O que um aviso diz sobre a conta (subconta) do estabelecimento.
export type MerchantObservation = {
  formId: string | null;
  proposalId: string | null;
  // pending: em análise · approved: etapa aprovada (a conta ainda não existe) · rejected: reprovada · confirmed: conta aberta (tem número)
  state: 'pending' | 'approved' | 'rejected' | 'confirmed';
  step: string;
  accountNumber?: string | null;
  documentNumber?: string | null;
  detail?: string | null;
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
  // Aviso sobre a conta do estabelecimento (cadastro da subconta), não sobre uma cobrança.
  merchant?: MerchantObservation | null;
  // Aviso que a loja só registra (não muda nada): o servidor não consulta a operadora por causa dele.
  informational?: boolean;
};

// Uma conta (subconta) que a operadora informa ter, para o dono vincular à loja. Só o que a operadora confirma; documento sempre mascarado.
export type ProviderAccount = {
  accountNumber: string;
  name: string | null;
  documentMasked: string | null;
  // O status como a operadora escreve (a conta só vale com a confirmação oficial: ver `confirmed`).
  status: string;
  confirmed: boolean;
};

export type ProposalReceipt = {
  formId: string;
  // O estado inicial como a operadora escreve (só diagnóstico).
  status: string | null;
};

export type ProposalState = {
  formId: string;
  // As etapas como a operadora escreve (formulário, proposta, documentos): só para o dono acompanhar.
  form: string | null;
  proposal: string | null;
  documents: string | null;
  // Endereço onde o titular envia os documentos (não é guardado: vem da operadora a cada consulta).
  documentsUrl: string | null;
};

// Cadastro e conferência das contas do estabelecimento. Só as operadoras que têm subcontas implementam.
export interface MerchantProvider {
  // sandbox: nada é cobrado de verdade · production: dinheiro e tarifas reais.
  readonly environment: 'sandbox' | 'production';
  // Tarifa de criação da conta, em centavos, conforme a documentação (null: não informada).
  readonly accountCreationFeeCents: number | null;
  listAccounts(): Promise<ProviderAccount[]>;
  // `data` é o formulário já validado pela loja, nos campos que a operadora pede.
  submitProposal(kind: 'pf' | 'pj', data: Record<string, unknown>): Promise<ProposalReceipt>;
  getProposal(formId: string): Promise<ProposalState>;
}

export interface PaymentProvider {
  // Nome interno ('validapay', ...). Fica gravado em cada cobrança e em cada subconta.
  readonly name: string;
  // true: a cobrança pode ser consultada direto na operadora (é assim que o servidor confirma um pagamento).
  // false: só os avisos verificados valem.
  readonly canLookup: boolean;
  createPixCharge(input: CreatePixInput): Promise<CreatedPix>;
  // Cobrança no cartão (só as operadoras que a oferecem). Sem isto, o cartão online não existe para esta operadora.
  createCardCharge?(input: CreateCardInput): Promise<CardChargeResult>;
  readonly cardCheckout?: CardCheckoutConfig | null;
  getCharge(providerChargeId: string, ctx?: ProviderContext): Promise<ChargeSnapshot>;
  // Cancela uma cobrança em aberto na operadora (o QR Code deixa de aceitar pagamento). Sem isto, o Pix vence só quando a operadora quiser.
  cancelCharge?(providerChargeId: string, ctx?: ProviderContext): Promise<CancelResult>;
  // Confere a autenticidade do aviso (assinatura) e o traduz. Lança um erro 'invalid_webhook' se não for autêntico.
  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<WebhookEvent[]>;
  readonly merchant?: MerchantProvider;
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
    // Código e status HTTP que a operadora devolveu, quando há (nunca segredos).
    public code?: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const providerErrorKind = (error: unknown): ProviderErrorKind | null => {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return kind === 'rejected' || kind === 'unavailable' || kind === 'invalid_webhook' || kind === 'malformed_webhook' ? kind : null;
};
