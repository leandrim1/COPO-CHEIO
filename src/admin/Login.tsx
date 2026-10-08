import { Eye, EyeOff, LoaderCircle, Lock, Mail } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { navigate } from '../lib/router';
import { admin } from './client';
import { INPUT, cx } from './ui';

export default function LoginPage({ checking }: { checking: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) {
      setError('Informe e-mail e senha.');
      return;
    }
    setBusy(true);
    const { data, error: authError } = await admin.auth.signInWithPassword({ email: email.trim(), password });
    if (authError || !data.user) {
      setBusy(false);
      setError(
        /invalid login credentials/i.test(authError?.message ?? '')
          ? 'E-mail ou senha incorretos.'
          : /fetch|network/i.test(authError?.message ?? '')
            ? 'Sem conexão com o servidor. Tente de novo.'
            : 'Não foi possível entrar. Tente de novo.',
      );
      return;
    }
    // Só administradores ativos entram; qualquer outra conta é desconectada na hora.
    const { data: row } = await admin.from('admin_users').select('active').eq('user_id', data.user.id).maybeSingle();
    if (!row?.active) {
      await admin.auth.signOut();
      setBusy(false);
      setError('Esta conta não tem acesso ao painel.');
      return;
    }
    navigate('/admin/dashboard', { replace: true });
  };

  return (
    <div className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-[#07090E] px-4 py-10 text-white">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-[#145CFF]/25 blur-3xl" />
        <div className="absolute -bottom-40 -right-24 h-96 w-96 rounded-full bg-[#2563FF]/15 blur-3xl" />
      </div>
      <div className="relative w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <img src="/logo.png" alt="" width={80} height={80} className="h-20 w-20 rounded-full object-contain ring-1 ring-[#145CFF]/40 shadow-[0_0_50px_-4px_rgba(20,92,255,0.75)]" />
          <h1 className="mt-5 text-2xl font-black tracking-tight">
            COPO <span className="text-[#2563FF]">CHEIO</span>
          </h1>
          <p className="mt-1 text-sm text-white/55">Painel administrativo</p>
        </div>

        <form onSubmit={submit} noValidate className="mt-8 space-y-4 rounded-3xl border border-white/10 bg-[#0C1018]/90 p-6 shadow-[0_30px_80px_-30px_rgba(20,92,255,0.6)] backdrop-blur-xl">
          <div>
            <label htmlFor="login-email" className="mb-1.5 block text-[13px] font-semibold text-white/80">
              E-mail
            </label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" aria-hidden="true" />
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
              <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" aria-hidden="true" />
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
          {error && (
            <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || checking}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#145CFF] text-[15px] font-bold shadow-[0_12px_30px_-10px_rgba(20,92,255,0.95)] transition-colors hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-60"
          >
            {(busy || checking) && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Entrar
          </button>
        </form>
        <p className="mt-6 text-center text-xs text-white/35">
          <a href="/" className="hover:text-white/70">
            ← Voltar para o site
          </a>
        </p>
      </div>
    </div>
  );
}
