import { Component } from 'react';
import type { ReactNode } from 'react';
import { reportClientError } from './lib/report';

// Rede de segurança: se alguma tela quebrar ao desenhar (dado inesperado, bug), a pessoa vê esta mensagem em vez de uma tela
// branca, com a saída óbvia (recarregar ou voltar ao início). Fica fora do ShopProvider de propósito: não depende de nada que possa ter quebrado.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    reportClientError('render', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" className="grid min-h-[100dvh] place-items-center bg-[#050505] px-6 py-16 text-center">
        <div className="max-w-md">
          <h1 className="text-2xl font-black text-white">Algo deu errado por aqui</h1>
          <p className="mt-3 text-white/70">Isso não era para acontecer. Recarregue a página; se continuar, volte ao início ou chame a gente pelo WhatsApp.</p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center justify-center rounded-full bg-[#145CFF] px-6 py-3.5 text-[15px] font-extrabold text-white hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Recarregar a página
            </button>
            <a
              href="/"
              className="inline-flex items-center justify-center rounded-full border border-white/25 bg-white/5 px-6 py-3.5 text-[15px] font-semibold text-white hover:border-white/50 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Ir para o início
            </a>
          </div>
        </div>
      </main>
    );
  }
}
