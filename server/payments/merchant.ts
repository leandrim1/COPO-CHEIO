// Conta (subconta) do estabelecimento na operadora de pagamento: vincular uma conta que já existe, cadastrar uma nova e acompanhar o status.
//
// Regras (do pedido do dono do projeto e da documentação da ValidaPay):
// • NENHUMA conta é criada sozinha. Só o owner, por uma ação explícita, com a autorização do titular confirmada e (em produção) a ciência da
//   tarifa de criação (R$ 15,00 debitados da conta master). Em sandbox nada é cobrado.
// • O identificador definitivo da subconta só entra depois da CONFIRMAÇÃO OFICIAL: o aviso assinado onboarding.create (status CONFIRMED com o
//   número da conta) ou a conta aparecendo CONFIRMADA na listagem oficial da operadora (vínculo). Nunca por um aviso de etapa ("aprovado").
// • Sem duplicar: o banco só deixa existir um cadastro ativo por operadora, o cadastro é reservado ANTES de falar com a operadora, e se ela
//   não responder (a proposta pode ter sido criada e cobrada) uma nova tentativa exige confirmação explícita.
// • Os dados pessoais do titular vão direto para a operadora: não são gravados aqui nem vão para o log ou para o histórico de atividades.
import { audit } from '../audit.js';
import { one, query } from '../db.js';
import type { Row } from '../db.js';
import { HttpError } from '../http.js';
import type { Ctx } from '../http.js';
import { getProvider } from './provider.js';
import { providerErrorKind } from './types.js';
import type { MerchantObservation, MerchantProvider, PaymentProvider, ProviderAccount } from './types.js';

export type MerchantRow = {
  id: string;
  provider: string;
  kind: 'pf' | 'pj' | null;
  status: string;
  status_detail: string | null;
  proposal_id: string | null;
  provider_account_id: string | null;
  ambiguous: boolean;
  authorized_at: string | null;
  fees_acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
};

function manager(): { provider: PaymentProvider; merchant: MerchantProvider } {
  const provider = getProvider();
  if (!provider?.merchant) throw new HttpError(409, 'A operadora de pagamento não está conectada neste servidor.', { code: 'payments_unavailable' });
  return { provider, merchant: provider.merchant };
}

// ---- Avisos (webhooks) --------------------------------------------------------------------------------------------------------------

const STEP_LABEL: Record<string, string> = {
  backgroundcheck: 'análise de background',
  documentscopy: 'conferência de documentos',
  proposal: 'proposta',
};

// Aplica um aviso de cadastro (já verificado pelo adaptador) ao cadastro que o dono iniciou. Nunca cria cadastro: aviso de uma proposta
// que a loja não conhece é só registrado. Devolve o desfecho para o histórico de avisos.
export async function applyMerchantObservation(providerName: string, obs: MerchantObservation): Promise<string> {
  if (!obs.formId) return 'ignored';
  const step = STEP_LABEL[obs.step] ?? obs.step;
  let status: 'pending' | 'approved' | 'rejected';
  let detail: string;
  if (obs.state === 'confirmed') {
    status = 'approved';
    detail = 'Conta aberta e confirmada pela ValidaPay.';
  } else if (obs.state === 'rejected') {
    status = 'rejected';
    detail = `Reprovado na ${step}.`;
  } else if (obs.state === 'approved') {
    status = 'pending';
    detail = obs.step === 'proposal' ? 'Proposta aprovada; aguardando a abertura da conta.' : `Etapa aprovada: ${step}.`;
  } else {
    status = 'pending';
    detail = obs.detail ?? `Em análise: ${step}.`;
  }
  try {
    const row = await one<Row>(
      `update merchant_accounts
          set status = $3,
              status_detail = left($4, 500),
              provider_account_id = case when $3 = 'approved' then $5 else provider_account_id end
        where provider = $1 and proposal_id = $2 and status in ('submitted', 'pending')
        returning id, status`,
      [providerName, obs.formId, status, detail, obs.state === 'confirmed' ? obs.accountNumber : null],
    );
    if (row) {
      await audit(
        { admin: null, ip: 'unknown' },
        { action: 'merchant.status', summary: `Conta do estabelecimento na operadora: ${status === 'approved' ? 'aprovada' : status === 'rejected' ? 'reprovada' : 'em análise'}`, entity: 'merchant_account', entityId: String(row.id), details: { step: obs.step, state: obs.state } },
      );
      return 'applied';
    }
    const known = await one<Row>('select id from merchant_accounts where provider = $1 and proposal_id = $2', [providerName, obs.formId]);
    return known ? 'stale' : 'unknown_proposal';
  } catch {
    // Violação de unicidade (já há uma conta aprovada, ou o número já está em outro cadastro): não aprova nada, o dono confere.
    return 'conflict';
  }
}

// ---- Vincular uma conta que já existe ------------------------------------------------------------------------------------------------

export async function listCandidates(): Promise<Array<ProviderAccount & { linked: boolean }>> {
  const { merchant } = manager();
  let accounts: ProviderAccount[];
  try {
    accounts = await merchant.listAccounts();
  } catch (error) {
    throw new HttpError(503, 'A operadora não respondeu ao listar as contas. Tente de novo em instantes.', { code: providerErrorKind(error) ?? 'provider_unavailable' });
  }
  const linked = await query<{ provider_account_id: string }>('select provider_account_id from merchant_accounts where provider_account_id is not null');
  const used = new Set(linked.map((row) => row.provider_account_id));
  return accounts.map((account) => ({ ...account, linked: used.has(account.accountNumber) }));
}

type Authorization = { authorized: boolean; feesAcknowledged: boolean };

function requireAuthorization(merchant: MerchantProvider, input: Authorization, charging: boolean): void {
  if (!input.authorized) throw new HttpError(400, 'Confirme que o titular da conta autorizou este cadastro.', { code: 'authorization_required' });
  if (merchant.environment === 'production' && !input.feesAcknowledged) {
    throw new HttpError(
      400,
      charging
        ? 'Em produção, confirme que você conhece e aceita as tarifas da ValidaPay, inclusive a de criação da conta (R$ 15,00).'
        : 'Em produção, confirme que você conhece e aceita as tarifas da ValidaPay.',
      { code: 'fees_ack_required' },
    );
  }
}

export async function linkAccount(ctx: Ctx, accountNumber: string, input: Authorization): Promise<MerchantRow> {
  const { provider, merchant } = manager();
  requireAuthorization(merchant, input, false);
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(accountNumber)) throw new HttpError(400, 'Número de conta inválido.');
  let accounts: ProviderAccount[];
  try {
    accounts = await merchant.listAccounts();
  } catch (error) {
    throw new HttpError(503, 'A operadora não respondeu. Tente de novo em instantes.', { code: providerErrorKind(error) ?? 'provider_unavailable' });
  }
  const found = accounts.find((account) => account.accountNumber === accountNumber);
  if (!found || !found.confirmed) {
    throw new HttpError(409, 'Esta conta não está na lista oficial da operadora, ou ainda não foi confirmada por ela.', { code: 'account_not_confirmed' });
  }
  const row = await one<MerchantRow>(
    `insert into merchant_accounts (provider, kind, status, status_detail, provider_account_id, authorized_by, authorized_at, fees_acknowledged_at, fees_snapshot)
     values ($1, null, 'approved', 'Conta existente vinculada e confirmada na lista oficial da operadora.', $2, $3, now(), case when $4 then now() end, $5::jsonb)
     on conflict do nothing
     returning id, provider, kind, status, status_detail, proposal_id, provider_account_id, ambiguous, authorized_at, fees_acknowledged_at, created_at, updated_at`,
    [provider.name, accountNumber, ctx.admin?.id ?? null, input.feesAcknowledged, JSON.stringify({ environment: merchant.environment, via: 'link' })],
  );
  if (!row) throw new HttpError(409, 'Já existe uma conta em cadastro ou aprovada para esta operadora, ou este número já está vinculado.', { code: 'account_conflict' });
  await audit(ctx, { action: 'merchant.link', summary: 'Vinculou uma conta existente da operadora como a conta do estabelecimento', entity: 'merchant_account', entityId: row.id, details: { environment: merchant.environment } });
  return row;
}

// ---- Cadastrar uma conta nova --------------------------------------------------------------------------------------------------------

export type ProposalInput = Authorization & { kind: 'pf' | 'pj'; confirmDuplicateRisk: boolean; form: unknown };

const INCOME_PF = ['DINP01', 'DINP02', 'DINP03', 'DINP04', 'DINP05'];
const NET_WORTH_PF = ['NWNP01', 'NWNP02', 'NWNP03', 'NWNP04', 'NWNP05'];
const OCCUPATION_PF = Array.from({ length: 31 }, (_v, i) => `ONP${String(i + 1).padStart(2, '0')}`);
const INCOME_OWNER = ['ODIB01', 'ODIB02', 'ODIB03', 'ODIB04', 'ODIB05'];
const REVENUE_OWNER = ['ODRB01', 'ODRB02', 'ODRB03', 'ODRB04', 'ODRB05'];
const COMPANY_TYPES = ['PJ', 'MEI', 'ME'];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const digitsOf = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\D/g, '') : '');

export function validCpf(input: string): boolean {
  if (!/^\d{11}$/.test(input) || /^(\d)\1{10}$/.test(input)) return false;
  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(input[i]) * (size + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(input[size])) return false;
  }
  return true;
}

export function validCnpj(input: string): boolean {
  if (!/^\d{14}$/.test(input) || /^(\d)\1{13}$/.test(input)) return false;
  for (const size of [12, 13]) {
    const weights = size === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(input[i]) * weights[i];
    const digit = sum % 11 < 2 ? 0 : 11 - (sum % 11);
    if (digit !== Number(input[size])) return false;
  }
  return true;
}

type Errors = Record<string, string>;

class FormReader {
  constructor(
    private source: Record<string, unknown>,
    private prefix = '',
    // Os blocos (endereço, dados financeiros...) escrevem os erros na mesma lista do formulário.
    public errors: Errors = {},
  ) {}
  fail(key: string, message: string) {
    this.errors[this.prefix + key] = message;
  }
  text(key: string, label: string, opts: { min?: number; max?: number; optional?: boolean; allowEmpty?: boolean } = {}): string {
    const raw = this.source[key];
    const value = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    if (value === '' && opts.allowEmpty) return '';
    if (value === '' && opts.optional) return '';
    if (value.length < (opts.min ?? 1) || value.length > (opts.max ?? 120)) this.fail(key, `Informe ${label}.`);
    return value;
  }
  email(key: string, label: string): string {
    const value = typeof this.source[key] === 'string' ? (this.source[key] as string).trim().toLowerCase() : '';
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(value) || value.length > 254) this.fail(key, `Informe ${label} válido.`);
    return value;
  }
  // Telefone brasileiro (DDD + 8 ou 9 dígitos), em formato E.164.
  phone(key: string, label: string): string {
    let digits = digitsOf(this.source[key]);
    if (digits.length >= 12 && digits.startsWith('55')) digits = digits.slice(2);
    if (!/^[1-9]\d[2-9]\d{7,8}$/.test(digits) || digits.length < 10 || digits.length > 11) this.fail(key, `Informe ${label} com DDD.`);
    return `+55${digits}`;
  }
  cpf(key: string, label: string): string {
    const digits = digitsOf(this.source[key]);
    if (!validCpf(digits)) this.fail(key, `Informe ${label} válido.`);
    return digits;
  }
  cnpj(key: string, label: string): string {
    const digits = digitsOf(this.source[key]);
    if (!validCnpj(digits)) this.fail(key, `Informe ${label} válido.`);
    return digits;
  }
  // Data de nascimento: aceita AAAA-MM-DD (campo de data) ou DD-MM-AAAA / DD/MM/AAAA; a operadora recebe DD-MM-AAAA. Maior de idade.
  birthDate(key: string): string {
    const raw = typeof this.source[key] === 'string' ? (this.source[key] as string).trim() : '';
    let y = 0;
    let m = 0;
    let d = 0;
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const br = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(raw);
    if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    else if (br) [d, m, y] = [Number(br[1]), Number(br[2]), Number(br[3])];
    const date = new Date(Date.UTC(y, m - 1, d));
    const real = y > 1900 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
    const eighteen = new Date(Date.UTC(y + 18, m - 1, d)).getTime() <= Date.now();
    if (!real || !eighteen) {
      this.fail(key, 'Informe uma data de nascimento válida (maior de 18 anos).');
      return '';
    }
    return `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}`;
  }
  bool(key: string): boolean {
    const value = this.source[key];
    if (typeof value !== 'boolean') this.fail(key, 'Responda sim ou não.');
    return value === true;
  }
  code(key: string, allowed: string[], label: string): string {
    const value = typeof this.source[key] === 'string' ? (this.source[key] as string) : '';
    if (!allowed.includes(value)) this.fail(key, `Escolha ${label}.`);
    return value;
  }
  object(key: string): Record<string, unknown> {
    const value = this.source[key];
    if (!isObject(value)) this.fail(key, 'Preencha este bloco.');
    return isObject(value) ? value : {};
  }
  child(key: string): FormReader {
    return new FormReader(this.object(key), `${this.prefix}${key}.`, this.errors);
  }
}

function addressBody(reader: FormReader): Record<string, string> {
  const state = reader.text('state', 'a UF (2 letras)', { min: 2, max: 2 }).toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) reader.fail('state', 'Informe a UF com 2 letras.');
  const cep = digitsOf(reader.text('postalCode', 'o CEP', { min: 8, max: 9 }));
  if (cep.length !== 8) reader.fail('postalCode', 'Informe o CEP com 8 números.');
  return {
    postalCode: cep,
    street: reader.text('street', 'a rua'),
    number: reader.text('number', 'o número', { max: 20 }),
    // O campo é obrigatório para a operadora, mas pode ir vazio.
    addressComplement: reader.text('addressComplement', 'o complemento', { allowEmpty: true, max: 80 }),
    neighborhood: reader.text('neighborhood', 'o bairro'),
    city: reader.text('city', 'a cidade'),
    state,
  };
}

// O formulário do owner → o corpo que a operadora pede (campos do contrato oficial, validados com a própria ferramenta de validação da
// ValidaPay). Tudo é conferido aqui antes de qualquer envio: formulário inválido nunca chega à operadora (e nunca custa tarifa).
export function buildProposalBody(kind: 'pf' | 'pj', form: unknown): Record<string, unknown> {
  if (!isObject(form)) throw new HttpError(400, 'Preencha o formulário.', { code: 'invalid_form', fields: {} });
  const r = new FormReader(form);
  let body: Record<string, unknown>;
  if (kind === 'pf') {
    const address = r.child('address');
    const financial = r.child('financialDetails');
    body = {
      documentNumber: r.cpf('documentNumber', 'o CPF'),
      phoneNumber: r.phone('phoneNumber', 'o telefone celular'),
      email: r.email('email', 'o e-mail'),
      motherName: r.text('motherName', 'o nome da mãe'),
      fullName: r.text('fullName', 'o nome completo', { min: 5 }),
      socialName: r.text('socialName', 'o nome social', { optional: true, allowEmpty: true }),
      birthDate: r.birthDate('birthDate'),
      address: addressBody(address),
      isPoliticallyExposedPerson: r.bool('isPoliticallyExposedPerson'),
      financialDetails: {
        declaredIncome: financial.code('declaredIncome', INCOME_PF, 'a renda mensal'),
        occupation: financial.code('occupation', OCCUPATION_PF, 'a ocupação'),
        netWorth: financial.code('netWorth', NET_WORTH_PF, 'o patrimônio'),
      },
    };
  } else {
    const owner = r.child('owner');
    const ownerAddress = owner.child('address');
    const ownerFinancial = owner.child('financialOwnerDetails');
    const businessAddress = r.child('businessAddress');
    body = {
      contactNumber: r.phone('contactNumber', 'o telefone da empresa'),
      documentNumber: r.cnpj('documentNumber', 'o CNPJ'),
      businessEmail: r.email('businessEmail', 'o e-mail da empresa'),
      businessName: r.text('businessName', 'a razão social', { min: 3 }),
      tradingName: r.text('tradingName', 'o nome fantasia', { min: 2 }),
      companyType: r.code('companyType', COMPANY_TYPES, 'o tipo da empresa'),
      owner: [
        {
          ownerType: 'SOCIO',
          documentNumber: owner.cpf('documentNumber', 'o CPF do sócio'),
          fullName: owner.text('fullName', 'o nome completo do sócio', { min: 5 }),
          phoneNumber: owner.phone('phoneNumber', 'o telefone celular do sócio'),
          email: owner.email('email', 'o e-mail do sócio'),
          motherName: owner.text('motherName', 'o nome da mãe do sócio'),
          // A operadora exige o nome social do sócio na proposta de empresa.
          socialName: owner.text('socialName', 'o nome social do sócio'),
          birthDate: owner.birthDate('birthDate'),
          address: addressBody(ownerAddress),
          isPoliticallyExposedPerson: owner.bool('isPoliticallyExposedPerson'),
          financialOwnerDetails: {
            ownerDeclaredIncome: ownerFinancial.code('ownerDeclaredIncome', INCOME_OWNER, 'a renda do sócio'),
            ownerDeclaredRevenue: ownerFinancial.code('ownerDeclaredRevenue', REVENUE_OWNER, 'o faturamento da empresa'),
          },
        },
      ],
      businessAddress: addressBody(businessAddress),
    };
  }
  if (Object.keys(r.errors).length) throw new HttpError(400, 'Confira os campos destacados.', { code: 'invalid_form', fields: r.errors });
  return body;
}

export async function latestMerchant(providerName: string): Promise<MerchantRow | null> {
  return one<MerchantRow>(
    `select id, provider, kind, status, status_detail, proposal_id, provider_account_id, ambiguous, authorized_at, fees_acknowledged_at, created_at, updated_at
       from merchant_accounts where provider = $1 order by (status in ('draft','submitted','pending','approved')) desc, created_at desc limit 1`,
    [providerName],
  );
}

export async function submitProposal(ctx: Ctx, input: ProposalInput): Promise<MerchantRow> {
  const { provider, merchant } = manager();
  requireAuthorization(merchant, input, true);
  // 1) Tudo conferido ANTES de reservar ou enviar: formulário inválido nunca vira cadastro nem tarifa.
  const body = buildProposalBody(input.kind, input.form);
  // 2) Uma tentativa anterior sem resposta pode ter criado a proposta (e cobrado): só segue com a confirmação explícita.
  const last = await one<{ ambiguous: boolean }>('select ambiguous from merchant_accounts where provider = $1 order by created_at desc limit 1', [provider.name]);
  if (last?.ambiguous && !input.confirmDuplicateRisk) {
    throw new HttpError(409, 'A tentativa anterior ficou sem resposta da operadora e o cadastro pode ter sido criado (e cobrado). Confira na ValidaPay antes de enviar de novo e confirme.', { code: 'confirm_duplicate_risk' });
  }
  // 3) Reserva o cadastro no banco (um ativo por operadora): dois cliques ou duas abas não criam duas propostas.
  const reserved = await one<{ id: string }>(
    `insert into merchant_accounts (provider, kind, status, status_detail, authorized_by, authorized_at, fees_acknowledged_at, fees_snapshot)
     values ($1, $2, 'submitted', 'Enviando o cadastro à operadora...', $3, now(), case when $4 then now() end, $5::jsonb)
     on conflict do nothing
     returning id`,
    [provider.name, input.kind, ctx.admin?.id ?? null, input.feesAcknowledged, JSON.stringify({ environment: merchant.environment, account_creation_cents: merchant.accountCreationFeeCents })],
  );
  if (!reserved) throw new HttpError(409, 'Já existe um cadastro em andamento ou uma conta aprovada para esta operadora.', { code: 'account_conflict' });
  await audit(ctx, { action: 'merchant.proposal', summary: `Enviou o cadastro da conta do estabelecimento (${input.kind === 'pf' ? 'pessoa física' : 'pessoa jurídica'}) à operadora`, entity: 'merchant_account', entityId: reserved.id, details: { kind: input.kind, environment: merchant.environment } });
  // 4) Envia. O resultado decide o estado; nada do formulário é guardado.
  try {
    const receipt = await merchant.submitProposal(input.kind, body);
    await one(`update merchant_accounts set status = 'pending', proposal_id = $2, status_detail = 'Cadastro enviado. Aguardando a análise da operadora.' where id = $1::uuid`, [reserved.id, receipt.formId]);
  } catch (error) {
    const kind = providerErrorKind(error);
    const code = (error as { code?: string } | null)?.code;
    const httpStatus = (error as { httpStatus?: number } | null)?.httpStatus;
    const message = error instanceof Error ? error.message.slice(0, 300) : 'erro';
    if (kind === 'unavailable') {
      await one(
        `update merchant_accounts set status = 'error', ambiguous = true,
                status_detail = 'A operadora não respondeu ao cadastro: ele PODE ter sido criado (e cobrado). Confira na ValidaPay antes de tentar de novo.' where id = $1::uuid`,
        [reserved.id],
      );
    } else if (code === 'INSUFFICIENT_BALANCE_FOR_SUBACCOUNT_FEE') {
      await one(`update merchant_accounts set status = 'error', status_detail = 'Saldo insuficiente na conta master para a tarifa de criação da subconta (R$ 15,00).' where id = $1::uuid`, [reserved.id]);
    } else if (httpStatus === 409) {
      await one(`update merchant_accounts set status = 'duplicate', status_detail = left($2, 500) where id = $1::uuid`, [reserved.id, `A operadora recusou como duplicado: ${message}`]);
    } else {
      await one(`update merchant_accounts set status = 'error', status_detail = left($2, 500) where id = $1::uuid`, [reserved.id, `A operadora recusou o cadastro: ${message}`]);
    }
  }
  const row = await one<MerchantRow>(
    `select id, provider, kind, status, status_detail, proposal_id, provider_account_id, ambiguous, authorized_at, fees_acknowledged_at, created_at, updated_at from merchant_accounts where id = $1::uuid`,
    [reserved.id],
  );
  return row!;
}

// ---- Acompanhar o cadastro ----------------------------------------------------------------------------------------------------------

export async function refreshProposal(ctx: Ctx): Promise<{ account: MerchantRow | null; documentsUrl: string | null }> {
  const { provider, merchant } = manager();
  const row = await one<MerchantRow>(
    `select id, provider, kind, status, status_detail, proposal_id, provider_account_id, ambiguous, authorized_at, fees_acknowledged_at, created_at, updated_at
       from merchant_accounts where provider = $1 and status = 'pending' and proposal_id is not null order by created_at desc limit 1`,
    [provider.name],
  );
  if (!row?.proposal_id) return { account: await latestMerchant(provider.name), documentsUrl: null };
  let state;
  try {
    state = await merchant.getProposal(row.proposal_id);
  } catch (error) {
    throw new HttpError(503, 'A operadora não respondeu. Tente de novo em instantes.', { code: providerErrorKind(error) ?? 'provider_unavailable' });
  }
  const parts = [state.form && `formulário ${state.form}`, state.proposal && `proposta ${state.proposal}`, state.documents && `documentos ${state.documents}`].filter(Boolean);
  if (parts.length) await one(`update merchant_accounts set status_detail = left($2, 500) where id = $1::uuid and status = 'pending'`, [row.id, `Situação informada pela operadora: ${parts.join(' · ')}.`]);
  await audit(ctx, { action: 'merchant.refresh', summary: 'Conferiu o cadastro da conta do estabelecimento na operadora', entity: 'merchant_account', entityId: row.id });
  return { account: await latestMerchant(provider.name), documentsUrl: state.documentsUrl };
}
