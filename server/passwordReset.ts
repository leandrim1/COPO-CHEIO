// Recuperação de senha por e-mail.
//
// A pessoa informa o e-mail da conta; se existir uma conta ativa, o servidor manda para essa caixa um link de uso único
// (vale 60 minutos). O banco guarda só o hash do link (customer_password_resets) e decide, de forma atômica, a espera
// entre pedidos e os limites por hora/dia. A resposta da rota é a mesma exista a conta ou não, e demora o mesmo tempo
// (veja `padResponse`), para que ninguém use esta tela para descobrir quem tem conta.
import { randomBytes } from 'node:crypto';
import { attempts, recordAttempt, sha256 } from './auth.js';
import { one, query } from './db.js';
import { HttpError } from './http.js';
import { mailConfigured, sendMail } from './mail.js';
import { loadBrand } from './mailBrand.js';
import { passwordChangedMessage, passwordResetMessage } from './mailTemplates.js';
import { MAIL_IP_BUCKET, MAIL_IP_MAX } from './verification.js';

export const RESET_MINUTES = 60;
export const RESET_RESEND_SECONDS = 60;

export const newResetToken = (): string => randomBytes(32).toString('base64url');

export const resetMailUnavailable = () =>
  new HttpError(
    503,
    'A recuperação de senha por e-mail está indisponível porque o envio de e-mails da loja ainda não foi configurado. Use a opção “Não consigo acessar meu e-mail” ou fale com a loja pelo WhatsApp.',
    { code: 'mail_not_configured' },
  );

// Quem pede o link precisa esperar o mesmo tempo com ou sem conta (o envio do e-mail leva ~1 s; sem espera, a resposta
// rápida entregaria que o e-mail não tem conta). Não elimina a diferença por completo, mas tira o sinal óbvio.
const MIN_RESPONSE_MS = 1800;
export async function padResponse(startedAt: number): Promise<void> {
  const target = MIN_RESPONSE_MS + Math.floor(Math.random() * 400);
  const wait = startedAt + target - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

// Vale para os dois lados da rota (mesma resposta para todo mundo): o limite por rede.
export async function assertMailBudget(ip: string): Promise<void> {
  if ((await attempts(MAIL_IP_BUCKET, ip, 3600)) >= MAIL_IP_MAX) {
    throw new HttpError(429, 'Muitos e-mails pedidos desta rede. Aguarde um pouco e tente de novo.', { code: 'rate_limited' });
  }
}

type Begin = { ok: true; email: string; name: string } | { ok: false; reason: 'not_eligible' | 'cooldown' | 'hourly' | 'daily'; retry_after?: number };

// Cria o link, manda o e-mail e só então invalida os links anteriores. Devolve true se um e-mail saiu. Não lança erro por
// regra de negócio (conta desativada, espera de 60 s, limites) nem por falha do servidor de e-mail: a rota responde igual
// em todos os casos, e quem não recebeu pede de novo.
export async function sendPasswordResetEmail(req: Request, ip: string, customer: { id: string }): Promise<boolean> {
  const token = newResetToken();
  const hash = sha256(token);
  const row = await one<{ r: Begin }>('select begin_password_reset($1::uuid, $2, $3) as r', [customer.id, hash, RESET_MINUTES]);
  const begin = row!.r;
  if (!begin.ok) return false;
  try {
    const brand = await loadBrand(req);
    await sendMail(passwordResetMessage(brand, { to: begin.email, name: begin.name, link: `${brand.siteUrl}/conta/redefinir/${token}`, minutes: RESET_MINUTES }));
  } catch {
    // O link novo é descartado; o que a pessoa já tinha continua valendo. (Nada de endereço nem de link no log: o motivo
    // técnico já foi registrado por sendMail.)
    await query('select finish_password_reset($1, false)', [hash]);
    console.error('[senha] o e-mail de redefinição não foi enviado');
    return false;
  }
  await query('select finish_password_reset($1, true)', [hash]);
  await recordAttempt(MAIL_IP_BUCKET, ip);
  return true;
}

// Aviso depois da troca da senha pelo link de e-mail. Melhor esforço: a senha já foi trocada, falha de envio não vira erro.
export async function sendPasswordChangedNotice(req: Request, customer: { email: string; name: string }): Promise<void> {
  if (!mailConfigured()) return;
  try {
    const brand = await loadBrand(req);
    await sendMail(passwordChangedMessage(brand, { to: customer.email, name: customer.name, loginUrl: `${brand.siteUrl}/conta`, when: new Date() }));
  } catch {
    console.error('[senha] o aviso de senha alterada não foi enviado');
  }
}
