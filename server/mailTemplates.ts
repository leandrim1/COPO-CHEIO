// Os e-mails da Copo Cheio (português). Cada um só diz o que tem a dizer (título, texto, código, botão...);
// o cabeçalho com a logo, as cores, a tipografia, o rodapé com os contatos reais da loja, o modo escuro e a versão em
// texto simples vêm todos de `mailLayout.ts`, então todo e-mail novo já nasce com a mesma identidade visual.
//
// Para criar um e-mail novo:
//   1. escreva uma função aqui, no formato das de baixo: recebe `brand` (de `loadBrand(req)`) e os dados do e-mail e
//      devolve `renderEmail(brand, { ... })`;
//   2. envie com `sendMail(message)` (mail.ts), de dentro de uma rota, depois de conferir as regras de quem pode receber.
import type { Brand } from './mailBrand.js';
import { renderEmail } from './mailLayout.js';
import type { Message } from './mail.js';

// Primeiro nome para a saudação: "leandro silva" → "Leandro".
export function greetingName(name: string): string {
  const first = (name.trim().split(/\s+/)[0] ?? '').replace(/\*/g, '').slice(0, 40);
  return first ? first.charAt(0).toLocaleUpperCase('pt-BR') + first.slice(1) : '';
}

export type VerificationData = {
  to: string;
  name: string;
  code: string;
  link: string;
  codeMinutes: number;
  linkHours: number;
  // E-mail de teste do painel: mesma aparência, com o aviso de que o código é só um exemplo.
  sample?: boolean;
};

export function verificationMessage(brand: Brand, o: VerificationData): Message {
  const hi = greetingName(o.name);
  return renderEmail(brand, {
    to: o.to,
    subject: `${o.sample ? '[Teste] ' : ''}${o.code} é o seu código de confirmação – ${brand.name}`,
    preheader: `Seu código de confirmação é ${o.code}. Ele expira em ${o.codeMinutes} minutos.`,
    eyebrow: 'Verificação de e-mail',
    title: 'Confirme seu e-mail',
    greeting: hi ? `Olá, **${hi}**! Que bom ter você com a gente.` : 'Olá! Que bom ter você com a gente.',
    banner: o.sample ? 'Mensagem de teste enviada pelo painel. O código abaixo é só um exemplo e não ativa nenhuma conta.' : undefined,
    blocks: [
      { kind: 'text', text: 'Use o código abaixo para confirmar o seu endereço de e-mail e ativar a sua conta.' },
      { kind: 'code', label: 'Seu código de verificação', value: o.code, note: `Este código expira em **${o.codeMinutes} minutos** e só pode ser usado uma vez.` },
      { kind: 'button', label: 'Confirmar meu e-mail', url: o.link },
      {
        kind: 'link',
        text: `Se o botão não funcionar, copie o código acima e digite-o na tela de confirmação do site. Ou cole este endereço no navegador (vale por ${o.linkHours} horas):`,
        url: o.link,
        plainText: `Se o link acima não abrir, copie o código e digite-o na tela de confirmação do site. O link vale por ${o.linkHours} horas.`,
      },
      { kind: 'notice', text: '**Por segurança**, não compartilhe este código com ninguém. Se você não criou esta conta, ignore este e-mail: nada será ativado.' },
    ],
    reason: 'Esta mensagem foi enviada para confirmar um cadastro feito com este endereço de e-mail.',
  });
}

// Alguém tentou criar uma conta com um e-mail que já tem conta: o aviso vai só para a caixa do dono (a tela de quem tentou não revela nada).
export function alreadyRegisteredMessage(brand: Brand, o: { to: string; name: string; loginUrl: string }): Message {
  const hi = greetingName(o.name);
  return renderEmail(brand, {
    to: o.to,
    subject: `Você já tem uma conta em ${brand.name}`,
    preheader: 'Alguém tentou criar uma conta com este e-mail. Se foi você, é só entrar.',
    eyebrow: 'Conta existente',
    title: 'Você já tem uma conta',
    greeting: hi ? `Olá, **${hi}**!` : 'Olá!',
    blocks: [
      { kind: 'text', text: `Alguém tentou criar uma conta em ${brand.name} com este e-mail, mas ele **já tem uma conta**.` },
      { kind: 'text', text: 'Se foi você, é só entrar com o seu e-mail e a sua senha.' },
      { kind: 'button', label: 'Entrar na minha conta', url: o.loginUrl },
      { kind: 'text', text: 'Esqueceu a senha? Use “Esqueci minha senha” na página de entrada.', tone: 'muted' },
      { kind: 'notice', text: '**Não foi você?** Ignore este e-mail: nada foi alterado na sua conta.' },
    ],
    reason: 'Esta mensagem foi enviada porque este endereço de e-mail foi usado em uma tentativa de cadastro.',
  });
}
