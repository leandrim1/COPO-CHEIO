import { Eye, EyeOff, KeyRound, LoaderCircle, Lock, Mail, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import { navigate } from '../lib/router';
import type { AdminAccount } from '../lib/types';
import { INPUT, cx } from './ui';

type LoginResponse = {
  admin?: AdminAccount;
  two_factor?: boolean;
  challenge?: string;
  // Segunda etapa: com a senha certa o servidor mandou um código de 6 dígitos para o e-mail da conta (a sessão só abre com ele).
  status?: 'code_required';
  email_masked?: string;
  resend_in?: number;
  expires_in?: number;
  code_minutes?: number;
};

// Etapa do código enviado por e-mail: quando ele expira e quando dá para pedir outro (horários no relógio deste aparelho).
type MailStep = { emailMasked: string; expiresAt: number; resendAt: number };

const seconds = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);
const mmss = (total: number) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;

// Segundos que faltam até `until` (atualiza duas vezes por segundo; não perde tempo se a aba ficar em segundo plano).
function useSecondsLeft(until: number | null): number {
  const [left, setLeft] = useState(() => (until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000))));
  useEffect(() => {
    if (until === null) return setLeft(0);
    const tick = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [until]);
  return left;
}

// Código de 6 dígitos em seis caixas. Por baixo há UM campo de texto de verdade (por isso colar o código inteiro, o preenchimento automático do celular, o
// teclado numérico e o leitor de tela funcionam); as caixas só mostram o que foi digitado e onde está o cursor.
function CodeBoxes({ id, value, onChange, invalid }: { id: string; value: string; onChange: (digits: string) => void; invalid: boolean }) {
  const [focused, setFocused] = useState(false);
  return (
    <div className="relative">
      <div className="grid grid-cols-6 gap-2" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            data-code-box
            className={cx(
              'grid h-12 place-items-center rounded-xl border bg-white/[0.04] font-mono text-xl font-bold text-white transition-colors',
              invalid ? 'border-rose-400/60' : focused && i === Math.min(value.length, 5) ? 'border-[#2563FF] ring-2 ring-[#145CFF]/40' : 'border-white/10',
            )}
          >
            {value[i] ?? ''}
          </div>
        ))}
      </div>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        spellCheck={false}
        value={value}
        // 12 e não 6: um código colado como "123 456" ou "123-456" tem mais de 6 caracteres antes de a limpeza tirar o que não é dígito.
        maxLength={12}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-invalid={invalid}
        className="absolute inset-0 h-full w-full cursor-text rounded-xl border-0 bg-transparent text-transparent opacity-0 caret-transparent outline-none"
      />
    </div>
  );
}

export default function LoginPage({ onLogin }: { onLogin: (user: AdminAccount) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Segunda etapa (só para contas com verificação em duas etapas): o desafio criado pela senha certa + o código do aplicativo.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  // Etapa do código por e-mail (vem antes da etapa do aplicativo): o que o servidor respondeu e o código digitado.
  const [mail, setMail] = useState<MailStep | null>(null);
  const [mailCode, setMailCode] = useState('');
  const [info, setInfo] = useState('');
  const [sending, setSending] = useState(false);
  const expiresLeft = useSecondsLeft(mail?.expiresAt ?? null);
  const resendLeft = useSecondsLeft(mail?.resendAt ?? null);

  const finish = (admin: AdminAccount) => {
    onLogin(admin);
    navigate('/admin/dashboard', { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (challenge) return submitCode();
    if (mail) return submitMailCode();
    if (!email.trim() || !password) {
      setError('Informe e-mail e senha.');
      return;
    }
    setBusy(true);
    try {
      const data = await api.post<LoginResponse>('/api/auth/login', { email: email.trim(), password });
      // Senha certa: o servidor mandou o código para o e-mail da conta e a sessão só abre com ele (a cada entrada).
      if (data.status === 'code_required') {
        const now = Date.now();
        setMail({ emailMasked: data.email_masked ?? 'o seu e-mail', expiresAt: now + seconds(data.expires_in, 300) * 1000, resendAt: now + seconds(data.resend_in, 60) * 1000 });
        setMailCode('');
        setPassword('');
        setBusy(false);
        return;
      }
      if (data.two_factor && data.challenge) {
        setChallenge(data.challenge);
        setPassword('');
        setBusy(false);
        return;
      }
      finish(data.admin!);
    } catch (err) {
      setBusy(false);
      setError(friendlyError(err, 'Não foi possível entrar. Tente de novo.'));
    }
  };

  // Volta para o e-mail e a senha (a senha precisa ser digitada de novo para receber outro código).
  const backToPassword = (message = '') => {
    setMail(null);
    setMailCode('');
    setChallenge(null);
    setCode('');
    setRecovery(false);
    setInfo('');
    setError(message);
  };

  const submitMailCode = async () => {
    if (mailCode.length !== 6) {
      setError('Digite os 6 dígitos do código que enviamos por e-mail.');
      return;
    }
    setBusy(true);
    try {
      const data = await api.post<LoginResponse>('/api/auth/login/code', { code: mailCode });
      // Conta com o aplicativo autenticador: falta o código do aplicativo (a etapa seguinte).
      if (data.two_factor && data.challenge) {
        setChallenge(data.challenge);
        setMail(null);
        setMailCode('');
        setBusy(false);
        return;
      }
      finish(data.admin!);
    } catch (err) {
      setBusy(false);
      // A tentativa acabou (tempo esgotado ou erros demais): volta para o e-mail e a senha, explicando.
      if (err instanceof ApiError && (err.data.code === 'login_expired' || err.data.code === 'code_locked')) {
        backToPassword(err.message);
        return;
      }
      setMailCode('');
      setError(friendlyError(err, 'Não foi possível conferir o código agora. Tente de novo.'));
    }
  };

  const resendMailCode = async () => {
    setError('');
    setInfo('');
    setSending(true);
    try {
      const data = await api.post<LoginResponse>('/api/auth/login/resend', {});
      const now = Date.now();
      setMail((m) => (m ? { ...m, expiresAt: now + seconds(data.expires_in, 300) * 1000, resendAt: now + seconds(data.resend_in, 60) * 1000 } : m));
      setMailCode('');
      setInfo(`Enviamos um novo código para ${mail?.emailMasked ?? 'o seu e-mail'}. O código anterior só deixa de valer quando o novo chegar.`);
    } catch (err) {
      if (err instanceof ApiError && err.data.code === 'login_expired') {
        backToPassword(err.message);
        return;
      }
      if (err instanceof ApiError && err.data.code === 'cooldown' && typeof err.data.retry_after === 'number') {
        const wait = err.data.retry_after;
        setMail((m) => (m ? { ...m, resendAt: Date.now() + wait * 1000 } : m));
      }
      setError(friendlyError(err, 'Não foi possível reenviar agora. Tente de novo em instantes.'));
    } finally {
      setSending(false);
    }
  };

  const submitCode = async () => {
    const typed = code.trim();
    if (!typed) {
      setError(recovery ? 'Digite um código de recuperação.' : 'Digite os 6 dígitos do aplicativo.');
      return;
    }
    setBusy(true);
    try {
      const data = await api.post<LoginResponse>('/api/auth/login/2fa', { challenge, code: typed });
      finish(data.admin!);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.data.code === 'challenge_expired') {
        // O desafio vale poucos minutos (ou acabaram as tentativas): volta para a senha.
        setChallenge(null);
        setCode('');
        setRecovery(false);
      }
      setCode('');
      setError(friendlyError(err, 'Não foi possível entrar. Tente de novo.'));
    }
  };

  return (
    <main className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-[#07090E] px-4 py-10 text-white">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-[#145CFF]/25 blur-3xl" />
        <div className="absolute -bottom-40 -right-24 h-96 w-96 rounded-full bg-[#2563FF]/15 blur-3xl" />
      </div>
      <div className="relative w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <img src="/logo-512.webp" alt="" width={80} height={80} className="h-20 w-20 rounded-full object-contain ring-1 ring-[#145CFF]/40 shadow-[0_0_50px_-4px_rgba(20,92,255,0.75)]" />
          <h1 className="mt-5 text-2xl font-black tracking-tight">
            COPO <span className="text-[#2563FF]">CHEIO</span>
          </h1>
          <p className="mt-1 text-sm text-white/55">Painel administrativo</p>
        </div>

        <form onSubmit={submit} noValidate className="mt-8 space-y-4 rounded-3xl border border-white/10 bg-[#0C1018]/90 p-6 shadow-[0_30px_80px_-30px_rgba(20,92,255,0.6)] backdrop-blur-xl">
          {mail ? (
            <div data-admin-code-step>
              <p className="mb-4 flex items-start gap-2.5 rounded-xl border border-[#145CFF]/30 bg-[#145CFF]/10 px-3 py-2.5 text-[13px] text-white/80">
                <Mail className="mt-0.5 h-4 w-4 shrink-0 text-[#8FB1FF]" aria-hidden="true" />
                <span>
                  Enviamos um código de 6 dígitos para <strong className="font-semibold text-white">{mail.emailMasked}</strong>. Digite-o abaixo para entrar no painel.
                </span>
              </p>
              <label htmlFor="login-codigo-email" className="mb-1.5 block text-[13px] font-semibold text-white/80">
                Código de verificação
              </label>
              <CodeBoxes id="login-codigo-email" value={mailCode} onChange={(digits) => (setMailCode(digits), setError(''))} invalid={Boolean(error)} />
              <p role="timer" data-code-timer className={cx('mt-2.5 text-[13px]', expiresLeft > 0 ? 'text-white/60' : 'font-semibold text-amber-200')}>
                {expiresLeft > 0 ? `O código expira em ${mmss(expiresLeft)}.` : 'O código expirou. Peça um novo código.'}
              </p>
              {info && (
                <p role="status" className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-[13px] text-emerald-100">
                  {info}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <button
                  type="button"
                  onClick={() => void resendMailCode()}
                  disabled={resendLeft > 0 || sending}
                  className="inline-flex items-center gap-1.5 font-semibold text-[#8FB1FF] hover:text-white disabled:cursor-not-allowed disabled:text-white/50"
                >
                  {sending && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  {resendLeft > 0 ? `Reenviar código em ${mmss(resendLeft)}` : 'Reenviar código'}
                </button>
                <button type="button" onClick={() => backToPassword()} className="text-white/55 hover:text-white">
                  Voltar
                </button>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-white/50">Não chegou? Veja a caixa de spam. Sem o código ninguém entra no painel, mesmo sabendo a senha.</p>
            </div>
          ) : challenge ? (
            <div>
              <p className="mb-4 flex items-start gap-2.5 rounded-xl border border-[#145CFF]/30 bg-[#145CFF]/10 px-3 py-2.5 text-[13px] text-white/80">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#8FB1FF]" aria-hidden="true" />
                <span>Sua conta usa a verificação em duas etapas. {recovery ? 'Digite um dos seus códigos de recuperação.' : 'Digite o código de 6 dígitos que aparece no aplicativo autenticador.'}</span>
              </p>
              <label htmlFor="login-codigo" className="mb-1.5 block text-[13px] font-semibold text-white/80">
                {recovery ? 'Código de recuperação' : 'Código do aplicativo'}
              </label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/55" aria-hidden="true" />
                <input
                  id="login-codigo"
                  type="text"
                  inputMode={recovery ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  autoFocus
                  spellCheck={false}
                  value={code}
                  maxLength={recovery ? 24 : 7}
                  onChange={(e) => setCode(recovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className={cx(INPUT, 'h-12 pl-10 font-mono tracking-[0.2em]')}
                  placeholder={recovery ? 'ABCD-EFGH-JKMN-PQRS' : '000000'}
                  aria-invalid={Boolean(error)}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <button
                  type="button"
                  onClick={() => {
                    setRecovery((r) => !r);
                    setCode('');
                    setError('');
                  }}
                  className="font-semibold text-[#8FB1FF] hover:text-white"
                >
                  {recovery ? 'Usar o aplicativo' : 'Usar um código de recuperação'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setChallenge(null);
                    setCode('');
                    setRecovery(false);
                    setError('');
                  }}
                  className="text-white/55 hover:text-white"
                >
                  Voltar
                </button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="login-email" className="mb-1.5 block text-[13px] font-semibold text-white/80">
                  E-mail
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/55" aria-hidden="true" />
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={cx(INPUT, 'h-12 pl-10')}
                    placeholder="voce@copocheio.com"
                    aria-invalid={Boolean(error)}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="login-senha" className="mb-1.5 block text-[13px] font-semibold text-white/80">
                  Senha
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/55" aria-hidden="true" />
                  <input
                    id="login-senha"
                    type={show ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={cx(INPUT, 'h-12 pl-10 pr-11')}
                    aria-invalid={Boolean(error)}
                  />
                  <button
                    type="button"
                    onClick={() => setShow((s) => !s)}
                    aria-label={show ? 'Esconder senha' : 'Mostrar senha'}
                    className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-white/50 hover:text-white"
                  >
                    {show ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </button>
                </div>
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#145CFF] text-[15px] font-bold shadow-[0_12px_30px_-10px_rgba(20,92,255,0.95)] transition-colors hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-60"
          >
            {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {challenge || mail ? 'Verificar e entrar' : 'Entrar'}
          </button>
        </form>
        <p className="mt-6 text-center text-xs text-white/55">
          <a href="/" className="hover:text-white/70">
            ← Voltar para o site
          </a>
        </p>
      </div>
    </main>
  );
}
