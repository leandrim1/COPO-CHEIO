// Avisa o servidor (só o log) quando o site quebra no navegador de alguém: tela branca, erro inesperado, promessa sem tratamento.
// Sem isso a loja só descobriria pelo cliente reclamando. Nada de dados pessoais: endereços com código de acompanhamento ou de
// redefinição de senha saem mascarados, e o servidor ainda limita quantos relatórios aceita por minuto.

const SECRET_PATHS = /(\/(?:pedido|acompanhar-pedido|conta\/redefinir|conta\/verificar)\/)[^/?#\s]+/g;

export const maskPath = (value: string) => value.replace(SECRET_PATHS, '$1:codigo');

let sent = 0;

export function reportClientError(kind: 'render' | 'script' | 'promise', error: unknown): void {
  // No máximo 5 por visita: um erro dentro de um laço não vira milhares de chamadas.
  if (sent >= 5) return;
  sent++;
  try {
    const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'erro sem detalhes');
    const body = JSON.stringify({ kind, message: maskPath(e.message), stack: maskPath(e.stack ?? ''), page: maskPath(window.location.pathname) });
    if (navigator.sendBeacon?.('/api/client-error', new Blob([body], { type: 'application/json' }))) return;
    void fetch('/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => undefined);
  } catch {
    /* relatar o erro nunca pode causar outro erro */
  }
}

export function installErrorReporting(): void {
  window.addEventListener('error', (event) => reportClientError('script', event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => reportClientError('promise', event.reason));
}
