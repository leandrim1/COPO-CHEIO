import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { installErrorReporting } from './lib/report.ts';
import './index.css';

installErrorReporting();

// Site instalável (PWA): o service worker só guarda arquivos estáticos públicos e mostra "sem conexão" na navegação (ver public/sw.js). Não roda em
// desenvolvimento nem sob automação de teste (navigator.webdriver), para não interferir nas requisições que os testes observam.
if ('serviceWorker' in navigator && import.meta.env.PROD && !navigator.webdriver) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
