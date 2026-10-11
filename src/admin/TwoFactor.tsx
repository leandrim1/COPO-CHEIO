import { Check, Copy, Download, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, friendlyError } from '../lib/api';
import { copyText } from '../lib/tracking';
import { Badge, Button, Card, Field, INPUT, Modal, Spinner, useToast } from './ui';

// Verificação em duas etapas (aplicativo autenticador). Ligar, desligar e gerar códigos de recuperação exigem a senha e, quando
// já está ligada, um código: quem só pegou uma sessão aberta não consegue mexer na proteção.

type Status = { enabled: boolean; pending: boolean; recovery_codes_left: number };
type Step = 'password' | 'scan' | 'codes' | 'disable' | 'regen';

function QrCode({ text }: { text: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    // A biblioteca de QR code só é baixada quando alguém abre esta tela.
    void import('qrcode-generator').then(({ default: qrcode }) => {
      if (!alive) return;
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      setSvg(qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true }));
    });
    return () => {
      alive = false;
    };
  }, [text]);
  // Fundo branco: os aplicativos leem o QR code escuro sobre claro.
  return <div role="img" aria-label="QR code para o aplicativo autenticador" className="mx-auto aspect-square w-48 rounded-2xl bg-white p-3 [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

export function TwoFactorCard() {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [step, setStep] = useState<Step | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState<{ secret: string; otpauth: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<Status>('/api/auth/2fa'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const close = () => {
    // Fechar no meio da configuração deixa a proteção desligada (a chave gerada só vale depois de confirmada).
    setStep(null);
    setPassword('');
    setCode('');
    setSecret(null);
    setCodes([]);
    setSaved(false);
    setCopied(false);
    setError('');
    void load();
  };
  const open = (next: Step) => {
    setError('');
    setPassword('');
    setCode('');
    setStep(next);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(friendlyError(err, 'Não foi possível concluir agora. Tente de novo.'));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 'password') {
      if (!password) return setError('Digite a sua senha atual.');
      void run(async () => {
        setSecret(await api.post<{ secret: string; otpauth: string }>('/api/auth/2fa/setup', { password }));
        setPassword('');
        setStep('scan');
      });
    } else if (step === 'scan') {
      if (code.replace(/\D/g, '').length !== 6) return setError('Digite os 6 dígitos que aparecem no aplicativo.');
      void run(async () => {
        const data = await api.post<{ recovery_codes: string[] }>('/api/auth/2fa/enable', { code });
        setCodes(data.recovery_codes);
        setCode('');
        setStep('codes');
      });
    } else if (step === 'disable') {
      if (!password || !code.trim()) return setError('Digite a senha e um código (do aplicativo ou de recuperação).');
      void run(async () => {
        await api.post('/api/auth/2fa/disable', { password, code });
        toast.success('Verificação em duas etapas desativada.');
        close();
      });
    } else if (step === 'regen') {
      if (!password || code.replace(/\D/g, '').length !== 6) return setError('Digite a senha e os 6 dígitos do aplicativo.');
      void run(async () => {
        const data = await api.post<{ recovery_codes: string[] }>('/api/auth/2fa/recovery-codes', { password, code });
        setCodes(data.recovery_codes);
        setPassword('');
        setCode('');
        setStep('codes');
      });
    }
  };

  const codesText = codes.join('\n');
  const download = () => {
    const blob = new Blob([`Códigos de recuperação do painel Copo Cheio\nCada código vale uma vez.\n\n${codesText}\n`], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'codigos-de-recuperacao-copo-cheio.txt';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const title =
    step === 'password' ? 'Ativar a verificação em duas etapas' : step === 'scan' ? 'Conecte o aplicativo' : step === 'codes' ? 'Guarde seus códigos de recuperação' : step === 'disable' ? 'Desativar a verificação em duas etapas' : 'Novos códigos de recuperação';

  return (
    <Card
      title="Verificação em duas etapas"
      description="Além da senha, o painel pede um código de 6 dígitos de um aplicativo no seu celular. Mesmo que descubram a sua senha, não entram."
      actions={status ? status.enabled ? <Badge tone="green">ATIVADA</Badge> : <Badge>DESATIVADA</Badge> : undefined}
    >
      {failed && !status ? (
        <p className="text-sm text-rose-300">Não foi possível consultar o estado agora. Recarregue a página.</p>
      ) : !status ? (
        <Spinner label="Carregando" />
      ) : status.enabled ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm text-emerald-200">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Protegida. Você tem {status.recovery_codes_left} código(s) de recuperação sem uso.
          </p>
          {status.recovery_codes_left <= 2 && <p className="text-sm text-amber-200">Os códigos de recuperação estão acabando: gere novos e guarde-os.</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => open('regen')}>
              Gerar novos códigos de recuperação
            </Button>
            <Button variant="danger-ghost" onClick={() => open('disable')}>
              Desativar
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-white/70">Use um aplicativo como Google Authenticator, Microsoft Authenticator, Authy ou 1Password. Leva 2 minutos.</p>
          <Button onClick={() => open('password')}>Ativar verificação em duas etapas</Button>
        </div>
      )}

      <Modal
        open={step !== null}
        onClose={step === 'codes' && !saved ? () => setError('Marque que guardou os códigos antes de fechar.') : close}
        size="md"
        title={title}
        footer={
          step === 'codes' ? (
            <Button disabled={!saved} onClick={close}>
              Concluir
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={close}>
                Cancelar
              </Button>
              <Button type="submit" form="dois-fatores" loading={busy} variant={step === 'disable' ? 'danger' : 'primary'}>
                {step === 'password' ? 'Continuar' : step === 'scan' ? 'Ativar' : step === 'disable' ? 'Desativar' : 'Gerar códigos'}
              </Button>
            </>
          )
        }
      >
        <form id="dois-fatores" onSubmit={submit} noValidate className="space-y-4">
          {step === 'password' && (
            <>
              <p className="text-sm text-white/70">Por segurança, confirme a sua senha atual para começar.</p>
              <Field label="Senha atual">{(p) => <input {...p} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} className={INPUT} />}</Field>
            </>
          )}
          {step === 'scan' && secret && (
            <>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-white/75">
                <li>Abra o aplicativo autenticador no celular e escolha “adicionar conta”.</li>
                <li>Aponte a câmera para o QR code (ou digite a chave abaixo).</li>
                <li>Digite aqui o código de 6 dígitos que o aplicativo mostrar.</li>
              </ol>
              <QrCode text={secret.otpauth} />
              <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-center">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-white/55">Chave (se não puder ler o QR code)</p>
                <p className="mt-1 select-all break-all font-mono text-sm tracking-wider text-white">{grouped(secret.secret)}</p>
              </div>
              <Field label="Código do aplicativo">
                {(p) => (
                  <input {...p} inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} className={`${INPUT} text-center font-mono text-xl tracking-[0.3em]`} placeholder="000000" />
                )}
              </Field>
            </>
          )}
          {(step === 'disable' || step === 'regen') && (
            <>
              <p className="text-sm text-white/70">{step === 'disable' ? 'Para desativar, confirme a senha e um código.' : 'Os códigos antigos deixam de valer. Confirme a senha e um código do aplicativo.'}</p>
              <Field label="Senha atual">{(p) => <input {...p} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} className={INPUT} />}</Field>
              <Field label={step === 'disable' ? 'Código do aplicativo ou de recuperação' : 'Código do aplicativo'}>
                {(p) => <input {...p} inputMode={step === 'disable' ? 'text' : 'numeric'} autoComplete="one-time-code" value={code} onChange={(e) => setCode(step === 'disable' ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, '').slice(0, 6))} className={`${INPUT} font-mono tracking-widest`} />}
              </Field>
            </>
          )}
          {step === 'codes' && (
            <>
              <p className="text-sm text-white/75">
                Se você perder o celular, cada um destes códigos serve <strong className="text-white">uma vez</strong> no lugar do aplicativo. Eles não aparecem de novo: guarde num lugar seguro.
              </p>
              <ul className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-[13px] tracking-wider text-white" aria-label="Códigos de recuperação">
                {codes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                  onClick={() => void copyText(codesText).then((ok) => (ok ? setCopied(true) : setError('Não foi possível copiar. Selecione os códigos e copie à mão.')))}
                >
                  {copied ? 'Copiado' : 'Copiar'}
                </Button>
                <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" aria-hidden="true" />} onClick={download}>
                  Baixar .txt
                </Button>
              </div>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm text-white/80">
                <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#145CFF]" />
                <span>Guardei os códigos em um lugar seguro.</span>
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm font-medium text-rose-300">
              {error}
            </p>
          )}
        </form>
      </Modal>
    </Card>
  );
}
