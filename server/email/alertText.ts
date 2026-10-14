// Os alertas de entregabilidade em português: título, o que aconteceu e o que fazer. Texto puro (sem banco), usado pelo painel e pelo
// e-mail de alerta para o dono.
export type AlertSeverity = 'info' | 'warning' | 'critical';

export type AlertCode = 'smtp_auth' | 'send_failures' | 'hard_rejections' | 'policy_blocks' | 'queue_backlog' | 'daily_limit' | 'complaints' | 'hard_bounces' | 'no_events' | 'free_sender';

type Detail = Record<string, unknown>;
const num = (value: unknown, digits = 0): string => (typeof value === 'number' ? value.toLocaleString('pt-BR', { maximumFractionDigits: digits }) : String(value ?? ''));

export function describeAlert(code: string, detail: Detail = {}): { title: string; detail: string; hint: string } {
  switch (code) {
    case 'smtp_auth':
      if (detail.transport === 'resend') {
        return {
          title: 'A Resend recusou a chave de API ou o domínio do remetente',
          detail: 'Enquanto isso, códigos de confirmação e avisos não saem (os avisos ficam na fila).',
          hint: 'Confira RESEND_API_KEY e MAIL_FROM na Vercel (o domínio do remetente precisa estar verificado na Resend) e faça um novo deploy.',
        };
      }
      return {
        title: 'O servidor de e-mail recusou o usuário ou a senha',
        detail: 'Enquanto isso, códigos de confirmação e avisos não saem (os avisos ficam na fila).',
        hint: 'Confira SMTP_USER e SMTP_PASS na Vercel (no Gmail, use uma senha de app de 16 letras) e faça um novo deploy.',
      };
    case 'send_failures':
      return {
        title: 'Muitas falhas ao enviar e-mails',
        detail: `${num(detail.failed)} de ${num(detail.total)} mensagens falharam nas últimas 24 horas (${num(detail.percent, 1)}%).`,
        hint: 'Abra a lista de mensagens com falha: o motivo de cada uma aparece na linha (rede, usuário/senha, endereço recusado ou política).',
      };
    case 'hard_rejections':
      return {
        title: 'Muitos endereços recusados pelo servidor de destino',
        detail: `${num(detail.rejected)} endereços foram recusados como inexistentes nos últimos 7 dias (${num(detail.percent, 1)}% das mensagens). O ideal é ficar abaixo de 2%.`,
        hint: 'Costuma ser erro de digitação no cadastro. Conferir o e-mail digitado e pedir a confirmação por código evita enviar para endereços errados; endereços recusados já entram sozinhos na lista de supressão.',
      };
    case 'policy_blocks':
      return {
        title: 'Servidores de destino recusaram mensagens por política (spam ou autenticação)',
        detail: `${num(detail.count)} mensagens foram recusadas com código 5.7.x nos últimos 7 dias.`,
        hint: 'Isso aponta para reputação ou autenticação do remetente (SPF, DKIM, DMARC). Veja "Como melhorar" neste painel: o remetente ideal é um domínio próprio autenticado, não um e-mail gratuito.',
      };
    case 'queue_backlog':
      return {
        title: 'Mensagens paradas na fila',
        detail: `${num(detail.count)} mensagem(ns) esperam há mais de 30 minutos.`,
        hint: 'Use "Processar fila agora". Se continuar parada, veja o motivo na mensagem (servidor de e-mail fora do ar ou usuário/senha recusados).',
      };
    case 'daily_limit':
      return {
        title: detail.reached ? 'O teto diário de envio foi atingido' : 'O envio diário está perto do teto',
        detail: `${num(detail.used)} de ${num(detail.limit)} e-mails aceitos nas últimas 24 horas (${num(detail.percent)}%).`,
        hint: 'Promoções e avisos esperam até haver folga; códigos de login continuam saindo. Contas Gmail pessoais têm limite diário baixo: para mais volume use um provedor de e-mail transacional.',
      };
    case 'complaints':
      return {
        title: 'Reclamações de spam acima do limite seguro',
        detail: `${num(detail.count)} reclamação(ões) nos últimos 30 dias (${num(detail.percent, 2)}% das mensagens entregues). O limite do Gmail é 0,30% e a meta é ficar abaixo de 0,10%.`,
        hint: 'Pare as promoções, revise quem está recebendo e o texto das mensagens. Quem reclama já é removido automaticamente.',
      };
    case 'hard_bounces':
      return {
        title: 'Devoluções definitivas acima do esperado',
        detail: `${num(detail.count)} devoluções definitivas nos últimos 30 dias (${num(detail.percent, 1)}%).`,
        hint: 'Esses endereços já foram suprimidos. Revise como os e-mails são digitados e evite listas antigas.',
      };
    case 'no_events':
      return {
        title: 'O provedor não está enviando avisos de entrega',
        detail: 'Nenhum aviso (webhook) chegou nas últimas 24 horas, mas há mensagens aceitas.',
        hint: 'Confira o endereço e o segredo do webhook no painel do provedor.',
      };
    case 'free_sender':
      return {
        title: 'O remetente é um e-mail gratuito',
        detail: 'Com Gmail, Outlook ou Yahoo como remetente não existe domínio da loja para autenticar (SPF, DKIM e DMARC são do provedor), e o limite de envio é o de uma conta pessoal.',
        hint: 'Para entrega melhor e métricas de verdade: registre um domínio próprio e use um provedor de e-mail transacional (veja "Como melhorar").',
      };
    default:
      return { title: 'Alerta de e-mails', detail: '', hint: '' };
  }
}
