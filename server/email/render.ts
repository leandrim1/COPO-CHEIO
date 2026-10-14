// Monta a mensagem de um tipo "enfileirável" a partir da receita (`spec`) guardada no registro. É por aqui que uma nova tentativa
// refaz o e-mail sem que nenhum segredo precise ter ficado no banco: a receita só tem ids e dados sem segredo (nome, data, aparelho).
import { loadBrand } from '../mailBrand.js';
import type { Message } from '../mail.js';
import { adminResetLinkNoticeMessage, alreadyRegisteredMessage, newAdminLoginMessage, passwordChangedMessage } from '../mailTemplates.js';
import { isKind } from './kinds.js';
import type { KindName } from './kinds.js';

export type RenderInput = { kind: string; to: string | null; spec: Record<string, unknown> | null };

const text = (value: unknown, max = 120): string => (typeof value === 'string' ? value.slice(0, max) : '');
const when = (value: unknown): Date => {
  const d = new Date(typeof value === 'string' ? value : NaN);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

// Devolve a mensagem pronta, ou null quando não há mais o que enviar (destinatário esquecido, pedido apagado...): a mensagem é cancelada.
export async function renderMessage(input: RenderInput, req: Request): Promise<Message | null> {
  if (!input.to || !isKind(input.kind)) return null;
  const kind: KindName = input.kind;
  const spec = input.spec ?? {};
  const brand = await loadBrand(req);
  switch (kind) {
    case 'already_registered':
      return alreadyRegisteredMessage(brand, { to: input.to, name: text(spec.name), loginUrl: `${brand.siteUrl}/conta` });
    case 'password_changed':
      return passwordChangedMessage(brand, { to: input.to, name: text(spec.name), loginUrl: `${brand.siteUrl}/conta`, when: when(spec.at) });
    case 'admin_reset_notice':
      return adminResetLinkNoticeMessage(brand, { to: input.to, name: text(spec.name), when: when(spec.at), loginUrl: `${brand.siteUrl}/conta` });
    case 'admin_new_login':
      return newAdminLoginMessage(brand, { to: input.to, name: text(spec.name), when: when(spec.at), device: text(spec.device, 80) || 'Navegador não identificado', ip: text(spec.ip, 64), panelUrl: `${brand.siteUrl}/admin` });
    default:
      // Tipos que são montados por quem chama (têm segredo) ou ainda sem receita: nada a refazer aqui.
      return null;
  }
}
