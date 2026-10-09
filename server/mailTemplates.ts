// Textos dos e-mails (português). HTML simples, com estilos inline (é o que os leitores de e-mail aceitam) e versão em texto.
import type { Message } from './mail.js';

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const firstName = (name: string) => name.trim().split(/\s+/)[0] || 'tudo bem';

function layout(store: string, preheader: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(store)}</title></head>
<body style="margin:0;padding:0;background:#f3f5fa;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fa;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0b1020;">
<tr><td style="background:#145CFF;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:.3px;">${esc(store)}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.55;">${body}</td></tr>
<tr><td style="padding:0 24px 22px;font-size:12px;line-height:1.5;color:#6b7390;">Você recebeu este e-mail porque ele foi informado em ${esc(store)}. Se não foi você, ignore esta mensagem: nada será ativado.</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export function verificationMessage(o: { to: string; name: string; code: string; link: string; store: string; codeMinutes: number; linkHours: number }): Message {
  const spaced = `${o.code.slice(0, 3)} ${o.code.slice(3)}`;
  const subject = `${o.code} é o seu código de confirmação – ${o.store}`;
  const text = [
    `Olá, ${firstName(o.name)}!`,
    '',
    `Seu código para confirmar o e-mail e ativar a sua conta em ${o.store} é:`,
    '',
    `    ${o.code}`,
    '',
    `O código vale por ${o.codeMinutes} minutos e só pode ser usado uma vez.`,
    '',
    `Se preferir, abra este link (vale por ${o.linkHours} horas):`,
    o.link,
    '',
    'Se você não pediu esta conta, ignore este e-mail: nada será ativado.',
  ].join('\n');
  const html = layout(
    o.store,
    `Seu código de confirmação: ${o.code}`,
    `<p style="margin:0 0 12px;">Olá, <strong>${esc(firstName(o.name))}</strong>!</p>
<p style="margin:0 0 16px;">Use este código para confirmar o seu e-mail e ativar a conta:</p>
<p style="margin:0 0 16px;text-align:center;"><span style="display:inline-block;background:#eef3ff;border:1px solid #c9d8ff;border-radius:12px;padding:14px 22px;font-size:32px;font-weight:800;letter-spacing:8px;color:#145CFF;font-family:Consolas,Menlo,monospace;">${esc(spaced)}</span></p>
<p style="margin:0 0 20px;color:#4a5270;">O código vale por ${o.codeMinutes} minutos e só pode ser usado uma vez.</p>
<p style="margin:0 0 8px;">Ou confirme com um toque:</p>
<p style="margin:0 0 6px;"><a href="${esc(o.link)}" style="display:inline-block;background:#145CFF;color:#ffffff;text-decoration:none;font-weight:700;border-radius:999px;padding:12px 22px;">Confirmar meu e-mail</a></p>
<p style="margin:0;font-size:12px;color:#6b7390;">O link vale por ${o.linkHours} horas.</p>`,
  );
  return { to: o.to, subject, text, html };
}

// Alguém tentou criar uma conta com um e-mail que já tem conta: o aviso vai só para a caixa do dono (a tela de quem tentou não revela nada).
export function alreadyRegisteredMessage(o: { to: string; name: string; loginUrl: string; store: string }): Message {
  const subject = `Você já tem uma conta em ${o.store}`;
  const text = [
    `Olá, ${firstName(o.name)}!`,
    '',
    `Alguém tentou criar uma conta em ${o.store} com este e-mail, mas ele já tem uma conta.`,
    `Se foi você, é só entrar com o seu e-mail e a sua senha: ${o.loginUrl}`,
    'Se você esqueceu a senha, use "Esqueci minha senha" na página de entrada.',
    '',
    'Se não foi você, ignore este e-mail: nada foi alterado na sua conta.',
  ].join('\n');
  const html = layout(
    o.store,
    'Você já tem uma conta',
    `<p style="margin:0 0 12px;">Olá, <strong>${esc(firstName(o.name))}</strong>!</p>
<p style="margin:0 0 14px;">Alguém tentou criar uma conta em ${esc(o.store)} com este e-mail, mas ele <strong>já tem uma conta</strong>.</p>
<p style="margin:0 0 16px;">Se foi você, é só entrar com o seu e-mail e a sua senha:</p>
<p style="margin:0 0 16px;"><a href="${esc(o.loginUrl)}" style="display:inline-block;background:#145CFF;color:#ffffff;text-decoration:none;font-weight:700;border-radius:999px;padding:12px 22px;">Entrar na minha conta</a></p>
<p style="margin:0;color:#4a5270;">Esqueceu a senha? Use “Esqueci minha senha” na página de entrada. Se não foi você, ignore: nada foi alterado.</p>`,
  );
  return { to: o.to, subject, text, html };
}

export function testMessage(o: { to: string; store: string }): Message {
  return {
    to: o.to,
    subject: `Teste de e-mail – ${o.store}`,
    text: `Está tudo certo: o envio de e-mails de ${o.store} está funcionando. Os clientes vão receber os códigos de confirmação por aqui.`,
    html: layout(o.store, 'Teste de e-mail', `<p style="margin:0 0 12px;"><strong>Está tudo certo!</strong></p><p style="margin:0;">O envio de e-mails de ${esc(o.store)} está funcionando. Os clientes vão receber os códigos de confirmação por aqui.</p>`),
  };
}
