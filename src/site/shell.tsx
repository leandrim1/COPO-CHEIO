import { ArrowLeft } from 'lucide-react';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { Footer } from './ui';
import { useShop } from './data';

// Peças compartilhadas pelas páginas do cliente (checkout, acompanhamento, conta).

export function Field({
  label,
  error,
  hint,
  children,
  className = '',
}: {
  label: string;
  error?: string;
  hint?: string;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const describedBy = error ? `${id}-erro` : hint ? `${id}-dica` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-white/80">
        {label}
      </label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {error ? (
        <p id={`${id}-erro`} className="mt-1.5 text-xs font-medium text-rose-300">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-dica`} className="mt-1.5 text-xs text-white/45">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function PageShell({ back, backLabel, children }: { back: string; backLabel: string; children: ReactNode }) {
  const { store, logo } = useShop();
  return (
    <div className="relative min-h-[100dvh] overflow-x-clip bg-[#050505]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 top-0 h-96 w-96 rounded-full bg-[#145CFF]/15 blur-3xl cc-glow" />
        <div className="absolute -right-40 top-1/2 h-96 w-96 rounded-full bg-[#2563FF]/10 blur-3xl cc-glow [animation-delay:2s]" />
      </div>
      <header className="relative mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
        <a
          href={back}
          className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white backdrop-blur-md transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {backLabel}
        </a>
        <a href="/" className="flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" aria-label={`${store.store_name} – início`}>
          <img src={logo} alt="" width={40} height={40} className="h-10 w-10 rounded-full object-contain ring-1 ring-white/15 shadow-[0_0_24px_rgba(20,92,255,0.55)]" />
        </a>
      </header>
      <div className="relative mx-auto w-full max-w-5xl px-4 pb-24 pt-6 sm:px-6">{children}</div>
      <Footer />
    </div>
  );
}
