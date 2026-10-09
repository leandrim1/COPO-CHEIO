// Código de acompanhamento no navegador: só para dar retorno rápido a quem digita ou cola. Quem decide
// se o código vale é sempre o servidor.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Aceita o código puro, em minúsculas, sem hifens, com espaços, ou o link inteiro colado.
export function normalizeCode(input: string): string | null {
  let text = input.trim();
  if (text.includes('/')) text = (text.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() ?? '').trim();
  if (UUID.test(text)) return text.toLowerCase();
  const compact = text
    .toUpperCase()
    .replace(/[\s_-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(compact)) return null;
  return compact.match(/.{5}/g)!.join('-');
}

export const trackingPath = (token: string) => `/acompanhar-pedido/${token}`;
export const trackingUrl = (token: string) => `${window.location.origin}${trackingPath(token)}`;

// Copia para a área de transferência (com plano B para navegadores sem a API moderna).
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
