import { Eye, EyeOff, KeyRound, LoaderCircle, Lock, Mail, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import { navigate } from '../lib/router';
import type { AdminAccount } from '../lib/types';
import { INPUT, cx } from './ui';

type LoginResponse = { admin?: AdminAccount; two_factor?: boolean; challenge?: string };

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

  const finish = (admin: AdminAccount) => {
    onLogin(admin);
    navigate('/admin/dashboard', { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (challenge) return submitCode();
    if (!email.trim() || !password) {
      setError('Informe e-mail e senha.');
      return;
    }
    setBusy(true);
    try {
      const data = await api.post<LoginResponse>('/api/auth/login', { email: email.trim(), password });
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
          {challenge ? (
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
            {challenge ? 'Verificar e entrar' : 'Entrar'}
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
