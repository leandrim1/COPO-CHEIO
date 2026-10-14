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
  // A pessoa marcou "quero receber promoções" no cadastro: este e-mail diz que confirmar o código também autoriza esses envios.
  marketingNotice?: boolean;
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
      ...(o.marketingNotice
        ? [{ kind: 'notice' as const, text: '**Novidades e promoções:** você marcou que quer receber novidades e promoções da loja por e-mail. Ao confirmar o seu e-mail com o código ou o botão acima, você autoriza esses envios. Dá para cancelar quando quiser, por um link que vai em cada mensagem ou em Minha conta.' }]
        : []),
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

// Recuperação de senha: o link leva à tela de nova senha. Vale por pouco tempo e uma vez só.
export function passwordResetMessage(brand: Brand, o: { to: string; name: string; link: string; minutes: number }): Message {
  const hi = greetingName(o.name);
  return renderEmail(brand, {
    to: o.to,
    subject: `Redefinir sua senha – ${brand.name}`,
    preheader: `Use o link para criar uma senha nova. Ele vale por ${o.minutes} minutos.`,
    eyebrow: 'Recuperação de senha',
    title: 'Redefina sua senha',
    greeting: hi ? `Olá, **${hi}**!` : 'Olá!',
    blocks: [
      { kind: 'text', text: 'Recebemos um pedido para redefinir a senha da sua conta. Toque no botão abaixo para escolher uma senha nova.' },
      { kind: 'button', label: 'Criar nova senha', url: o.link },
      { kind: 'text', tone: 'muted', text: `Este link vale por **${o.minutes} minutos** e só pode ser usado uma vez.` },
      {
        kind: 'link',
        text: 'Se o botão não funcionar, cole este endereço no navegador:',
        url: o.link,
        plainText: `Se o link acima não abrir, copie e cole o endereço no navegador. Ele vale por ${o.minutes} minutos e só pode ser usado uma vez.`,
      },
      { kind: 'notice', text: '**Não pediu para redefinir a senha?** Ignore este e-mail: a sua senha continua a mesma. Por segurança, não encaminhe este link a ninguém.' },
    ],
    reason: 'Esta mensagem foi enviada porque alguém pediu a redefinição da senha desta conta.',
  });
}

// Aviso depois que a senha foi trocada pelo link de e-mail: quem não foi o autor da troca percebe na hora.
export function passwordChangedMessage(brand: Brand, o: { to: string; name: string; loginUrl: string; when: Date }): Message {
  const hi = greetingName(o.name);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: brand.timezone }).formatToParts(o.when).map((part) => [part.type, part.value]),
  );
  // "10/10/2026 às 11:32", no fuso horário da loja (montado peça por peça: não depende de como cada versão do Node escreve a data).
  const when = `${parts.day}/${parts.month}/${parts.year} às ${parts.hour}:${parts.minute}`;
  return renderEmail(brand, {
    to: o.to,
    subject: `Sua senha foi alterada – ${brand.name}`,
    preheader: 'A senha da sua conta foi redefinida agora há pouco.',
    eyebrow: 'Segurança da conta',
    title: 'Senha alterada',
    greeting: hi ? `Olá, **${hi}**!` : 'Olá!',
    blocks: [
      { kind: 'text', text: `A senha da sua conta foi redefinida em **${when}**. Você foi desconectado dos aparelhos em que estava logado.` },
      { kind: 'text', text: 'Se foi você, não precisa fazer mais nada: é só entrar com a senha nova.' },
      { kind: 'button', label: 'Entrar na minha conta', url: o.loginUrl },
      { kind: 'notice', text: '**Não foi você?** Use “Esqueci minha senha” na página de entrada para criar outra senha agora e fale com a loja pelos contatos abaixo.' },
    ],
    reason: 'Esta mensagem foi enviada para avisar que a senha desta conta foi alterada.',
  });
}

// "10/10/2026 às 11:32", no fuso da loja (montado peça por peça: não depende de como cada versão do Node escreve a data).
export function whenText(date: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} às ${parts.hour}:${parts.minute}`;
}

// Alguém entrou no painel de um aparelho que ainda não conhecíamos: quem não foi o autor percebe na hora.
export function newAdminLoginMessage(brand: Brand, o: { to: string; name: string; when: Date; device: string; ip: string; panelUrl: string }): Message {
  const hi = greetingName(o.name);
  return renderEmail(brand, {
    to: o.to,
    subject: `Novo acesso ao painel – ${brand.name}`,
    preheader: `Entraram no painel de ${o.device}. Se não foi você, troque a senha agora.`,
    eyebrow: 'Segurança do painel',
    title: 'Novo acesso ao painel',
    greeting: hi ? `Olá, **${hi}**!` : 'Olá!',
    blocks: [
      { kind: 'text', text: `A sua conta entrou no painel de ${brand.name} em **${whenText(o.when, brand.timezone)}**.` },
      { kind: 'text', text: `Aparelho: **${o.device}**` },
      ...(o.ip && o.ip !== 'unknown' ? [{ kind: 'text' as const, text: `Rede (IP): **${o.ip}**` }] : []),
      { kind: 'text', text: 'Se foi você, não precisa fazer nada: este aviso só aparece quando você entra de um aparelho novo.', tone: 'muted' },
      { kind: 'notice', text: '**Não foi você?** Entre agora no painel, troque a senha em Configurações → Painel → Minha conta e ative a verificação em duas etapas. Isso desconecta os outros aparelhos.' },
      { kind: 'button', label: 'Abrir o painel', url: o.panelUrl },
    ],
    reason: 'Esta mensagem foi enviada porque a conta de administrador deste endereço de e-mail entrou no painel.',
  });
}

// A loja gerou um link para o cliente criar uma senha nova: o cliente é avisado na caixa de e-mail da conta, para que ninguém
// consiga tomar a conta dele em silêncio.
export function adminResetLinkNoticeMessage(brand: Brand, o: { to: string; name: string; when: Date; loginUrl: string }): Message {
  const hi = greetingName(o.name);
  return renderEmail(brand, {
    to: o.to,
    subject: `A loja gerou um link para trocar sua senha – ${brand.name}`,
    preheader: 'Se foi você quem pediu ajuda à loja, está tudo certo. Se não, avise a loja.',
    eyebrow: 'Segurança da conta',
    title: 'Link de nova senha gerado pela loja',
    greeting: hi ? `Olá, **${hi}**!` : 'Olá!',
    blocks: [
      { kind: 'text', text: `A loja gerou, em **${whenText(o.when, brand.timezone)}**, um link para criar uma senha nova na sua conta. Isso acontece quando você pede ajuda à loja para recuperar o acesso.` },
      { kind: 'text', text: 'A senha atual continua valendo até alguém usar esse link. Ele vale por 24 horas e só pode ser usado uma vez.', tone: 'muted' },
      { kind: 'notice', text: '**Não pediu ajuda à loja?** Fale com a loja pelos contatos abaixo e use “Esqueci minha senha” na página de entrada para criar outra senha agora.' },
      { kind: 'button', label: 'Entrar na minha conta', url: o.loginUrl },
    ],
    reason: 'Esta mensagem foi enviada porque a loja gerou um link de redefinição de senha para a conta deste endereço de e-mail.',
  });
}
