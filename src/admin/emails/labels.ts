import type { EmailStatus } from '../../lib/types';

// Textos do painel de e-mails em português. Cada estado diz exatamente o que sabemos (e o que NÃO sabemos).
export type Tone = 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'gray';

export const STATUS_INFO: Record<EmailStatus, { label: string; tone: Tone; help: string }> = {
  queued: { label: 'Na fila', tone: 'blue', help: 'Esperando para ser enviada, ou para tentar de novo depois de uma falha.' },
  sending: { label: 'Enviando', tone: 'blue', help: 'Está sendo enviada agora.' },
  accepted: { label: 'Aceito pelo servidor', tone: 'green', help: 'O servidor de e-mail recebeu a mensagem. Isso NÃO garante que ela chegou à caixa de entrada: com SMTP comum não há aviso de entrega.' },
  delivered: { label: 'Entregue', tone: 'green', help: 'O provedor confirmou a entrega ao servidor do destinatário. Ele não diz se foi para a caixa de entrada, Promoções ou Spam.' },
  delayed: { label: 'Entrega atrasada', tone: 'amber', help: 'O provedor ainda está tentando entregar.' },
  bounced: { label: 'Devolvido', tone: 'red', help: 'O servidor do destinatário recusou a mensagem depois de aceita pelo provedor.' },
  complained: { label: 'Marcado como spam', tone: 'red', help: 'O destinatário marcou a mensagem como spam. O endereço já foi removido das promoções.' },
  failed: { label: 'Falhou', tone: 'red', help: 'O servidor de e-mail recusou a mensagem de vez, ou as tentativas acabaram.' },
  blocked: { label: 'Bloqueado (não enviado)', tone: 'amber', help: 'O sistema nem tentou enviar: uma regra de proteção barrou a mensagem (veja o motivo).' },
  cancelled: { label: 'Cancelado', tone: 'gray', help: 'Não saiu: foi cancelado, ou já não fazia mais sentido enviar (o pedido avançou de etapa, por exemplo).' },
};

export const STATUS_ORDER: EmailStatus[] = ['queued', 'sending', 'accepted', 'delivered', 'delayed', 'bounced', 'complained', 'failed', 'blocked', 'cancelled'];

// Por que uma tentativa falhou (error_kind).
export const ERROR_KIND: Record<string, string> = {
  recipient: 'Endereço recusado pelo servidor de destino',
  policy: 'Recusado por política do servidor de destino (spam ou autenticação)',
  auth: 'Usuário/senha (ou chave) recusados pelo servidor de e-mail',
  config: 'Configuração do envio incorreta',
  network: 'Sem conexão com o servidor de e-mail',
  temporary: 'Falha temporária do servidor de e-mail',
  content: 'Conteúdo recusado pelo servidor',
  render: 'Não foi possível montar a mensagem',
  other: 'Falha ao enviar',
};

export const EVENT_TYPE: Record<string, string> = {
  queued: 'Entrou na fila',
  attempt: 'Tentativa de envio',
  accepted: 'Aceito pelo servidor de e-mail',
  deferred: 'Falhou por enquanto; vai tentar de novo',
  rejected: 'Recusado de vez pelo servidor',
  delivered: 'Entregue',
  delayed: 'Entrega atrasada',
  bounced: 'Devolvido',
  complained: 'Marcado como spam',
  opened: 'Aberto',
  clicked: 'Clique em um link',
  failed: 'Falhou',
  suppressed: 'Endereço colocado na lista de supressão',
  blocked: 'Bloqueado antes do envio',
  cancelled: 'Cancelado',
  note: 'Observação',
};

export const EVENT_SOURCE: Record<string, string> = { smtp: 'Sistema (envio)', admin: 'Painel', resend: 'Aviso do provedor (Resend)' };

export const SUPPRESSION_REASON: Record<string, string> = {
  hard_bounce: 'Endereço inexistente (devolução definitiva)',
  complaint: 'Marcou como spam',
  repeated_soft: 'Devoluções temporárias repetidas (temporário)',
  manual: 'Colocado pela loja',
};

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Rascunho', tone: 'gray' },
  sending: { label: 'Enviando', tone: 'blue' },
  done: { label: 'Concluída', tone: 'green' },
  cancelled: { label: 'Cancelada', tone: 'red' },
};

export const ALERT_TONE = { critical: 'red', warning: 'amber', info: 'blue' } as const;
export const ALERT_LABEL = { critical: 'Crítico', warning: 'Atenção', info: 'Informação' } as const;
