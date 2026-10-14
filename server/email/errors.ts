// O que deu errado ao enviar? Transforma o erro do SMTP (nodemailer) numa decisão: tentar de novo, desistir, suprimir o endereço,
// avisar o dono da loja. É uma função pura (sem rede, sem banco), testada com respostas reais de servidores de e-mail.
import type { FailureKind, SendFailure } from './types.js';

const ENHANCED = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;
const NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'EDNS', 'ENOTFOUND', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

// Tira endereços de e-mail e espaços do texto de uma resposta do servidor (nunca vão para o registro) e corta no tamanho do campo.
export function redact(text: unknown, max = 200): string {
  return String(text ?? '')
    .replace(/[^\s<>"']+@[^\s<>"']+/g, '<e-mail>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Um transporte que já sabe classificar o próprio erro (ex.: API de um provedor) lança isto; classifyFailure devolve o que veio.
export class TransportFailure extends Error {
  constructor(public failure: SendFailure) {
    super(failure.detail);
  }
}

export const failure = (kind: FailureKind, o: { retryable: boolean; hard?: boolean; code: string | null; detail: string }): SendFailure => ({
  kind,
  retryable: o.retryable,
  hard: o.hard ?? false,
  code: o.code,
  detail: o.detail,
  legacy: kind === 'auth' || kind === 'config' ? 'auth' : kind === 'network' ? 'network' : 'other',
});

export function classifyFailure(error: unknown): SendFailure {
  if (error instanceof TransportFailure) return error.failure;
  const e = (error ?? {}) as { code?: string; command?: string; responseCode?: number; response?: string; message?: string };
  const text = String(e.response ?? e.message ?? '');
  const detail = redact(text);
  const rc = typeof e.responseCode === 'number' && e.responseCode >= 200 && e.responseCode < 600 ? e.responseCode : null;
  const m = ENHANCED.exec(text);
  const enhanced = m ? `${m[1]}.${m[2]}.${m[3]}` : null;
  const code = [rc, enhanced].filter((part) => part !== null).join(' ') || e.code || null;
  const atRecipient = e.code === 'EENVELOPE' || e.command === 'RCPT TO';

  // Usuário/senha do servidor de e-mail recusados (ou "autenticação obrigatória"): é configuração, não destinatário.
  if (e.code === 'EAUTH' || rc === 535 || rc === 534 || rc === 530) {
    return failure('auth', { retryable: true, code, detail: detail || 'O servidor de e-mail recusou o usuário/senha.' });
  }
  if (NETWORK_CODES.has(e.code ?? '')) {
    return failure('network', { retryable: true, code: e.code ?? null, detail: detail || 'Não foi possível falar com o servidor de e-mail.' });
  }

  // Recusa temporária (4xx): servidor ocupado, "greylisting", caixa cheia por enquanto...
  if (rc !== null && rc >= 400 && rc < 500) {
    return failure(atRecipient ? 'recipient' : 'temporary', { retryable: true, code, detail });
  }

  if (rc !== null && rc >= 500) {
    const cls = enhanced ? Number(enhanced.split('.')[1]) : null;
    const sub = enhanced ? Number(enhanced.split('.')[2]) : null;
    // 5.1.x: endereço de destino inexistente ou inválido → devolução definitiva.
    if (cls === 1) return failure('recipient', { retryable: false, hard: true, code, detail });
    if (cls === 2) {
      // 5.2.1: caixa desativada (definitivo); os outros 5.2.x (caixa cheia, mensagem grande para a caixa) podem passar com o tempo.
      return sub === 1 ? failure('recipient', { retryable: false, hard: true, code, detail }) : failure('recipient', { retryable: true, code, detail });
    }
    if (cls === 3) return failure('content', { retryable: false, code, detail });
    // 5.4.1: o Microsoft 365 usa para "esse destinatário não existe".
    if (cls === 4) return sub === 1 && atRecipient ? failure('recipient', { retryable: false, hard: true, code, detail }) : failure('other', { retryable: false, code, detail });
    if (cls === 6) return failure('content', { retryable: false, code, detail });
    // 5.7.x: o servidor de destino recusou por política (bloqueio, spam, autenticação do remetente). NÃO é problema do endereço.
    if (cls === 7) return failure('policy', { retryable: false, code, detail });
    if (cls === 5) return failure('other', { retryable: false, code, detail });
    // Sem código estendido: 5xx na fase do destinatário costuma ser "caixa inexistente"; 552 é "caixa cheia".
    if (atRecipient) {
      if (rc === 552) return failure('recipient', { retryable: true, code, detail });
      if ([550, 551, 553, 554].includes(rc)) return failure('recipient', { retryable: false, hard: true, code, detail });
    }
    // Recusa depois do conteúdo (DATA): normalmente filtro de spam ou política.
    if (e.command === 'DATA' || e.code === 'EMESSAGE') return failure('policy', { retryable: false, code, detail });
    return failure('other', { retryable: false, code, detail });
  }

  // Endereço mal formado ou sem destinatário válido (o nodemailer nem chegou a falar com o servidor).
  if (e.code === 'EENVELOPE') return failure('recipient', { retryable: false, hard: true, code: e.code ?? null, detail: detail || 'Endereço de destino inválido.' });
  return failure('other', { retryable: true, code: e.code ?? null, detail: detail || 'O servidor de e-mail não aceitou a mensagem.' });
}

// Espera (em minutos) depois de cada tentativa que falhou: 2 min, 10 min, 1 h, 4 h, 12 h (e, se ainda sobrar tentativa, 12 h de novo).
export const BACKOFF_MINUTES = [2, 10, 60, 240, 720];

// `attempt` é a tentativa que acabou de falhar (1, 2, 3...). `jitter` (0 a 1) espalha as novas tentativas em ±10%, para a fila não
// acordar tudo no mesmo segundo. Erro de usuário/senha do servidor de e-mail espera 1 hora (é configuração: não adianta insistir).
export function retryDelayMs(attempt: number, kind: FailureKind = 'temporary', jitter = 0.5): number {
  const minutes = kind === 'auth' || kind === 'config' ? 60 : (BACKOFF_MINUTES[Math.min(Math.max(attempt, 1), BACKOFF_MINUTES.length) - 1] ?? 720);
  return Math.round(minutes * 60_000 * (0.9 + 0.2 * jitter));
}
