// Tipos compartilhados do sistema de e-mails (server/email/*).
import type { Message } from '../mail.js';

export type Category = 'transactional' | 'promotional';
export type Audience = 'customer' | 'staff';

export type MessageStatus = 'queued' | 'sending' | 'accepted' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed' | 'blocked' | 'cancelled';

// Por que uma tentativa de envio falhou (guardado em email_messages.error_kind).
export type FailureKind = 'recipient' | 'policy' | 'auth' | 'network' | 'temporary' | 'content' | 'config' | 'render' | 'other';

export type SendFailure = {
  kind: FailureKind;
  // Vale tentar de novo mais tarde? (rede e erro temporário do servidor de destino: sim; endereço inexistente ou recusa por política: não)
  retryable: boolean;
  // Endereço definitivamente inexistente/recusado: entra na lista de supressão.
  hard: boolean;
  // "550 5.1.1" (código SMTP e código estendido), sem nada que identifique a pessoa.
  code: string | null;
  // Motivo técnico sem endereço de e-mail nem segredo (no máximo 200 caracteres).
  detail: string;
  // O mesmo erro em 4 grupos grossos (usado nas frases do painel).
  legacy: 'recipient' | 'auth' | 'network' | 'other';
};

// O que o transporte devolve quando o servidor aceitou a mensagem.
export type SendResult = { messageId: string | null; providerId: string | null; response: string | null };

export type OutgoingMessage = Message & {
  // Identificador do registro: vira o Message-ID (<id@domínio do remetente>), para achar a mensagem numa devolução.
  id: string;
  headers: Record<string, string>;
  // Em segundo plano (fila): pode esperar mais pelo servidor de e-mail do que quem está com a pessoa na tela.
  patient?: boolean;
};

export type Transport = {
  name: 'smtp' | 'resend';
  // O que este transporte é capaz de informar depois do envio (o painel mostra isso com clareza: SMTP puro NÃO avisa entrega, devolução nem spam).
  capabilities: { acceptance: boolean; delivery: boolean; bounces: boolean; complaints: boolean; opens: boolean; clicks: boolean };
  send(message: OutgoingMessage): Promise<SendResult>;
};

export type MessageRow = {
  id: string;
  created_at: string;
  kind: string;
  category: Category;
  audience: Audience;
  recipient_email: string | null;
  recipient_domain: string | null;
  customer_id: string | null;
  order_id: string | null;
  campaign_id: string | null;
  subject: string | null;
  status: MessageStatus;
  transport: string | null;
  message_id: string | null;
  provider_id: string | null;
  spec: Record<string, unknown> | null;
  dedupe_key: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
};
