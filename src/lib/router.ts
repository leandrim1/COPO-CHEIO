import { useEffect, useSyncExternalStore } from 'react';

// Rotas sem biblioteca: links internos trocam a página sem recarregar (history.pushState).
// O vercel.json manda qualquer caminho para o index.html, então todas as rotas abrem direto também.

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

const getLocation = () => window.location.pathname + window.location.search + window.location.hash;

export function navigate(to: string, { replace = false }: { replace?: boolean } = {}) {
  if (to === window.location.pathname + window.location.search + window.location.hash) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
  notify();
}

// Caminho atual, sem a barra do final ("/bebidas/" → "/bebidas").
export function usePathname(): string {
  const location = useSyncExternalStore(subscribe, getLocation, getLocation);
  const pathname = location.split(/[?#]/)[0];
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

// Caminhos de arquivos (imagens, json...) não são páginas do app.
const isAppPath = (pathname: string) => !/\.[a-z0-9]{2,5}$/i.test(pathname);

// Intercepta cliques em <a href="/..."> do próprio site.
export function useLinkInterception() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a');
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || !isAppPath(url.pathname)) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        // Mesma página: "#seção" rola sozinho; um link para esta página volta ao topo.
        if (!url.hash) {
          e.preventDefault();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }
      e.preventDefault();
      navigate(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}
