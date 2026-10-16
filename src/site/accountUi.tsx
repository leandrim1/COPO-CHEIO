import { Check, Info, LoaderCircle, TriangleAlert, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { suggestEmail } from './emailHint';
import { BLUE_BUTTON } from './ui';

// Peças de tela compartilhadas pelas páginas da conta do cliente (Account.tsx e EmailPreferences.tsx).

export function Panel({ id, title, subtitle, children }: { id: string; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-[1.75rem] border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5 sm:p-6">
      <h2 id={id} className="text-lg font-black text-white">
        {title}
      </h2>
      {subtitle && <p className="mt-1 text-sm text-white/60">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-100">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}

export function OkLine({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="status" className="flex items-start gap-2 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-3.5 py-2.5 text-sm text-emerald-100">
      <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}

export function InfoLine({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  if (!children) return null;
  const Icon = tone === 'warn' ? TriangleAlert : Info;
  return (
    <p
      role="status"
      className={`flex items-start gap-2 rounded-2xl border px-3.5 py-2.5 text-sm ${tone === 'warn' ? 'border-amber-400/30 bg-amber-400/10 text-amber-100' : 'border-[#2563FF]/40 bg-[#145CFF]/10 text-blue-100'}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function Submit({ busy, children, className = '' }: { busy: boolean; children: ReactNode; className?: string }) {
  return (
    <button type="submit" disabled={busy} className={`${BLUE_BUTTON} w-full disabled:cursor-not-allowed disabled:opacity-60 ${className}`}>
      {busy ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export const Spinner = () => (
  <div className="mt-20 flex justify-center" role="status" aria-label="Carregando">
    <LoaderCircle className="h-10 w-10 animate-spin text-[#2563FF]" aria-hidden="true" />
  </div>
);

export const Title = ({ children, sub }: { children: ReactNode; sub?: string }) => (
  <>
    <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">{children}</h1>
    {sub && <p className="mt-2 max-w-2xl text-white/60">{sub}</p>}
  </>
);

// Campo de e-mail de qualquer provedor. Teclado de e-mail, sem maiúscula automática nem autocorreção (o iPhone e o Android, por padrão, trocam
// letras de endereços como "joao.silva@icloud.com"): o endereço chega ao servidor exatamente como foi digitado.
export const EMAIL_INPUT = {
  type: 'email',
  inputMode: 'email',
  autoComplete: 'email',
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
  maxLength: 254,
} as const;

export const ANY_PROVIDER_HINT = 'Pode ser de qualquer provedor: Gmail, iCloud, Outlook, Hotmail, Yahoo ou o e-mail da sua empresa. Não precisa ter Gmail nem instalar nenhum aplicativo.';

// "Você quis dizer maria@gmail.com?" — só aparece quando o domínio parece um erro de digitação de um provedor popular. É uma sugestão: o endereço
// digitado continua valendo se a pessoa ignorar (qualquer provedor ou empresa é aceito).
export function EmailSuggestion({ email, show, onUse }: { email: string; show: boolean; onUse: (corrected: string) => void }) {
  const suggestion = show ? suggestEmail(email) : null;
  if (!suggestion) return null;
  return (
    <p role="status" className="mt-1.5 text-xs text-amber-100" data-email-suggestion>
      Você quis dizer{' '}
      <button type="button" onClick={() => onUse(suggestion)} className="font-bold text-[#8FB1FF] underline underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
        {suggestion}
      </button>
      ?
    </p>
  );
}
