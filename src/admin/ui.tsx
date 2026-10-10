import { CheckCircle2, ImagePlus, Info, LoaderCircle, Trash2, TriangleAlert, Upload, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { STATUS, statusLabel } from '../lib/format';
import type { DeliveryType, OrderStatus } from '../lib/types';
import { ACCEPTED_IMAGES, checkImageFile } from './client';
import type { ImageValue } from './client';

// Componentes do painel: identidade Copo Cheio (escuro + azul elétrico), cara de sistema.

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF] focus-visible:ring-offset-2 focus-visible:ring-offset-[#07090E]';

const VARIANTS = {
  primary: 'bg-[#145CFF] text-white shadow-[0_8px_24px_-10px_rgba(20,92,255,0.9)] hover:bg-[#2563FF]',
  secondary: 'border border-white/[0.12] bg-white/[0.04] text-white hover:border-white/25 hover:bg-white/[0.08]',
  ghost: 'text-white/70 hover:bg-white/[0.06] hover:text-white',
  danger: 'bg-rose-600 text-white hover:bg-rose-500',
  'danger-ghost': 'text-rose-300 hover:bg-rose-500/10 hover:text-rose-200',
  success: 'bg-emerald-600 text-white hover:bg-emerald-500',
} as const;

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-xs' : size === 'lg' ? 'h-12 px-5 text-[15px]' : 'h-10 px-4 text-sm',
        VARIANTS[variant],
        FOCUS,
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-40', FOCUS, className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({ title, description, actions, children, className, padded = true }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-2xl border border-white/[0.08] bg-[#0C1018] shadow-[0_20px_50px_-30px_rgba(0,0,0,0.8)]', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-bold text-white">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-white/50">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4 sm:p-5' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 sm:mb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-black tracking-tight text-white sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1 text-sm text-white/55">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const TONES = {
  blue: 'bg-[#145CFF]/15 text-[#9DBBFF] ring-[#145CFF]/40',
  green: 'bg-emerald-400/[0.12] text-emerald-200 ring-emerald-400/35',
  amber: 'bg-amber-400/[0.12] text-amber-200 ring-amber-400/35',
  red: 'bg-rose-500/[0.12] text-rose-200 ring-rose-500/35',
  violet: 'bg-violet-400/[0.12] text-violet-200 ring-violet-400/35',
  gray: 'bg-white/[0.06] text-white/65 ring-white/15',
} as const;

export function Badge({ tone = 'gray', children, className }: { tone?: keyof typeof TONES; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ring-1', TONES[tone], className)}>
      {children}
    </span>
  );
}

export function StatusBadge({ status, delivery = 'delivery', className }: { status: OrderStatus; delivery?: DeliveryType; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-black tracking-wide ring-1', STATUS[status].badge, className)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', STATUS[status].dot, status === 'new' && 'animate-pulse')} aria-hidden="true" />
      {statusLabel(status, delivery)}
    </span>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  const control = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={typeof label === 'string' ? label : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40',
        checked ? 'bg-[#145CFF] shadow-[0_0_14px_rgba(20,92,255,0.6)]' : 'bg-white/15',
        FOCUS,
      )}
    >
      <span className={cx('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
    </button>
  );
  if (!label) return control;
  return (
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-semibold text-white">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-white/50">{description}</span>}
      </label>
      {control}
    </div>
  );
}

export const INPUT =
  'w-full rounded-xl border border-white/[0.12] bg-[#07090E] px-3.5 py-2.5 text-sm text-white placeholder:text-white/30 transition-colors focus:border-[#2563FF] focus:outline-none focus:ring-2 focus:ring-[#2563FF]/30 disabled:opacity-60 aria-[invalid=true]:border-rose-400/70';

type FieldRender = { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string };

export function Field({
  label,
  hint,
  error,
  count,
  max,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  count?: number;
  max?: number;
  className?: string;
  children: (props: FieldRender) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-e` : hint ? `${id}-h` : undefined;
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-semibold text-white/80">
          {label}
        </label>
        {max !== undefined && count !== undefined && (
          <span className={cx('text-[11px] tabular-nums', count > max ? 'text-rose-300' : 'text-white/35')}>
            {count}/{max}
          </span>
        )}
      </div>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {error ? (
        <p id={`${id}-e`} className="mt-1.5 text-xs font-medium text-rose-300">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-h`} className="mt-1.5 text-xs text-white/45">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('animate-pulse rounded-lg bg-white/[0.06] motion-reduce:animate-none', className)} />;
}

export function Spinner({ label = 'Carregando' }: { label?: string }) {
  return (
    <div className="flex justify-center py-16" role="status" aria-label={label}>
      <LoaderCircle className="h-8 w-8 animate-spin text-[#2563FF]" aria-hidden="true" />
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-[#145CFF]/[0.12] text-[#5B8CFF] ring-1 ring-[#145CFF]/30">{icon}</span>
      <h3 className="mt-4 text-base font-bold text-white">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-white/55">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center" role="alert">
      <XCircle className="h-10 w-10 text-rose-400" aria-hidden="true" />
      <p className="mt-3 text-sm text-white/75">{message}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-4" onClick={onRetry}>
          Tentar de novo
        </Button>
      )}
    </div>
  );
}

// ---- Modal ---------------------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = panelRef.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])');
    (first ?? panelRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl border border-white/10 bg-[#0C1018] shadow-[0_30px_100px_-20px_rgba(0,0,0,0.9)] focus:outline-none sm:rounded-3xl',
          size === 'sm' ? 'sm:max-w-md' : size === 'lg' ? 'sm:max-w-3xl' : 'sm:max-w-xl',
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-black text-white">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-white/55">{description}</p>}
          </div>
          <IconButton label="Fechar" data-close onClick={onClose}>
            <X className="h-5 w-5" aria-hidden="true" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.06] px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}

// ---- Confirmação antes de excluir --------------------------------------------------------------

type ConfirmOptions = { title: string; description?: ReactNode; confirmLabel?: string; tone?: 'danger' | 'primary' };
const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...options, resolve })), []);
  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={Boolean(state)}
        onClose={() => close(false)}
        size="sm"
        title={state?.title}
        footer={
          <>
            <Button variant="secondary" onClick={() => close(false)}>
              Cancelar
            </Button>
            <Button variant={state?.tone === 'primary' ? 'primary' : 'danger'} onClick={() => close(true)}>
              {state?.confirmLabel ?? 'Excluir'}
            </Button>
          </>
        }
      >
        {state?.description && <div className="text-sm leading-relaxed text-white/70">{state.description}</div>}
      </Modal>
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);

// ---- Toasts ------------------------------------------------------------------------------------

type ToastKind = 'success' | 'error' | 'info' | 'order';
type Toast = { id: number; kind: ToastKind; title: string; description?: string; action?: { label: string; onClick: () => void } };
type ToastApi = { push: (toast: Omit<Toast, 'id'>) => void; success: (title: string, description?: string) => void; error: (title: string, description?: string) => void };

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { ...toast, id }]);
      window.setTimeout(() => dismiss(id), toast.kind === 'order' ? 12000 : toast.kind === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, description) => push({ kind: 'success', title, description }),
      error: (title, description) => push({ kind: 'error', title, description }),
    }),
    [push],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-3 z-[90] flex flex-col items-center gap-2 px-3 sm:bottom-5 sm:left-auto sm:right-5 sm:top-auto sm:items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={cx(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border px-4 py-3 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.9)] backdrop-blur-xl',
              t.kind === 'order'
                ? 'border-[#2563FF]/60 bg-[#0B1A4A]/95 shadow-[0_20px_60px_-15px_rgba(20,92,255,0.8)]'
                : t.kind === 'error'
                  ? 'border-rose-500/40 bg-[#1A0B12]/95'
                  : 'border-white/[0.12] bg-[#0C1018]/95',
            )}
          >
            <span className="mt-0.5 shrink-0" aria-hidden="true">
              {t.kind === 'success' ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              ) : t.kind === 'error' ? (
                <TriangleAlert className="h-5 w-5 text-rose-400" />
              ) : t.kind === 'order' ? (
                <span className="text-lg leading-none">🔔</span>
              ) : (
                <Info className="h-5 w-5 text-[#5B8CFF]" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cx('text-sm font-bold text-white', t.kind === 'order' && 'tracking-wide')}>{t.title}</p>
              {t.description && <p className="mt-0.5 whitespace-pre-line text-[13px] text-white/70">{t.description}</p>}
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                  className="mt-2 text-[13px] font-bold text-[#8FB1FF] hover:text-white"
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button type="button" aria-label="Fechar aviso" onClick={() => dismiss(t.id)} className="-mr-1 shrink-0 rounded-lg p-1 text-white/40 hover:text-white">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast precisa do ToastProvider');
  return api;
}

// ---- Imagem (escolhe, mostra a prévia; o envio acontece ao salvar) -----------------------------

// Endereço para mostrar a imagem escolhida: a prévia local do arquivo novo (ainda não enviado) ou a URL já salva.
export function useImagePreview(value: ImageValue): string | null {
  const preview = useMemo(() => (value.file ? URL.createObjectURL(value.file) : value.url), [value.file, value.url]);
  useEffect(
    () => () => {
      if (value.file && preview) URL.revokeObjectURL(preview);
    },
    [value.file, preview],
  );
  return preview;
}

export function ImageInput({
  label,
  value,
  onChange,
  aspect = 'aspect-square',
  hint,
  fit = 'contain',
  className,
}: {
  label: string;
  value: ImageValue;
  onChange: (value: ImageValue) => void;
  aspect?: string;
  hint?: string;
  fit?: 'contain' | 'cover';
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const preview = useImagePreview(value);

  const pick = (file: File | undefined) => {
    if (!file) return;
    const problem = checkImageFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    onChange({ ...value, file });
  };

  return (
    <div className={className}>
      <p className="mb-1.5 text-[13px] font-semibold text-white/80">{label}</p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
        className={cx(
          'relative overflow-hidden rounded-2xl border border-dashed bg-[radial-gradient(circle_at_50%_55%,rgba(37,99,255,0.22),transparent_70%)] transition-colors',
          aspect,
          dragging ? 'border-[#2563FF] bg-[#145CFF]/10' : 'border-white/15',
        )}
      >
        {preview ? (
          <img src={preview} alt={`Prévia: ${label}`} className={cx('absolute inset-0 h-full w-full p-2', fit === 'cover' ? 'object-cover p-0' : 'object-contain')} />
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className={cx('absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/45 hover:text-white/80', FOCUS)}
          >
            <ImagePlus className="h-7 w-7" aria-hidden="true" />
            <span className="text-xs font-semibold">Enviar imagem</span>
          </button>
        )}
        {value.file && <span className="absolute left-2 top-2 rounded-full bg-[#145CFF] px-2 py-0.5 text-[10px] font-bold text-white">Nova · salve para publicar</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<Upload className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => inputRef.current?.click()}>
          {preview ? 'Trocar imagem' : 'Enviar imagem'}
        </Button>
        {preview && (
          <Button size="sm" variant="danger-ghost" icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => onChange({ url: null, file: null })}>
            Remover
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_IMAGES}
        className="sr-only"
        tabIndex={-1}
        aria-label={label}
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {error ? <p className="mt-1.5 text-xs font-medium text-rose-300">{error}</p> : hint ? <p className="mt-1.5 text-xs text-white/45">{hint}</p> : null}
    </div>
  );
}
