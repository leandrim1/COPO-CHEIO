import { Check, ChevronDown, Info, LoaderCircle, LogOut, Mail, RefreshCw, ShoppingBag, TriangleAlert, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import { maskPhone, onlyDigits } from '../lib/format';
import { navigate } from '../lib/router';
import { normalizeCode } from '../lib/tracking';
import type { AccountOrderSummary, CustomerAccount, PublicOrder, VerificationInfo } from '../lib/types';
import { getLoginPrefill, getRecoverPrefill, logoutCustomer, safeReturn, setCustomer, setLoginPrefill, setRecoverPrefill, useCustomer } from './customer';
import { useShop } from './data';
import { Field, PageShell } from './shell';
import { OrderListItem, useActiveOrders } from './OrderList';
import { OrderView } from './Tracking';
import { BLUE_BUTTON, FIELD, GHOST_BUTTON } from './ui';
import { useOrderFeed } from './useOrderFeed';

const query = () => new URLSearchParams(window.location.search);

// ---- Peças ----------------------------------------------------------------------------------------

function Panel({ id, title, subtitle, children }: { id: string; title: string; subtitle?: string; children: ReactNode }) {
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

function ErrorLine({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-100">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}

function OkLine({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="status" className="flex items-start gap-2 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-3.5 py-2.5 text-sm text-emerald-100">
      <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}

function InfoLine({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
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

function Submit({ busy, children, className = '' }: { busy: boolean; children: ReactNode; className?: string }) {
  return (
    <button type="submit" disabled={busy} className={`${BLUE_BUTTON} w-full disabled:cursor-not-allowed disabled:opacity-60 ${className}`}>
      {busy ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

const Spinner = () => (
  <div className="mt-20 flex justify-center" role="status" aria-label="Carregando">
    <LoaderCircle className="h-10 w-10 animate-spin text-[#2563FF]" aria-hidden="true" />
  </div>
);

const Title = ({ children, sub }: { children: ReactNode; sub?: string }) => (
  <>
    <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">{children}</h1>
    {sub && <p className="mt-2 max-w-2xl text-white/60">{sub}</p>}
  </>
);

// ---- Entrar / criar conta ------------------------------------------------------------------------------

// Conta criada (ou tentando entrar) cujo e-mail ainda não foi confirmado: a pessoa digita o código que chegou na caixa de entrada.
type Pending = {
  email: string;
  // Só na memória desta tela (nunca em localStorage): serve para entrar sozinho depois de confirmar o código.
  password: string;
  resendIn: number;
  codeMinutes: number;
  notice: string;
  mailAvailable: boolean;
};

type RegisterResponse = VerificationInfo & { status: 'pending_verification' };

const number = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const mmss = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

// Contagem regressiva em segundos até a hora marcada (não perde tempo se a aba ficar em segundo plano).
function useCountdown(initial: number) {
  const [until, setUntil] = useState(() => Date.now() + initial * 1000);
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [until]);
  return [left, (seconds: number) => setUntil(Date.now() + seconds * 1000)] as const;
}

function VerifyStep({ pending, onConfirmed, onBack }: { pending: Pending; onConfirmed: (customer: CustomerAccount | null) => void; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [resends, setResends] = useState(0);
  const [left, restart] = useCountdown(pending.resendIn);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (code.length !== 6) {
      setError('Digite os 6 dígitos do código que enviamos por e-mail.');
      input.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/account/verify-email', { email: pending.email, code });
    } catch (err) {
      setBusy(false);
      setError(friendlyError(err, 'Não foi possível confirmar agora. Tente de novo em instantes.'));
      setCode('');
      input.current?.focus();
      return;
    }
    // E-mail confirmado. Entra sozinho com a senha que acabou de ser digitada; se não der, a tela pede o login.
    try {
      const { customer } = await api.post<{ customer: CustomerAccount }>('/api/account/login', { email: pending.email, password: pending.password });
      onConfirmed(customer);
    } catch {
      onConfirmed(null);
    }
  };

  const resend = async () => {
    setError('');
    setInfo('');
    setSending(true);
    try {
      const data = await api.post<{ resend_in?: number }>('/api/account/resend-verification', { email: pending.email });
      restart(number(data.resend_in, 60));
      setResends((n) => n + 1);
      setCode('');
      setInfo(`Pedimos um novo código para ${pending.email}. Ele costuma chegar em até 1 minuto, e o código anterior só deixa de valer quando o novo chegar.`);
      input.current?.focus();
    } catch (err) {
      setError(friendlyError(err, 'Não foi possível reenviar agora. Tente de novo em instantes.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <InfoLine tone={pending.mailAvailable ? 'info' : 'warn'}>{pending.notice}</InfoLine>
      <Field label="Código de confirmação" error={undefined} hint={`Os 6 dígitos do e-mail. O código vale por ${pending.codeMinutes} minutos e só pode ser usado uma vez.`}>
        {(p) => (
          <input
            {...p}
            ref={input}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
              setError('');
            }}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            maxLength={12}
            spellCheck={false}
            placeholder="000000"
            className={`${FIELD} text-center font-mono text-2xl font-bold tracking-[0.35em]`}
          />
        )}
      </Field>
      <ErrorLine>{error}</ErrorLine>
      <OkLine>{info}</OkLine>
      <Submit busy={busy}>Confirmar e-mail</Submit>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={() => void resend()}
          disabled={left > 0 || sending}
          className="inline-flex items-center justify-center gap-2 rounded-full px-1 py-1 text-sm font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline disabled:cursor-not-allowed disabled:text-white/40 disabled:no-underline"
        >
          {sending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {left > 0 ? `Reenviar código em ${mmss(left)}` : 'Reenviar código'}
        </button>
        <button type="button" onClick={onBack} className="text-sm font-semibold text-white/60 underline-offset-4 hover:text-white hover:underline">
          Usar outro e-mail
        </button>
      </div>
      <p className="text-xs leading-relaxed text-white/45">
        Não chegou? Veja a caixa de spam ou lixo eletrônico e confira se o e-mail está certo.
        {resends >= 2 && ' Por segurança, limitamos quantos códigos podem ser enviados por hora: se ainda não chegou, aguarde um pouco e tente de novo.'} Sua conta só é ativada depois que o código for confirmado.
      </p>
    </form>
  );
}

function AuthForms({ initial }: { initial: 'entrar' | 'cadastro' }) {
  const [tab, setTab] = useState(initial);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [form, setForm] = useState(() => ({ name: '', email: getLoginPrefill(), phone: '', password: '' }));
  const set = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };
  useEffect(() => () => setLoginPrefill(''), []);

  const done = (customer: CustomerAccount) => {
    setLoginPrefill('');
    setCustomer(customer);
    const back = safeReturn(query().get('voltar'));
    if (back) navigate(back, { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    const next: Record<string, string> = {};
    const email = form.email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) next.email = 'Confira o e-mail.';
    if (tab === 'entrar') {
      if (!form.password) next.password = 'Informe a senha.';
    } else {
      if (form.name.trim().length < 2) next.name = 'Informe seu nome.';
      const phone = onlyDigits(form.phone);
      if (phone.length < 10 || phone.length > 11) next.phone = 'Informe um telefone com DDD.';
      if (form.password.length < 8) next.password = 'Use pelo menos 8 caracteres.';
    }
    setErrors(next);
    if (Object.keys(next).length) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      if (tab === 'entrar') {
        const { customer } = await api.post<{ customer: CustomerAccount }>('/api/account/login', { email, password: form.password });
        done(customer);
      } else {
        // A conta nasce "pendente": nada de sessão até confirmar o código que o servidor manda por e-mail.
        const res = await api.post<RegisterResponse>('/api/account/register', { name: form.name.trim(), email, phone: onlyDigits(form.phone), password: form.password });
        setPending({
          email: res.email,
          password: form.password,
          resendIn: number(res.resend_in, 60),
          codeMinutes: number(res.code_minutes, 15),
          mailAvailable: true,
          notice: `Enviamos um código de 6 dígitos para ${res.email}. Digite-o abaixo para ativar a sua conta.`,
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'email_not_verified') {
        // Senha certa, mas o e-mail ainda não foi confirmado: leva para a tela do código.
        const d = err.data;
        const available = d.mail_available !== false;
        const address = typeof d.email === 'string' ? d.email : email;
        setPending({
          email: address,
          password: form.password,
          resendIn: number(d.resend_in, 60),
          codeMinutes: number(d.code_minutes, 15),
          mailAvailable: available,
          notice: !available
            ? 'Sua conta ainda não foi ativada, e o envio de e-mails da loja está indisponível no momento. Tente de novo mais tarde.'
            : d.sent
              ? `Sua conta ainda não foi ativada. Enviamos um novo código de 6 dígitos para ${address}.`
              : `Sua conta ainda não foi ativada: falta confirmar o e-mail ${address}. Use o último código que enviamos ou peça outro.`,
        });
      } else if (err instanceof ApiError && ['invalid_email', 'invalid_email_domain', 'mail_recipient_rejected'].includes(err.code ?? '')) {
        setErrors({ email: err.message });
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      } else {
        setError(friendlyError(err, 'Não foi possível continuar agora. Tente de novo em instantes.'));
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmed = (customer: CustomerAccount | null) => {
    if (customer) return done(customer);
    // E-mail confirmado, mas não foi possível entrar sozinho: pede o login normal.
    setForm((f) => ({ ...f, email: pending?.email ?? f.email, password: '' }));
    setPending(null);
    setTab('entrar');
    setNotice('E-mail confirmado! Agora entre com o seu e-mail e a sua senha.');
  };

  const useOtherEmail = () => {
    setPending(null);
    setTab('cadastro');
    setForm((f) => ({ ...f, email: '' }));
    requestAnimationFrame(() => document.querySelector<HTMLElement>('input[type="email"]')?.focus());
  };

  if (pending) {
    return (
      <Panel id="confirmar" title="Confirme seu e-mail" subtitle="Falta pouco: confirme que este e-mail é seu para ativar a conta.">
        <VerifyStep pending={pending} onConfirmed={confirmed} onBack={useOtherEmail} />
      </Panel>
    );
  }

  return (
    <Panel id="acesso" title={tab === 'entrar' ? 'Entrar na minha conta' : 'Criar minha conta'}>
      <div role="tablist" aria-label="Conta" className="mb-5 grid grid-cols-2 gap-1 rounded-full border border-white/10 bg-black/30 p-1">
        {(['entrar', 'cadastro'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              setError('');
              setNotice('');
              setErrors({});
            }}
            className={`rounded-full px-4 py-2 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${tab === t ? 'bg-[#145CFF] text-white' : 'text-white/60 hover:text-white'}`}
          >
            {t === 'entrar' ? 'Entrar' : 'Criar conta'}
          </button>
        ))}
      </div>
      <form onSubmit={submit} noValidate className="space-y-4">
        <OkLine>{notice}</OkLine>
        {tab === 'cadastro' && (
          <>
            <Field label="Nome *" error={errors.name}>
              {(p) => <input {...p} value={form.name} onChange={(e) => set('name', e.target.value)} autoComplete="name" maxLength={80} className={FIELD} placeholder="Como podemos te chamar?" />}
            </Field>
            <Field label="Telefone / WhatsApp *" error={errors.phone} hint="Usado para ligar o seu pedido de visitante à conta.">
              {(p) => <input {...p} type="tel" inputMode="tel" value={form.phone} onChange={(e) => set('phone', maskPhone(e.target.value))} autoComplete="tel-national" className={FIELD} placeholder="(34) 99999-0000" />}
            </Field>
          </>
        )}
        <Field label="E-mail *" error={errors.email} hint={tab === 'cadastro' ? 'Enviaremos um código para confirmar que o e-mail é seu.' : undefined}>
          {(p) => <input {...p} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" maxLength={254} className={FIELD} placeholder="voce@email.com" />}
        </Field>
        <Field label="Senha *" error={errors.password} hint={tab === 'cadastro' ? 'Pelo menos 8 caracteres.' : undefined}>
          {(p) => (
            <input
              {...p}
              type="password"
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              autoComplete={tab === 'entrar' ? 'current-password' : 'new-password'}
              maxLength={200}
              className={FIELD}
            />
          )}
        </Field>
        <ErrorLine>{error}</ErrorLine>
        <Submit busy={busy}>
          {tab === 'cadastro' && !busy ? <Mail className="h-5 w-5" aria-hidden="true" /> : null}
          {tab === 'entrar' ? 'Entrar' : 'Criar conta e receber o código'}
        </Submit>
        {tab === 'entrar' && (
          <p className="text-center text-sm">
            <a href="/conta/recuperar" onClick={() => setRecoverPrefill(form.email.trim())} className="font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
              Esqueci minha senha
            </a>
          </p>
        )}
        {tab === 'cadastro' && <p className="text-xs text-white/45">Usamos seus dados só para entregar e acompanhar seus pedidos. A conta só é ativada depois que você confirmar o código enviado ao seu e-mail. Você pode excluir a conta quando quiser.</p>}
      </form>
    </Panel>
  );
}

// ---- /conta/verificar/:token (link do e-mail) -----------------------------------------------------------

// O link do e-mail só abre esta tela; a confirmação acontece no clique (leitores de e-mail que "abrem" links sozinhos não gastam o link).
export function VerifyLinkPage({ token }: { token: string }) {
  const [phase, setPhase] = useState<'ready' | 'busy' | 'done' | 'error'>('ready');
  const [error, setError] = useState('');
  const [masked, setMasked] = useState('');
  useEffect(() => {
    document.title = 'Confirmar e-mail';
  }, []);

  const confirm = async () => {
    setPhase('busy');
    setError('');
    try {
      const data = await api.post<{ email: string; email_masked: string }>('/api/account/verify-link', { token });
      setLoginPrefill(data.email);
      setMasked(data.email_masked);
      setPhase('done');
    } catch (err) {
      setError(friendlyError(err, 'Não foi possível confirmar agora. Tente de novo em instantes.'));
      setPhase(err instanceof ApiError && err.status >= 500 ? 'ready' : 'error');
    }
  };

  return (
    <PageShell back="/conta" backLabel="Minha conta">
      <div className="mx-auto max-w-md">
        <Title>Confirmar e-mail</Title>
        <div className="mt-6">
          {phase === 'done' ? (
            <Panel id="ok" title="E-mail confirmado!">
              <OkLine>Sua conta foi ativada{masked ? ` (${masked})` : ''}. Agora é só entrar com o seu e-mail e a sua senha.</OkLine>
              <a href="/conta" className={`${BLUE_BUTTON} mt-4 w-full`}>
                Entrar na minha conta
              </a>
            </Panel>
          ) : phase === 'error' ? (
            <Panel id="erro" title="Não foi possível confirmar">
              <ErrorLine>{error}</ErrorLine>
              <a href="/conta" className={`${BLUE_BUTTON} mt-4 w-full`}>
                Ir para a minha conta
              </a>
            </Panel>
          ) : (
            <Panel id="confirmar" title="Falta só um toque" subtitle="Toque no botão para confirmar que este e-mail é seu e ativar a conta.">
              <ErrorLine>{error}</ErrorLine>
              <button type="button" onClick={() => void confirm()} disabled={phase === 'busy'} className={`${BLUE_BUTTON} ${error ? 'mt-4' : ''} w-full disabled:cursor-not-allowed disabled:opacity-60`}>
                {phase === 'busy' ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Check className="h-5 w-5" aria-hidden="true" />}
                Confirmar meu e-mail
              </button>
            </Panel>
          )}
        </div>
      </div>
    </PageShell>
  );
}

// ---- Vincular pedido de visitante ----------------------------------------------------------------------

function ClaimForm({ onClaimed }: { onClaimed?: () => void }) {
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setOk(null);
    const digits = number.trim().replace(/^#/, '');
    const normalized = normalizeCode(code);
    if (!/^\d{1,12}$/.test(digits)) return setError('Informe o número do pedido (só números).');
    if (!normalized) return setError('Confira o código de acompanhamento (20 letras e números).');
    setBusy(true);
    try {
      await api.post('/api/account/orders/claim', { order_number: digits, code: normalized });
      setOk(Number(digits));
      setNumber('');
      setCode('');
      onClaimed?.();
    } catch (err) {
      setError(friendlyError(err, 'Não foi possível vincular o pedido agora.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <Field label="Número do pedido">
          {(p) => <input {...p} value={number} onChange={(e) => setNumber(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={14} className={FIELD} placeholder="#1001" />}
        </Field>
        <Field label="Código de acompanhamento">
          {(p) => <input {...p} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={160} className={`${FIELD} font-mono`} placeholder="7K3M9-QX2VB-4HRD6-WTP8N" />}
        </Field>
      </div>
      <ErrorLine>{error}</ErrorLine>
      <OkLine>{ok !== null ? `Pedido #${ok} salvo na sua conta.` : ''}</OkLine>
      <Submit busy={busy} className="sm:w-auto">
        Vincular pedido
      </Submit>
    </form>
  );
}

// ---- /conta ----------------------------------------------------------------------------------------------

function Profile({ customer }: { customer: CustomerAccount }) {
  const { zones } = useShop();
  // Pedidos ainda em andamento, para acompanhar sem procurar o link da confirmação.
  const { orders: active } = useActiveOrders();
  const [form, setForm] = useState({
    name: customer.name,
    phone: maskPhone(customer.phone.replace(/^55(?=\d{11}$)/, '')),
    address: customer.address ?? '',
    address_number: customer.address_number ?? '',
    neighborhood: customer.neighborhood ?? '',
    complement: customer.complement ?? '',
    reference: customer.reference ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setMsg(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (form.name.trim().length < 2) return setMsg({ ok: false, text: 'Informe seu nome.' });
    if (onlyDigits(form.phone).length < 10) return setMsg({ ok: false, text: 'Informe um telefone com DDD.' });
    setSaving(true);
    try {
      const { customer: updated } = await api.patch<{ customer: CustomerAccount }>('/api/account', {
        name: form.name.trim(),
        phone: onlyDigits(form.phone),
        address: form.address.trim() || null,
        address_number: form.address_number.trim() || null,
        neighborhood: form.neighborhood.trim() || null,
        complement: form.complement.trim() || null,
        reference: form.reference.trim() || null,
      });
      setCustomer(updated);
      setMsg({ ok: true, text: 'Dados salvos. Eles já vêm preenchidos no seu próximo pedido.' });
    } catch (err) {
      setMsg({ ok: false, text: friendlyError(err, 'Não foi possível salvar agora.') });
    } finally {
      setSaving(false);
    }
  };

  const [pass, setPass] = useState({ current: '', next: '' });
  const [passMsg, setPassMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [passBusy, setPassBusy] = useState(false);
  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (pass.next.length < 8) return setPassMsg({ ok: false, text: 'A senha nova precisa ter pelo menos 8 caracteres.' });
    setPassBusy(true);
    try {
      await api.patch('/api/account/password', pass);
      setPass({ current: '', next: '' });
      setPassMsg({ ok: true, text: 'Senha alterada. Os outros aparelhos foram desconectados.' });
    } catch (err) {
      setPassMsg({ ok: false, text: friendlyError(err, 'Não foi possível trocar a senha agora.') });
    } finally {
      setPassBusy(false);
    }
  };

  const [del, setDel] = useState({ open: false, password: '', error: '', busy: false });
  const remove = async (e: FormEvent) => {
    e.preventDefault();
    setDel((d) => ({ ...d, busy: true, error: '' }));
    try {
      await api.delete('/api/account', { password: del.password });
      setCustomer(null);
      navigate('/', { replace: true });
    } catch (err) {
      setDel((d) => ({ ...d, busy: false, error: friendlyError(err, 'Não foi possível excluir agora.') }));
    }
  };

  return (
    <>
      <Title sub={customer.email}>Olá, {customer.name.split(' ')[0]}!</Title>
      {active && active.length > 0 && (
        <section aria-labelledby="atual" className="mt-6">
          <h2 id="atual" className="mb-3 text-lg font-black text-white">
            {active.length === 1 ? 'Seu pedido em andamento' : 'Seus pedidos em andamento'}
          </h2>
          <ul className="space-y-3">
            {active.map((o) => (
              <OrderListItem key={o.order_number} o={o} />
            ))}
          </ul>
        </section>
      )}
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <a href="/conta/pedidos" className={BLUE_BUTTON}>
          Meus pedidos
        </a>
        <a href="/bebidas" className={GHOST_BUTTON}>
          Fazer um pedido
        </a>
        <button type="button" onClick={() => void logoutCustomer().then(() => navigate('/'))} className={GHOST_BUTTON}>
          <LogOut className="h-4 w-4" aria-hidden="true" /> Sair
        </button>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-2 lg:items-start">
        <Panel id="dados" title="Meus dados" subtitle="O endereço fica guardado só para você não precisar digitar de novo.">
          <form onSubmit={save} noValidate className="grid gap-4 sm:grid-cols-6">
            <Field label="Nome" className="sm:col-span-6">
              {(p) => <input {...p} value={form.name} onChange={(e) => set('name', e.target.value)} autoComplete="name" maxLength={80} className={FIELD} />}
            </Field>
            <Field label="Telefone / WhatsApp" className="sm:col-span-6">
              {(p) => <input {...p} type="tel" inputMode="tel" value={form.phone} onChange={(e) => set('phone', maskPhone(e.target.value))} autoComplete="tel-national" className={FIELD} />}
            </Field>
            <Field label="Rua / Avenida" className="sm:col-span-4">
              {(p) => <input {...p} value={form.address} onChange={(e) => set('address', e.target.value)} autoComplete="address-line1" maxLength={120} className={FIELD} />}
            </Field>
            <Field label="Número" className="sm:col-span-2">
              {(p) => <input {...p} value={form.address_number} onChange={(e) => set('address_number', e.target.value)} maxLength={20} className={FIELD} />}
            </Field>
            <Field label="Bairro" className="sm:col-span-3">
              {(p) =>
                zones.length ? (
                  <select {...p} value={zones.some((z) => z.name === form.neighborhood) ? form.neighborhood : ''} onChange={(e) => set('neighborhood', e.target.value)} className={`${FIELD} appearance-none`}>
                    <option value="" className="bg-[#0A0D14]">
                      Escolha o bairro
                    </option>
                    {zones.map((z) => (
                      <option key={z.id} value={z.name} className="bg-[#0A0D14]">
                        {z.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input {...p} value={form.neighborhood} onChange={(e) => set('neighborhood', e.target.value)} maxLength={60} className={FIELD} />
                )
              }
            </Field>
            <Field label="Complemento" className="sm:col-span-3">
              {(p) => <input {...p} value={form.complement} onChange={(e) => set('complement', e.target.value)} maxLength={60} className={FIELD} />}
            </Field>
            <Field label="Ponto de referência" className="sm:col-span-6">
              {(p) => <input {...p} value={form.reference} onChange={(e) => set('reference', e.target.value)} maxLength={120} className={FIELD} />}
            </Field>
            <div className="space-y-3 sm:col-span-6">
              {msg && (msg.ok ? <OkLine>{msg.text}</OkLine> : <ErrorLine>{msg.text}</ErrorLine>)}
              <Submit busy={saving}>Salvar meus dados</Submit>
            </div>
          </form>
        </Panel>

        <div className="space-y-5">
          <Panel id="vincular" title="Vincular um pedido de visitante" subtitle="Fez um pedido sem entrar na conta? Informe o número e o código de acompanhamento para ele aparecer em “Meus pedidos”.">
            <ClaimForm />
          </Panel>

          <Panel id="senha" title="Trocar senha">
            <form onSubmit={changePassword} noValidate className="space-y-4">
              <Field label="Senha atual">
                {(p) => <input {...p} type="password" value={pass.current} onChange={(e) => setPass({ ...pass, current: e.target.value })} autoComplete="current-password" maxLength={200} className={FIELD} />}
              </Field>
              <Field label="Senha nova" hint="Pelo menos 8 caracteres.">
                {(p) => <input {...p} type="password" value={pass.next} onChange={(e) => setPass({ ...pass, next: e.target.value })} autoComplete="new-password" maxLength={200} className={FIELD} />}
              </Field>
              {passMsg && (passMsg.ok ? <OkLine>{passMsg.text}</OkLine> : <ErrorLine>{passMsg.text}</ErrorLine>)}
              <Submit busy={passBusy}>Trocar senha</Submit>
            </form>
          </Panel>

          <Panel id="excluir" title="Excluir minha conta">
            <p className="text-sm text-white/60">
              Apaga seu cadastro e o endereço guardado. Os pedidos já feitos ficam no histórico da loja, sem ligação com a conta, e continuam acessíveis pelo link de acompanhamento.
            </p>
            {!del.open ? (
              <button type="button" onClick={() => setDel({ ...del, open: true })} className="mt-4 text-sm font-semibold text-rose-300 underline-offset-4 hover:text-rose-200 hover:underline">
                Quero excluir minha conta
              </button>
            ) : (
              <form onSubmit={remove} className="mt-4 space-y-3">
                <Field label="Digite sua senha para confirmar">
                  {(p) => <input {...p} type="password" value={del.password} onChange={(e) => setDel({ ...del, password: e.target.value })} autoComplete="current-password" className={FIELD} />}
                </Field>
                <ErrorLine>{del.error}</ErrorLine>
                <div className="flex gap-3">
                  <button type="submit" disabled={del.busy || !del.password} className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-rose-500 px-5 py-3 text-sm font-extrabold text-white hover:bg-rose-400 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                    {del.busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />} Excluir definitivamente
                  </button>
                  <button type="button" onClick={() => setDel({ open: false, password: '', error: '', busy: false })} className={`${GHOST_BUTTON} !px-5 !py-3 text-sm`}>
                    Cancelar
                  </button>
                </div>
              </form>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

export function AccountPage() {
  const { status, customer, reload } = useCustomer();
  useEffect(() => {
    document.title = 'Minha conta';
  }, []);
  const aba = query().get('aba') === 'cadastro' ? 'cadastro' : 'entrar';

  return (
    <PageShell back="/" backLabel="Início">
      {status === 'in' && customer ? (
        <Profile customer={customer} />
      ) : status === 'out' ? (
        <div className="mx-auto max-w-md">
          <Title sub="Criar uma conta é opcional: você pode pedir e acompanhar seus pedidos sem cadastro.">Minha conta</Title>
          <div className="mt-6">
            <AuthForms initial={aba} />
          </div>
          <p className="mt-5 text-center text-sm text-white/55">
            Prefere não se cadastrar?{' '}
            <a href="/acompanhar-pedido" className="font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
              Acompanhe um pedido sem conta
            </a>
          </p>
        </div>
      ) : status === 'error' ? (
        <div className="mx-auto mt-10 max-w-md text-center">
          <h1 className="text-2xl font-black text-white">Não foi possível carregar sua conta</h1>
          <p className="mt-2 text-white/65">Sem conexão com o servidor. Tente de novo em instantes.</p>
          <button type="button" onClick={() => void reload()} className={`${BLUE_BUTTON} mt-6`}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Tentar de novo
          </button>
        </div>
      ) : (
        <Spinner />
      )}
    </PageShell>
  );
}

// ---- /conta/pedidos -------------------------------------------------------------------------------------

// Quem não entrou vai para o login e volta para cá depois.
function useRequireLogin() {
  const state = useCustomer();
  useEffect(() => {
    if (state.status === 'out') navigate(`/conta?voltar=${encodeURIComponent(window.location.pathname)}`, { replace: true });
  }, [state.status]);
  return state;
}

export function MyOrdersPage() {
  const { status } = useRequireLogin();
  const [orders, setOrders] = useState<AccountOrderSummary[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  // Depois de "Carregar mais", a atualização automática só renova o status do que já está na tela.
  const pagedRef = useRef(false);

  useEffect(() => {
    document.title = 'Meus pedidos';
  }, []);

  // Lista em dia: recarrega a primeira página a cada 20 s com a aba aberta.
  const refresh = useCallback(async () => {
    try {
      const data = await api.get<{ orders: AccountOrderSummary[]; has_more: boolean }>('/api/account/orders');
      if (pagedRef.current) {
        const fresh = new Map(data.orders.map((o) => [o.order_number, o]));
        setOrders((current) => current?.map((o) => fresh.get(o.order_number) ?? o) ?? data.orders);
      } else {
        setOrders(data.orders);
        setMore(data.has_more);
      }
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate(`/conta?voltar=${encodeURIComponent('/conta/pedidos')}`, { replace: true });
        return;
      }
      setError(friendlyError(err, 'Não foi possível carregar seus pedidos agora.'));
    }
  }, []);

  useEffect(() => {
    if (status !== 'in') return;
    void refresh();
    const timer = window.setInterval(() => document.visibilityState === 'visible' && void refresh(), 20_000);
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status, refresh]);

  const loadMore = async () => {
    if (!orders?.length) return;
    setLoadingMore(true);
    try {
      const data = await api.get<{ orders: AccountOrderSummary[]; has_more: boolean }>(`/api/account/orders?before=${orders[orders.length - 1].order_number}`);
      pagedRef.current = true;
      setOrders([...orders, ...data.orders]);
      setMore(data.has_more);
    } catch (err) {
      setError(friendlyError(err, 'Não foi possível carregar mais pedidos.'));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <PageShell back="/conta" backLabel="Minha conta">
      <Title sub="Todos os pedidos da sua conta, com o andamento de cada um.">Meus pedidos</Title>
      {status !== 'in' || (orders === null && !error) ? (
        <Spinner />
      ) : (
        <div className="mt-6 space-y-5">
          {error && (
            <p role="alert" className="flex items-center gap-2 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" /> {error}
              <button type="button" onClick={() => void refresh()} className="ml-auto font-bold underline-offset-4 hover:underline">
                Tentar de novo
              </button>
            </p>
          )}
          {orders && orders.length === 0 ? (
            <div className="rounded-[2rem] border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent p-8 text-center">
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#145CFF]/15 text-[#2563FF] ring-1 ring-[#145CFF]/40">
                <ShoppingBag className="h-8 w-8" aria-hidden="true" />
              </div>
              <h2 className="mt-5 text-xl font-black text-white">Nenhum pedido na sua conta ainda</h2>
              <p className="mt-2 text-white/65">Os pedidos feitos com a sua conta aparecem aqui. Se você pediu como visitante, vincule o pedido abaixo.</p>
              <a href="/bebidas" className={`${BLUE_BUTTON} mt-6`}>
                Ver bebidas
              </a>
            </div>
          ) : (
            <ul className="space-y-3">
              {orders?.map((o) => (
                <OrderListItem key={o.order_number} o={o} />
              ))}
            </ul>
          )}
          {more && (
            <div className="flex justify-center">
              <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className={`${GHOST_BUTTON} disabled:opacity-60`}>
                {loadingMore && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />} Carregar mais
              </button>
            </div>
          )}
          <Panel id="vincular" title="Vincular um pedido de visitante" subtitle="Informe o número e o código de acompanhamento do pedido que você fez sem entrar na conta.">
            <ClaimForm onClaimed={() => void refresh()} />
          </Panel>
        </div>
      )}
    </PageShell>
  );
}

// ---- /conta/pedidos/:número ----------------------------------------------------------------------------

export function MyOrderPage({ number }: { number: string }) {
  const { status } = useRequireLogin();
  const { products, cart } = useShop();
  const feed = useOrderFeed(`conta:${number}`, async () => {
    try {
      return (await api.get<{ order: PublicOrder }>(`/api/account/orders/${number}`)).order;
    } catch (err) {
      // Sessão vencida: o estado da conta é atualizado e a tela leva ao login.
      if (err instanceof ApiError && err.status === 401) setCustomer(null);
      throw err;
    }
  });
  const [again, setAgain] = useState<{ added: number; missing: string[] } | null>(null);

  if (status !== 'in' || feed.state === 'loading') {
    return (
      <PageShell back="/conta/pedidos" backLabel="Meus pedidos">
        <Spinner />
      </PageShell>
    );
  }
  if (feed.state === 'missing' || !feed.order) {
    return (
      <PageShell back="/conta/pedidos" backLabel="Meus pedidos">
        <div className="mx-auto mt-10 max-w-md text-center">
          <h1 className="text-2xl font-black text-white">{feed.state === 'error' ? 'Não foi possível carregar o pedido' : 'Pedido não encontrado'}</h1>
          <p className="mt-2 text-white/65">{feed.state === 'error' ? 'Sem conexão com o servidor. Tente de novo.' : 'Esse pedido não está na sua conta.'}</p>
          <a href="/conta/pedidos" className={`${BLUE_BUTTON} mt-6`}>
            Voltar para Meus pedidos
          </a>
        </div>
      </PageShell>
    );
  }
  const order = feed.order;

  // Repete a compra com o que ainda está à venda.
  const orderAgain = () => {
    const missing: string[] = [];
    let added = 0;
    for (const item of order.items) {
      const product = products.find((p) => p.id === item.product_id);
      if (!product || product.soldOut) {
        missing.push(item.product_name);
        continue;
      }
      cart.setQty(product.id, Math.min(99, (cart.cart[product.id] ?? 0) + item.quantity));
      added += 1;
    }
    if (!missing.length && added) navigate('/checkout');
    else setAgain({ added, missing });
  };

  return (
    <PageShell back="/conta/pedidos" backLabel="Meus pedidos">
      <OrderView order={order} feed={feed} mine>
        <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-5 sm:p-6" aria-labelledby="repetir">
          <h2 id="repetir" className="text-lg font-black text-white">
            Pedir de novo
          </h2>
          <p className="mt-1 text-sm text-white/60">Coloca os mesmos itens no seu pedido e leva para o checkout, com seus dados já preenchidos.</p>
          <button type="button" onClick={orderAgain} className={`${BLUE_BUTTON} mt-4`}>
            <ShoppingBag className="h-5 w-5" aria-hidden="true" /> Pedir novamente
          </button>
          {again && (
            <div role="status" className="mt-4 space-y-3 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
              {again.missing.length > 0 && <p>Estes itens não estão mais disponíveis: {again.missing.join(', ')}.</p>}
              {again.added > 0 ? (
                <>
                  <p>Os outros {again.added} {again.added === 1 ? 'item foi adicionado' : 'itens foram adicionados'} ao seu pedido.</p>
                  <a href="/checkout" className={`${BLUE_BUTTON} !py-2.5 text-sm`}>
                    Ir para o pedido
                  </a>
                </>
              ) : (
                <p>Nenhum item deste pedido está disponível agora.</p>
              )}
            </div>
          )}
        </section>
      </OrderView>
    </PageShell>
  );
}

// ---- /conta/recuperar e /conta/redefinir/:código -------------------------------------------------------

// Alternativa para quem não acessa o e-mail (ou quando a loja ainda não configurou o envio): prova de posse com o
// telefone da conta + um pedido que já está nela.
function RecoverByOrder({ initialEmail, onDone }: { initialEmail: string; onDone: () => void }) {
  const { store } = useShop();
  const [form, setForm] = useState({ email: initialEmail, phone: '', number: '', code: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const code = normalizeCode(form.code);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) return setError('Confira o e-mail.');
    if (onlyDigits(form.phone).length < 10) return setError('Informe o telefone cadastrado, com DDD.');
    if (!/^\d{1,12}$/.test(form.number.trim().replace(/^#/, ''))) return setError('Informe o número de um pedido da sua conta.');
    if (!code) return setError('Confira o código de acompanhamento (20 letras e números).');
    if (form.password.length < 8) return setError('A senha nova precisa ter pelo menos 8 caracteres.');
    setBusy(true);
    try {
      await api.post('/api/account/recover', { email: form.email.trim(), phone: onlyDigits(form.phone), order_number: form.number.trim().replace(/^#/, ''), code, password: form.password });
      onDone();
    } catch (err) {
      setError(friendlyError(err, 'Não foi possível redefinir a senha agora.'));
    } finally {
      setBusy(false);
    }
  };

  const whatsapp = `https://wa.me/${(store.whatsapp ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(`Olá, ${store.store_name}! Esqueci a senha da minha conta no site. Podem me enviar um link para criar uma nova?`)}`;

  return (
    <>
      <p className="mb-4 text-sm text-white/60">Sem o e-mail, você prova que a conta é sua com o telefone cadastrado e um pedido que já está nela.</p>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="E-mail da conta">{(p) => <input {...p} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" className={FIELD} />}</Field>
        <Field label="Telefone cadastrado">{(p) => <input {...p} type="tel" value={form.phone} onChange={(e) => set('phone', maskPhone(e.target.value))} autoComplete="tel-national" className={FIELD} placeholder="(34) 99999-0000" />}</Field>
        <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
          <Field label="Nº do pedido">{(p) => <input {...p} value={form.number} onChange={(e) => set('number', e.target.value)} inputMode="numeric" autoComplete="off" className={FIELD} placeholder="#1001" />}</Field>
          <Field label="Código de acompanhamento">
            {(p) => <input {...p} value={form.code} onChange={(e) => set('code', e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} className={`${FIELD} font-mono`} placeholder="7K3M9-QX2VB-…" />}
          </Field>
        </div>
        <Field label="Senha nova" hint="Pelo menos 8 caracteres.">
          {(p) => <input {...p} type="password" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" maxLength={200} className={FIELD} />}
        </Field>
        <ErrorLine>{error}</ErrorLine>
        <Submit busy={busy}>Redefinir senha</Submit>
      </form>
      <p className="mt-5 text-sm text-white/55">
        Sua conta ainda não tem nenhum pedido?{' '}
        <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
          Peça um link de redefinição à loja pelo WhatsApp
        </a>
        .
      </p>
    </>
  );
}

type Sent = { email: string; resendIn: number; minutes: number };

// Depois do pedido: a resposta é a mesma exista a conta ou não, então a tela diz "se existir" e ajuda a achar o e-mail.
function RecoverSent({ sent, onAgain, onOther }: { sent: Sent; onAgain: (s: Sent) => void; onOther: () => void }) {
  const [left, restart] = useCountdown(sent.resendIn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const resend = async () => {
    setError('');
    setInfo('');
    setBusy(true);
    try {
      const data = await api.post<{ resend_in?: number; minutes?: number }>('/api/account/forgot-password', { email: sent.email });
      restart(number(data.resend_in, 60));
      onAgain({ email: sent.email, resendIn: number(data.resend_in, 60), minutes: number(data.minutes, sent.minutes) });
      setInfo('Pedimos um novo link. O link anterior deixa de valer quando o novo chegar.');
    } catch (err) {
      setError(friendlyError(err, 'Não foi possível reenviar agora. Tente de novo em instantes.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <InfoLine>
        Se existir uma conta com <strong className="font-bold">{sent.email}</strong>, o link para criar uma senha nova já está a caminho. Ele vale por {sent.minutes} minutos e só pode ser usado uma vez.
      </InfoLine>
      <ErrorLine>{error}</ErrorLine>
      <OkLine>{info}</OkLine>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={() => void resend()}
          disabled={left > 0 || busy}
          className="inline-flex items-center justify-center gap-2 rounded-full px-1 py-1 text-sm font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline disabled:cursor-not-allowed disabled:text-white/40 disabled:no-underline"
        >
          {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {left > 0 ? `Reenviar link em ${mmss(left)}` : 'Reenviar link'}
        </button>
        <button type="button" onClick={onOther} className="text-sm font-semibold text-white/60 underline-offset-4 hover:text-white hover:underline">
          Usar outro e-mail
        </button>
      </div>
      <p className="text-xs leading-relaxed text-white/45">Não chegou? Veja a caixa de spam ou lixo eletrônico e confira se digitou o e-mail certo. Por segurança, limitamos quantos links podem ser enviados por hora.</p>
    </div>
  );
}

export function RecoverPage() {
  const [email, setEmail] = useState(() => getRecoverPrefill());
  const [emailError, setEmailError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [mailDown, setMailDown] = useState(false);
  const [altOpen, setAltOpen] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    document.title = 'Recuperar senha';
    return () => setRecoverPrefill('');
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setEmailError('');
    const address = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      setEmailError('Confira o e-mail.');
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      const data = await api.post<{ resend_in?: number; minutes?: number }>('/api/account/forgot-password', { email: address });
      setSent({ email: address, resendIn: number(data.resend_in, 60), minutes: number(data.minutes, 60) });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_email') {
        setEmailError(err.message);
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      } else if (err instanceof ApiError && err.code === 'mail_not_configured') {
        // A loja ainda não configurou o envio de e-mails: o caminho sem e-mail é o que resta.
        setMailDown(true);
        setAltOpen(true);
      } else {
        setError(friendlyError(err, 'Não foi possível enviar agora. Tente de novo em instantes.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell back="/conta" backLabel="Entrar">
      <div className="mx-auto max-w-md">
        <Title sub="Informe o e-mail da sua conta e enviaremos um link para você criar uma senha nova.">Recuperar senha</Title>
        <div className="mt-6 space-y-5">
          {done ? (
            <Panel id="ok" title="Senha redefinida">
              <OkLine>Pronto! Entre com a senha nova.</OkLine>
              <a href="/conta" className={`${BLUE_BUTTON} mt-4 w-full`}>
                Entrar
              </a>
            </Panel>
          ) : (
            <>
              <Panel id="por-email" title={sent ? 'Verifique seu e-mail' : 'Receber o link por e-mail'}>
                {sent ? (
                  <RecoverSent
                    sent={sent}
                    onAgain={setSent}
                    onOther={() => {
                      setSent(null);
                      setEmail('');
                    }}
                  />
                ) : (
                  <form onSubmit={submit} noValidate className="space-y-4">
                    {mailDown && <InfoLine tone="warn">A recuperação por e-mail está indisponível no momento, porque o envio de e-mails da loja ainda não foi configurado. Use a opção abaixo ou fale com a loja pelo WhatsApp.</InfoLine>}
                    <Field label="E-mail da conta" error={emailError}>
                      {(p) => <input {...p} type="email" value={email} onChange={(e) => { setEmail(e.target.value); setEmailError(''); }} autoComplete="email" maxLength={254} className={FIELD} placeholder="voce@email.com" />}
                    </Field>
                    <ErrorLine>{error}</ErrorLine>
                    <Submit busy={busy}>
                      {!busy && <Mail className="h-5 w-5" aria-hidden="true" />}
                      Enviar link de recuperação
                    </Submit>
                  </form>
                )}
              </Panel>

              <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03]">
                <button
                  type="button"
                  aria-expanded={altOpen}
                  aria-controls="sem-email"
                  onClick={() => setAltOpen((open) => !open)}
                  className="flex w-full items-center justify-between gap-3 rounded-[1.75rem] px-5 py-4 text-left text-base font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:px-6"
                >
                  <span>
                    Não consigo acessar meu <span className="whitespace-nowrap">e-mail</span>
                  </span>
                  <ChevronDown className={`h-5 w-5 shrink-0 text-white/60 transition-transform ${altOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
                {altOpen && (
                  <div id="sem-email" className="px-5 pb-5 sm:px-6 sm:pb-6">
                    <RecoverByOrder initialEmail={email.trim()} onDone={() => setDone(true)} />
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </PageShell>
  );
}

// Link da recuperação (e-mail ou gerado pela loja): confere se ainda vale ANTES de pedir a senha nova.
export function ResetPage({ token }: { token: string }) {
  const [phase, setPhase] = useState<'checking' | 'invalid' | 'form' | 'done'>('checking');
  const [masked, setMasked] = useState('');
  const [invalid, setInvalid] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    document.title = 'Nova senha';
  }, []);

  // Só consulta (não gasta o link): leitores de e-mail que "abrem" links sozinhos não invalidam nada.
  useEffect(() => {
    let alive = true;
    api
      .post<{ email_masked: string }>('/api/account/reset-check', { token })
      .then((data) => {
        if (!alive) return;
        setMasked(data.email_masked);
        setPhase('form');
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 400) {
          setInvalid(err.message);
          setPhase('invalid');
        } else {
          // Sem conexão agora: mostra o formulário; se o link não valer, o envio avisa.
          setPhase('form');
        }
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('A senha precisa ter pelo menos 8 caracteres.');
    setBusy(true);
    try {
      const data = await api.post<{ email?: string; verified?: boolean }>('/api/account/reset', { token, password });
      if (data.email) setLoginPrefill(data.email);
      setConfirmed(Boolean(data.verified));
      setPhase('done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_link') {
        setInvalid(err.message);
        setPhase('invalid');
      } else {
        setError(friendlyError(err, 'Não foi possível redefinir a senha agora.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell back="/conta" backLabel="Entrar">
      <div className="mx-auto max-w-md">
        <Title>Nova senha</Title>
        <div className="mt-6">
          {phase === 'checking' ? (
            <Spinner />
          ) : phase === 'done' ? (
            <Panel id="ok" title="Senha redefinida">
              <OkLine>{confirmed ? 'Pronto! Sua senha foi alterada e o seu e-mail foi confirmado. Entre com a senha nova.' : 'Pronto! Entre com a senha nova.'}</OkLine>
              <p className="mt-3 text-sm text-white/55">Por segurança, você foi desconectado dos aparelhos em que estava logado.</p>
              <a href="/conta" className={`${BLUE_BUTTON} mt-4 w-full`}>
                Entrar
              </a>
            </Panel>
          ) : phase === 'invalid' ? (
            <Panel id="vencido" title="Este link não vale mais">
              <ErrorLine>{invalid}</ErrorLine>
              <a href="/conta/recuperar" className={`${BLUE_BUTTON} mt-4 w-full`}>
                Pedir um novo link
              </a>
            </Panel>
          ) : (
            <Panel id="nova" title="Escolha uma senha nova" subtitle={masked ? `Conta ${masked}. Este link só vale uma vez.` : 'Este link só vale uma vez.'}>
              <form onSubmit={submit} noValidate className="space-y-4">
                <Field label="Senha nova" hint="Pelo menos 8 caracteres.">
                  {(p) => <input {...p} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={200} className={FIELD} />}
                </Field>
                <ErrorLine>{error}</ErrorLine>
                <Submit busy={busy}>Salvar senha nova</Submit>
              </form>
            </Panel>
          )}
        </div>
      </div>
    </PageShell>
  );
}
