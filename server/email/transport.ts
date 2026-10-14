// Transportes de envio. Hoje o SMTP comum (o que a loja já usa); o transporte "resend" (API + avisos de entrega) é opcional e só liga
// com EMAIL_PROVIDER=resend (server/email/resend.ts).
import { smtpSend } from '../mail.js';
import { fromAddress, replyTo, transportName } from './config.js';
import { resendTransport } from './resend.js';
import type { OutgoingMessage, SendResult, Transport } from './types.js';

export const smtpTransport: Transport = {
  name: 'smtp',
  // SMTP puro só sabe dizer "o servidor aceitou" ou "o servidor recusou". Entrega, devolução, reclamação, abertura e clique NÃO chegam.
  capabilities: { acceptance: true, delivery: false, bounces: false, complaints: false, opens: false, clicks: false },
  async send(message: OutgoingMessage): Promise<SendResult> {
    const from = fromAddress();
    const info = await smtpSend(
      {
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.headers,
        // Message-ID nosso (<id do registro@domínio do remetente>): numa devolução que chegue por e-mail, é por ele que se acha a mensagem.
        ...(from ? { messageId: `<${message.id}@${from.domain}>` } : {}),
        ...(replyTo() ? { replyTo: replyTo() } : {}),
      },
      { patient: message.patient },
    );
    return { messageId: info.messageId, providerId: null, response: info.response };
  },
};

export function getTransport(): Transport {
  return transportName() === 'resend' ? resendTransport : smtpTransport;
}
