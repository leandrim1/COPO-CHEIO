import { CalendarClock, CalendarOff, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import type { StoreSettings } from '../lib/types';
import { Badge, Button, Card, Field, INPUT, IconButton, Spinner, Switch, useConfirm, useToast } from './ui';

// Agendamento de pedidos (configuração) e dias especiais da loja (feriados e horários excepcionais). Quem decide o que vale é o servidor.

const LEAD_OPTIONS: [number, string][] = [
  [0, 'Sem antecedência'],
  [30, '30 minutos'],
  [60, '1 hora'],
  [120, '2 horas'],
  [180, '3 horas'],
  [360, '6 horas'],
  [720, '12 horas'],
  [1440, '1 dia'],
];
const SLOT_OPTIONS = [15, 30, 60, 120];
const DAYS_OPTIONS = [1, 2, 3, 5, 7, 10, 14, 21, 30];

export function SchedulingCard({ store, onSaved }: { store: StoreSettings; onSaved: (s: StoreSettings, stale?: boolean) => void }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    enabled: store.scheduling_enabled === true,
    lead: store.schedule_lead_minutes ?? 60,
    days: store.schedule_max_days ?? 7,
    slot: store.schedule_slot_minutes ?? 30,
    capacity: store.schedule_slot_capacity ? String(store.schedule_slot_capacity) : '',
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const capacity = form.capacity.trim() ? Number(form.capacity) : null;
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000)) {
      toast.error('Confira os pedidos por faixa.', 'Use um número de 1 a 1000, ou deixe vazio para não limitar.');
      return;
    }
    setSaving(true);
    try {
      const { store: saved } = await api.patch<{ store: StoreSettings }>('/api/admin/store', {
        scheduling_enabled: form.enabled,
        schedule_lead_minutes: form.lead,
        schedule_max_days: form.days,
        schedule_slot_minutes: form.slot,
        schedule_slot_capacity: capacity,
        ...(store.updated_at ? { expected_updated_at: store.updated_at } : {}),
      });
      onSaved(saved);
      toast.success('Agendamento salvo.', 'O site já usa os novos dados.');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale_settings' && error.data.store) {
        onSaved(error.data.store as StoreSettings, true);
        toast.error('Outra pessoa alterou estas configurações.', 'Mostrei os dados atuais. Confira e salve de novo.');
      } else toast.error('Não foi possível salvar.', friendlyError(error, ''));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate data-scheduling-card>
      <Card title="Agendamento de pedidos" description="O cliente escolhe o dia e o horário da entrega ou da retirada. Os horários seguem o seu horário de funcionamento e os dias especiais; o estoque é reservado na hora do pedido.">
        <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Permitir agendar pedidos" description="Desligado por padrão. Com a loja fechada, o cliente ainda consegue agendar para quando abrir." />
        {form.enabled && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Antecedência mínima" hint="Quanto tempo antes o pedido precisa ser feito.">
              {(p) => (
                <select {...p} className={INPUT} value={form.lead} onChange={(e) => setForm({ ...form, lead: Number(e.target.value) })}>
                  {LEAD_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Até quantos dias à frente">
              {(p) => (
                <select {...p} className={INPUT} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })}>
                  {DAYS_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d === 1 ? '1 dia' : `${d} dias`}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Tamanho da faixa de horário">
              {(p) => (
                <select {...p} className={INPUT} value={form.slot} onChange={(e) => setForm({ ...form, slot: Number(e.target.value) })}>
                  {SLOT_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} minutos
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Pedidos por faixa (opcional)" hint="Vazio = sem limite. Faixa cheia aparece como “lotado”.">
              {(p) => <input {...p} className={INPUT} inputMode="numeric" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value.replace(/\D/g, '') })} />}
            </Field>
          </div>
        )}
        <div className="mt-5 flex items-center justify-end gap-3 border-t border-white/[0.06] pt-4">
          <Button type="submit" loading={saving}>
            Salvar agendamento
          </Button>
        </div>
      </Card>
    </form>
  );
}

type Exception = { day: string; kind: 'closed' | 'custom'; start_time: string | null; end_time: string | null; reason: string | null };

const dayText = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

export function SpecialDaysCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Exception[] | null>(null);
  const [form, setForm] = useState({ day: '', kind: 'closed' as 'closed' | 'custom', start: '10:00', end: '14:00', reason: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await api.get<{ exceptions: Exception[] }>('/api/admin/exceptions')).exceptions);
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.day) return setError('Escolha o dia.');
    if (form.kind === 'custom' && (!form.start || !form.end || form.start > form.end)) return setError('O horário especial precisa ter o fim depois do início (não vale atravessar a meia-noite).');
    setError('');
    setSaving(true);
    try {
      await api.post('/api/admin/exceptions', { day: form.day, kind: form.kind, reason: form.reason.trim() || null, ...(form.kind === 'custom' ? { start_time: form.start, end_time: form.end } : {}) });
      toast.success('Dia especial salvo.', 'O site já usa a mudança.');
      setForm({ ...form, day: '', reason: '' });
      void load();
    } catch (err) {
      setError(friendlyError(err, 'Não foi possível salvar o dia especial.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: Exception) => {
    if (!(await confirm({ title: `Remover o dia especial ${dayText(row.day)}?`, description: 'O dia volta a seguir o horário da semana.', confirmLabel: 'Remover' }))) return;
    try {
      await api.delete(`/api/admin/exceptions/${row.day}`);
      toast.success('Dia especial removido.');
      void load();
    } catch (err) {
      toast.error('Não foi possível remover.', friendlyError(err, ''));
    }
  };

  return (
    <div className="mt-4" data-special-days>
      <Card
        title="Feriados e horários especiais"
        description="Um dia especial vale no lugar do horário da semana, para os pedidos de agora e para os agendados. O horário especial não atravessa a meia-noite."
        actions={<CalendarOff className="h-5 w-5 text-white/40" aria-hidden="true" />}
      >
        <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-4">
          <Field label="Dia" className="sm:col-span-1">
            {(p) => <input {...p} type="date" className={`${INPUT} [color-scheme:dark]`} value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} data-special-day />}
          </Field>
          <Field label="O que acontece" className="sm:col-span-1">
            {(p) => (
              <select {...p} className={INPUT} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'closed' | 'custom' })} data-special-kind>
                <option value="closed">Loja fechada</option>
                <option value="custom">Horário especial</option>
              </select>
            )}
          </Field>
          {form.kind === 'custom' ? (
            <div className="grid grid-cols-2 gap-2 sm:col-span-2">
              <Field label="Abre às">{(p) => <input {...p} type="time" className={`${INPUT} [color-scheme:dark]`} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />}</Field>
              <Field label="Fecha às">{(p) => <input {...p} type="time" className={`${INPUT} [color-scheme:dark]`} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />}</Field>
            </div>
          ) : (
            <Field label="Motivo (opcional)" className="sm:col-span-2" count={form.reason.length} max={80}>
              {(p) => <input {...p} className={INPUT} maxLength={80} value={form.reason} placeholder="Ex.: Natal" onChange={(e) => setForm({ ...form, reason: e.target.value })} />}
            </Field>
          )}
          <div className="sm:col-span-4 flex flex-wrap items-center justify-between gap-3">
            <p role="alert" data-special-error className="text-sm font-medium text-rose-300">
              {error}
            </p>
            <Button type="submit" loading={saving} icon={<CalendarClock className="h-4 w-4" aria-hidden="true" />} data-special-save>
              Adicionar dia especial
            </Button>
          </div>
        </form>
        <div className="mt-4 border-t border-white/[0.06] pt-3">
          {!rows ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <p className="text-sm text-white/60">Nenhum dia especial. A loja segue o horário da semana todos os dias.</p>
          ) : (
            <ul className="divide-y divide-white/[0.06]" aria-label="Dias especiais">
              {rows.map((row) => (
                <li key={row.day} data-special-row={row.day} className="flex flex-wrap items-center gap-3 py-2.5">
                  <span className="font-semibold text-white">{dayText(row.day)}</span>
                  <Badge tone={row.kind === 'closed' ? 'red' : 'amber'}>{row.kind === 'closed' ? 'Fechado' : `Aberto das ${row.start_time} às ${row.end_time}`}</Badge>
                  {row.reason && <span className="min-w-0 flex-1 truncate text-sm text-white/60">{row.reason}</span>}
                  <IconButton label={`Remover o dia especial ${dayText(row.day)}`} className="ml-auto hover:text-rose-300" onClick={() => void remove(row)}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
