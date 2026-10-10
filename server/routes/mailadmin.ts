// Painel: estado do envio de e-mails (confirmação de conta) e e-mail de teste.
import { attempts, recordAttempt } from '../auth.js';
import { HttpError, json } from '../http.js';
import type { Router } from '../http.js';
import { MailError, mailMissing, mailStatus, sendMail } from '../mail.js';
import { loadBrand } from '../mailBrand.js';
import { verificationMessage } from '../mailTemplates.js';
import { CODE_MINUTES, LINK_HOURS } from '../verification.js';

export function registerMailAdmin(r: Router) {
  // Sem segredos: só diz se está configurado, o que falta e de onde sai o e-mail.
  r.get('/api/admin/mail', 'admin', () => json(mailStatus()));

  // Manda um e-mail de teste para o e-mail de quem está logado: confirma que as variáveis SMTP estão certas.
  r.post('/api/admin/mail/test', 'owner', async (ctx) => {
    if (mailMissing().length) {
      throw new HttpError(503, `O envio de e-mails ainda não está configurado. Faltam na Vercel: ${mailMissing().join(', ')}.`, { code: 'mail_not_configured', missing: mailMissing() });
    }
    if ((await attempts('mail-test', ctx.admin!.id, 3600)) >= 10) throw new HttpError(429, 'Muitos testes seguidos. Aguarde um pouco.');
    await recordAttempt('mail-test', ctx.admin!.id);
    // O e-mail de teste é o de confirmação de verdade (mesmo layout, logo e rodapé), com um código de exemplo e um aviso no topo:
    // assim a loja vê no Gmail/Outlook exatamente o que o cliente recebe.
    try {
      const brand = await loadBrand(ctx.req);
      await sendMail(
        verificationMessage(brand, {
          to: ctx.admin!.email,
          name: ctx.admin!.name,
          code: '123456',
          link: `${brand.siteUrl}/conta`,
          codeMinutes: CODE_MINUTES,
          linkHours: LINK_HOURS,
          sample: true,
        }),
      );
    } catch (error) {
      const reason = error instanceof MailError ? error.message : 'Falha ao enviar.';
      throw new HttpError(502, `Não foi possível enviar o e-mail de teste: ${reason} Confira SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS e MAIL_FROM na Vercel.`, { code: 'mail_failed' });
    }
    return json({ ok: true, to: ctx.admin!.email });
  });
}
