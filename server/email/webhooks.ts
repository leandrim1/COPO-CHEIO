// Avisos do provedor de e-mail (webhooks) transformados em eventos do nosso registro. Hoje só a Resend (transporte opcional).
//
// O que está CONFERIDO: a forma da assinatura (Svix, ver svix.ts). O formato do corpo abaixo ({ type, created_at, data: { email_id, to,
// bounce: { type } } }) e os nomes dos tipos de evento seguem a documentação pública da Resend, mas NÃO foram testados contra o serviço
// real: por isso a leitura é defensiva (campo faltando ou diferente = evento ignorado ou tratado como "desconhecido", nunca como
// devolução definitiva) e o painel mostra o último aviso recebido, para a loja ver se chegam mesmo.
import { redact } from './errors.js';

export type EventType = 'delivered' | 'delayed' | 'bounced' | 'complained' | 'opened' | 'clicked' | 'failed';

export type NormalizedEvent = {
  type: EventType;
  // Id que o provedor deu à mensagem (guardado em email_messages.provider_id quando enviamos).
  providerId: string;
  occurredAt: Date;
  recipient: string | null;
  // Sem endereço, sem link clicado e sem corpo: só o que ajuda a entender o que houve.
  detail: Record<string, unknown>;
};

const TYPES: Record<string, EventType | null> = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.failed': 'failed',
  // Aceitação pela Resend: já registramos "aceito" quando a API respondeu. Os demais (agendado, recebido...) não interessam.
  'email.sent': null,
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Permanent = endereço definitivamente ruim; Transient = problema passageiro (caixa cheia, servidor fora). Qualquer outra coisa ou
// campo ausente é "desconhecido": registra o fato, mas NÃO suprime o endereço.
function bounceKind(value: unknown): 'hard' | 'soft' | 'unknown' {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (v === 'permanent') return 'hard';
  if (v === 'transient') return 'soft';
  return 'unknown';
}

export function normalizeResend(payload: unknown): NormalizedEvent | null {
  if (!isObject(payload) || typeof payload.type !== 'string' || !isObject(payload.data)) return null;
  const type = TYPES[payload.type];
  if (!type) return null;
  const data = payload.data;
  const providerId = typeof data.email_id === 'string' ? data.email_id.trim().slice(0, 200) : '';
  if (!providerId) return null;
  const when = new Date(typeof payload.created_at === 'string' ? payload.created_at : NaN);
  const first = Array.isArray(data.to) && typeof data.to[0] === 'string' ? data.to[0] : null;
  const recipient = first && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(first.trim()) ? first.trim().toLowerCase() : null;
  const detail: Record<string, unknown> = {};
  if (type === 'bounced') {
    const bounce = isObject(data.bounce) ? data.bounce : {};
    detail.bounce = bounceKind(bounce.type);
    if (typeof bounce.subType === 'string') detail.sub_type = bounce.subType.slice(0, 40);
    if (typeof bounce.message === 'string') detail.message = redact(bounce.message, 200);
  }
  return { type, providerId, occurredAt: Number.isNaN(when.getTime()) ? new Date() : when, recipient, detail };
}
