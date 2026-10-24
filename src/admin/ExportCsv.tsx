import { Download } from 'lucide-react';
import { useState } from 'react';
import { ApiError, friendlyError } from '../lib/api';
import { Button, Field, INPUT, Modal, useConfirm, useToast } from './ui';

// Exportar para planilha (CSV). O arquivo vem do servidor (que confere o login, limita e registra a exportação); aqui só se pede e se baixa.

type Kind = 'orders' | 'customers' | 'stock';

async function download(url: string, fallbackName: string): Promise<void> {
  const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'text/csv' } });
  if (!response.ok) {
    let message = 'Não foi possível exportar.';
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* sem corpo */
    }
    throw new ApiError(response.status, message);
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

const isoDay = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const STATUS_OPTIONS: [string, string][] = [
  ['', 'Todas as situações'],
  ['delivered', 'Entregues'],
  ['cancelled', 'Cancelados'],
  ['new', 'Novos'],
  ['confirmed', 'Confirmados'],
  ['preparing', 'Em preparo'],
  ['out_for_delivery', 'Saiu para entrega'],
];

export function ExportButton({ kind, size = 'md' }: { kind: Kind; size?: 'sm' | 'md' }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(isoDay(today));
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const run = async (url: string, name: string) => {
    setBusy(true);
    setError('');
    try {
      await download(url, name);
      toast.success('Planilha baixada.', kind === 'stock' ? undefined : 'Tem dados pessoais dos clientes: guarde com cuidado e apague quando não precisar mais.');
      setOpen(false);
    } catch (e) {
      const message = friendlyError(e, 'Não foi possível exportar.');
      setError(message);
      if (kind !== 'orders') toast.error('Não foi possível exportar.', message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (kind === 'orders') return setOpen(true);
    if (kind === 'customers') {
      const ok = await confirm({
        title: 'Exportar a lista de clientes?',
        description: 'A planilha tem nome, e-mail e telefone dos clientes (dados pessoais protegidos pela LGPD). A exportação fica registrada no histórico de atividades. Guarde o arquivo com cuidado e apague quando não precisar mais.',
        confirmLabel: 'Exportar',
        tone: 'primary',
      });
      if (!ok) return;
    }
    await run(`/api/admin/export/${kind}.csv`, `${kind}.csv`);
  };

  return (
    <>
      <Button size={size} variant="secondary" loading={busy && kind !== 'orders'} icon={<Download className="h-4 w-4" aria-hidden="true" />} onClick={() => void start()} data-export={kind}>
        Exportar CSV
      </Button>
      {kind === 'orders' && (
        <Modal
          open={open}
          onClose={() => (busy ? undefined : setOpen(false))}
          size="sm"
          title="Exportar pedidos (CSV)"
          description="Abre no Excel ou no Google Planilhas."
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button
                loading={busy}
                icon={<Download className="h-4 w-4" aria-hidden="true" />}
                onClick={() => void run(`/api/admin/export/orders.csv?${new URLSearchParams({ from, to, ...(status ? { status } : {}) })}`, `pedidos-${from}_a_${to}.csv`)}
                data-export-run
              >
                Baixar
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="rounded-xl bg-amber-400/10 px-3 py-2.5 text-xs leading-relaxed text-amber-100 ring-1 ring-amber-400/30">
              A planilha tem nome, telefone, e-mail e endereço dos clientes (dados pessoais protegidos pela LGPD). A exportação fica registrada no histórico de atividades.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="De">{(p) => <input {...p} type="date" className={INPUT} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
              <Field label="Até">{(p) => <input {...p} type="date" className={INPUT} value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
            </div>
            <Field label="Situação">
              {(p) => (
                <select {...p} className={INPUT} value={status} onChange={(e) => setStatus(e.target.value)}>
                  {STATUS_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {error && (
              <p role="alert" className="text-sm font-medium text-rose-300">
                {error}
              </p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
