import { ShieldAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { navigate } from '../lib/router';
import { useShop } from './data';
import { BrandName } from './ui';

// Confirmação de maioridade (18+) na entrada do site.
//
// O QUE ISTO É: um aviso de venda proibida para menores e uma declaração da própria pessoa ("tenho 18 anos ou mais"). NÃO é prova de idade: ninguém
// consegue provar a idade pelo navegador. Por isso a proteção não termina aqui: (1) o servidor recusa o pedido de bebida alcoólica sem a declaração
// no checkout (create_order, migration 0027) e (2) na entrega ou na retirada o documento oficial com foto é conferido, e o pedido é recusado se a
// maioridade não for comprovada (a conferência é registrada no painel). Não guardamos data de nascimento nem documento.
//
// Os textos desta janela e do checkout precisam da validação do responsável jurídico da loja (docs/JURIDICO-PENDENCIAS.md).

// Mudou o texto? Troque a versão: todo mundo vê a pergunta de novo.
export const AGE_TEXT_VERSION = 'v1';
// Começa com "copocheio:" como tudo o que o site guarda no aparelho: o botão "Apagar os dados deste aparelho" da política de privacidade também o apaga.
const STORAGE_KEY = `copocheio:age-${AGE_TEXT_VERSION}`;

// Páginas em que a pergunta aparece: onde se vê e se compra bebida. Política de privacidade, conta, acompanhamento do pedido e contato ficam livres.
export const AGE_GATED_PAGES = new Set(['home', 'bebidas', 'checkout']);

// Sem armazenamento (aba anônima, bloqueio de dados do site): a confirmação vale só enquanto a página não é recarregada.
let confirmedInMemory = false;

function storedConfirmation(): boolean {
  if (confirmedInMemory) return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberConfirmation(): void {
  confirmedInMemory = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* sem armazenamento: vale até recarregar */
  }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AgeGate({ page }: { page: string }) {
  const { store } = useShop();
  const gated = AGE_GATED_PAGES.has(page);
  const [confirmed, setConfirmed] = useState(storedConfirmation);
  const [declined, setDeclined] = useState(false);
  const open = gated && !confirmed;
  const dialogRef = useRef<HTMLDivElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();

  // Enquanto a pergunta está aberta: o resto da página não rola, não recebe foco nem é lido por leitores de tela (inert), e Tab fica preso na janela.
  useEffect(() => {
    if (!open) return;
    const root = document.getElementById('root');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root?.setAttribute('inert', '');
    const onKey = (e: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (e.key !== 'Tab' || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !dialog.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !dialog.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      root?.removeAttribute('inert');
    };
  }, [open]);

  // O foco vai para o botão principal de cada tela da janela. Quando ela fecha (a pessoa foi para uma página livre), a próxima abertura volta à pergunta.
  useEffect(() => {
    if (!open) {
      setDeclined(false);
      return;
    }
    (declined ? backRef.current : yesRef.current)?.focus();
  }, [open, declined]);

  if (!open) return null;

  const confirm = () => {
    rememberConfirmation();
    setConfirmed(true);
  };
  const whatsapp = (store.whatsapp ?? '').replace(/\D/g, '');

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/95 p-4" data-age-gate>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        className="relative w-full max-w-md overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#07080D] p-6 text-center shadow-[0_30px_90px_-30px_rgba(20,92,255,0.55)]"
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(90%_100%_at_50%_0%,rgba(20,92,255,0.28),transparent_75%)]" />
        <div className="relative">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#145CFF]/15 text-[#5B8CFF]">
            <ShieldAlert className="h-7 w-7" aria-hidden="true" />
          </span>
          <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.14em] text-[#8FB1FF]">
            <BrandName name={store.store_name} />
          </p>
          {declined ? (
            <>
              <h2 id={titleId} className="mt-2 text-2xl font-black leading-tight tracking-tight text-white">
                Só atendemos maiores de 18 anos
              </h2>
              <p id={textId} className="mt-3 text-sm leading-relaxed text-white/75">
                Bebidas alcoólicas não podem ser vendidas a menores de 18 anos. Você ainda pode ler a nossa política de privacidade
                {whatsapp ? ' ou falar com a loja' : ''}.
              </p>
              <div className="mt-6 flex flex-col gap-2.5">
                <button
                  ref={backRef}
                  type="button"
                  onClick={() => setDeclined(false)}
                  className="min-h-12 rounded-full border border-white/15 px-5 text-sm font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  Voltar
                </button>
              </div>
              <p className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm">
                <a
                  href="/privacidade"
                  onClick={(e) => {
                    // Esta é uma página livre: a janela some sozinha quando a página muda (o texto da pergunta só vale em /, /bebidas e /checkout).
                    e.preventDefault();
                    navigate('/privacidade');
                  }}
                  className="font-semibold text-[#8FB1FF] underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  Política de privacidade
                </a>
                {whatsapp && (
                  <a href={`https://wa.me/${whatsapp}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#8FB1FF] underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                    Falar com a loja
                  </a>
                )}
              </p>
            </>
          ) : (
            <>
              <h2 id={titleId} className="mt-2 text-2xl font-black leading-tight tracking-tight text-white">
                Venda proibida para menores de 18 anos
              </h2>
              <p id={textId} className="mt-3 text-sm leading-relaxed text-white/75">
                Aqui se vendem bebidas alcoólicas. Para continuar, confirme que você tem 18 anos ou mais. Na entrega ou na retirada pedimos um documento
                oficial com foto, e o pedido não é entregue a quem não comprovar a maioridade.
              </p>
              <div className="mt-6 flex flex-col gap-2.5">
                <button
                  ref={yesRef}
                  type="button"
                  onClick={confirm}
                  data-age-yes
                  className="min-h-12 rounded-full bg-[#145CFF] px-5 text-sm font-bold text-white shadow-[0_10px_30px_-10px_rgba(20,92,255,0.9)] transition-colors hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  Tenho 18 anos ou mais
                </button>
                <button
                  type="button"
                  onClick={() => setDeclined(true)}
                  data-age-no
                  className="min-h-12 rounded-full border border-white/15 px-5 text-sm font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  Tenho menos de 18 anos
                </button>
              </div>
            </>
          )}
          <p className="mt-5 text-xs font-bold uppercase tracking-wide text-white/55">Beba com moderação</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
