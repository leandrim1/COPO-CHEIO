import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { copyText } from '../lib/tracking';

// Botão "Copiar" com retorno visual e aviso para leitores de tela (sem mexer no nome do botão).
export function CopyButton({ text, label, done = 'Copiado', className }: { text: string; label: string; done?: string; className: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void copyText(text).then((ok) => {
            setState(ok ? 'ok' : 'fail');
            window.setTimeout(() => setState('idle'), 2500);
          });
        }}
        className={className}
      >
        {state === 'ok' ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        {state === 'ok' ? done : state === 'fail' ? 'Não foi possível copiar' : label}
      </button>
      {/* Avisa leitores de tela sem mexer no nome do botão */}
      <span role="status" className="sr-only">
        {state === 'ok' ? done : state === 'fail' ? 'Não foi possível copiar' : ''}
      </span>
    </>
  );
}
