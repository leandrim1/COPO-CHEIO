import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import type { EmailPreferences } from '../lib/types';
import { ErrorLine, InfoLine, OkLine, Panel, Spinner, Title } from './accountUi';
import { PageShell } from './shell';
import { BLUE_BUTTON, GHOST_BUTTON } from './ui';

// Preferências de e-mail de quem recebe mensagens da loja:
//  • /conta/emails/<link do e-mail>: sem login, pelo link que vai em cada e-mail (cancelar promoções, não receber avisos de pedido);
//  • "Minha conta → E-mails": as mesmas escolhas para quem está logado.
// Promoções só podem ser LIGADAS por quem tem conta com e-mail confirmado (assim o dono da caixa de entrada é quem aceita).

function Toggle({ checked, onChange, disabled, label, description }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label: string; description: string }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="min-w-0">
        <p id={id} className="font-bold text-white">
          {label}
        </p>
        <p className="mt-1 text-sm text-white/60">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-[#145CFF]' : 'bg-white/25'}`}
      >
        <span className={`absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

type Source = { load: () => Promise<EmailPreferences>; save: (patch: Partial<Pick<EmailPreferences, 'marketing' | 'notify_orders'>>) => Promise<EmailPreferences> };

function usePrefs(source: Source) {
  const [prefs, setPrefs] = useState<EmailPreferences | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setPrefs(await source.load());
      setError(null);
    } catch (err) {
      setError({ status: err instanceof ApiError ? err.status : 0, message: friendlyError(err, 'Não foi possível carregar agora. Tente de novo em instantes.') });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const change = async (patch: Partial<Pick<EmailPreferences, 'marketing' | 'notify_orders'>>, saved: string) => {
    setBusy(true);
    setNote(null);
    try {
      setPrefs(await source.save(patch));
      setNote({ ok: true, text: saved });
    } catch (err) {
      setNote({ ok: false, text: friendlyError(err, 'Não foi possível salvar agora.') });
    } finally {
      setBusy(false);
    }
  };
  return { prefs, error, busy, note, change, reload: load };
}

function Choices({ prefs, busy, note, change, canEnableMarketing }: { prefs: EmailPreferences; busy: boolean; note: { ok: boolean; text: string } | null; change: ReturnType<typeof usePrefs>['change']; canEnableMarketing: boolean }) {
  return (
    <div className="space-y-3">
      <Toggle
        checked={prefs.marketing}
        disabled={busy || (!prefs.marketing && !canEnableMarketing)}
        onChange={(on) => void change({ marketing: on }, on ? 'Pronto: você vai receber novidades e promoções.' : 'Pronto: você não vai mais receber promoções.')}
        label="Novidades e promoções"
        description="Ofertas e novidades da loja, de vez em quando. Você pode cancelar quando quiser, aqui ou pelo link “Cancelar inscrição” de qualquer promoção."
      />
      {!prefs.marketing && !canEnableMarketing && (
        <InfoLine>
          Para receber promoções, entre na sua conta com o e-mail confirmado e ligue esta opção em <a href="/conta" className="font-semibold underline">Minha conta</a>. É assim que a gente tem certeza de que o e-mail é seu.
        </InfoLine>
      )}
      <Toggle
        checked={prefs.notify_orders}
        disabled={busy}
        onChange={(on) => void change({ notify_orders: on }, on ? 'Pronto: você vai receber os avisos dos pedidos.' : 'Pronto: você não vai mais receber avisos de pedidos neste endereço.')}
        label="Avisos dos meus pedidos"
        description="E-mail quando o pedido é recebido, confirmado, sai para entrega, é entregue ou cancelado, e quando um pagamento é confirmado."
      />
      {note && (note.ok ? <OkLine>{note.text}</OkLine> : <ErrorLine>{note.text}</ErrorLine>)}
      <p className="text-xs leading-relaxed text-white/55">
        Os e-mails da sua conta (código de confirmação, nova senha, aviso de senha alterada) são necessários para a sua segurança e continuam chegando. Para parar de receber qualquer e-mail da loja, ou apagar seus dados, use “Excluir minha conta” ou fale com a loja. Veja a{' '}
        <a href="/privacidade" className="font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
          política de privacidade
        </a>
        .
      </p>
    </div>
  );
}

// "Minha conta → E-mails" (logado).
export function EmailPrefsPanel() {
  const { prefs, error, busy, note, change, reload } = usePrefs({
    load: () => api.get<EmailPreferences>('/api/account/email-preferences'),
    save: (patch) => api.patch<EmailPreferences>('/api/account/email-preferences', patch),
  });
  return (
    <Panel id="emails" title="E-mails" subtitle="Escolha o que você quer receber da loja por e-mail.">
      {error ? (
        <div className="space-y-3">
          <ErrorLine>{error.message}</ErrorLine>
          <button type="button" onClick={() => void reload()} className={`${GHOST_BUTTON} !px-5 !py-2.5 text-sm`}>
            Tentar de novo
          </button>
        </div>
      ) : !prefs ? (
        <Spinner />
      ) : (
        <Choices prefs={prefs} busy={busy} note={note} change={change} canEnableMarketing />
      )}
    </Panel>
  );
}

// /conta/emails/<link do e-mail> (sem login).
export function EmailPreferencesPage({ token }: { token: string }) {
  useEffect(() => {
    document.title = 'Preferências de e-mail';
  }, []);
  const base = `/api/email/preferences/${encodeURIComponent(token)}`;
  const { prefs, error, busy, note, change } = usePrefs({
    load: () => api.get<EmailPreferences>(base),
    save: (patch) => api.patch<EmailPreferences>(base, patch),
  });

  return (
    <PageShell back="/" backLabel="Início">
      <div className="mx-auto max-w-xl">
        <Title sub={prefs?.email_masked ? `Para o endereço ${prefs.email_masked}` : 'Escolha o que você quer receber da loja por e-mail.'}>Preferências de e-mail</Title>
        <div className="mt-6">
          {error ? (
            <Panel id="invalido" title={error.status === 404 ? 'Link inválido ou vencido' : 'Não foi possível carregar'}>
              <p className="text-sm text-white/65">{error.status === 404 ? 'Este link de preferências não vale mais ou está incorreto. Use o link de um e-mail mais recente da loja, ou entre na sua conta.' : error.message}</p>
              <a href="/conta" className={`${BLUE_BUTTON} mt-5`}>
                Ir para Minha conta
              </a>
            </Panel>
          ) : !prefs ? (
            <Spinner />
          ) : (
            <Panel id="escolhas" title="O que você quer receber?">
              <Choices prefs={prefs} busy={busy} note={note} change={change} canEnableMarketing={Boolean(prefs.can_enable_marketing)} />
            </Panel>
          )}
        </div>
      </div>
    </PageShell>
  );
}
