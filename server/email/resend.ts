// Transporte OPCIONAL pela API da Resend (https://resend.com). Fica desligado: só vale com EMAIL_PROVIDER=resend.
//
// Por que existe: o SMTP puro só diz "o servidor aceitou"; a Resend também AVISA (webhook assinado) quando a mensagem foi entregue,
// devolvida ou marcada como spam, e isso é o que permite medir entregabilidade de verdade. Exige um DOMÍNIO PRÓPRIO verificado na Resend
// (SPF e DKIM) e MAIL_FROM com endereço desse domínio. Passo a passo: docs/EMAIL.md.
//
// Variáveis do SERVIDOR: RESEND_API_KEY (chave só de envio) e RESEND_WEBHOOK_SECRET (segredo "whsec_…" do webhook, veja webhook.ts).
//
// O que está CONFERIDO na documentação pública da Resend: envio por POST /emails com cabeçalho "Idempotency-Key" (até 256 caracteres,
// vale por 24 h) e resposta com o id do e-mail. O mapeamento dos erros HTTP abaixo segue o significado padrão dos códigos (401/403 =
// credencial ou domínio, 429 = limite de requisições, 5xx = problema do serviço); os textos exatos de cada erro NÃO foram verificados
// contra o serviço real: confira no sandbox antes de depender deles.
import { MissingConfig } from '../env.js';
import { mailConfig } from '../mail.js';
import { replyTo } from './config.js';
import { TransportFailure, failure, redact } from './errors.js';
import type { OutgoingMessage, SendResult, Transport } from './types.js';

const ENDPOINT = 'https://api.resend.com/emails';

export const resendConfigured = (): boolean => Boolean((process.env.RESEND_API_KEY ?? '').trim()) && Boolean(mailConfig()?.from);

async function post(message: OutgoingMessage): Promise<SendResult> {
  const key = (process.env.RESEND_API_KEY ?? '').trim();
  const from = mailConfig()?.from ?? (process.env.MAIL_FROM ?? '').trim();
  if (!key || !from) throw new MissingConfig(['RESEND_API_KEY', 'MAIL_FROM'].filter((name) => !(process.env[name] ?? '').trim()));
  let response: Response;
  try {
    response = await fetch(process.env.RESEND_API_URL?.trim() || ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': message.id },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(replyTo() ? { reply_to: replyTo() } : {}),
        ...(Object.keys(message.headers).length ? { headers: message.headers } : {}),
      }),
      signal: AbortSignal.timeout(message.patient ? 15_000 : 7_000),
    });
  } catch (error) {
    const timeout = (error as { name?: string }).name === 'TimeoutError' || (error as { name?: string }).name === 'AbortError';
    throw new TransportFailure(failure('network', { retryable: true, code: timeout ? 'ETIMEDOUT' : 'ECONNECTION', detail: timeout ? 'A Resend demorou demais para responder.' : 'Não foi possível falar com a Resend.' }));
  }
  let body: { id?: unknown; message?: unknown; name?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    /* resposta sem corpo JSON */
  }
  if (response.ok) {
    const id = typeof body.id === 'string' && body.id ? body.id.slice(0, 200) : null;
    return { messageId: null, providerId: id, response: `HTTP ${response.status}` };
  }
  const why = redact(typeof body.message === 'string' ? body.message : `HTTP ${response.status}`);
  const code = `HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) throw new TransportFailure(failure('auth', { retryable: true, code, detail: why }));
  if (response.status === 429 || response.status >= 500 || response.status === 408) throw new TransportFailure(failure('temporary', { retryable: true, code, detail: why }));
  // 400/422: pedido recusado. Se o texto fala do destinatário, o endereço é o problema; senão é configuração (remetente/domínio) ou conteúdo.
  if (/\bto\b|recipient|destinat/i.test(why)) throw new TransportFailure(failure('recipient', { retryable: false, hard: true, code, detail: why }));
  if (/domain|from|remetente|verified/i.test(why)) throw new TransportFailure(failure('config', { retryable: true, code, detail: why }));
  throw new TransportFailure(failure('content', { retryable: false, code, detail: why }));
}

export const resendTransport: Transport = {
  name: 'resend',
  // Com a API + webhook configurados a Resend informa aceitação, entrega, devolução e reclamação. Abertura e clique só existem se o
  // rastreamento for ligado no domínio, o que NÃO fazemos para e-mails de conta e pedido (a Resend recomenda deixá-los desligados).
  capabilities: { acceptance: true, delivery: true, bounces: true, complaints: true, opens: false, clicks: false },
  send: post,
};
