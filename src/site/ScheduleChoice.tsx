import { CalendarClock, Clock, LoaderCircle } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api, friendlyError } from '../lib/api';
import { FIELD } from './ui';

// "Quando?" do pedido: o quanto antes ou agendado para um dia e uma faixa de horário. As faixas vêm do servidor (que conhece o horário de funcionamento, os feriados,
// a antecedência e a lotação); o banco confere tudo de novo ao fechar o pedido.

export type ScheduleSlot = { at: string; time: string; available: boolean };
export type ScheduleDay = { date: string; slots: ScheduleSlot[] };
export type ScheduleInfo = { enabled: boolean; lead_minutes?: number; max_days?: number; slot_minutes?: number; timezone?: string; days?: ScheduleDay[] };
export type ScheduleValue = { mode: 'now' | 'later'; at: string };

// "Hoje, 20/10" · "Amanhã, 21/10" · "Qua, 22/10" (o dia vem como AAAA-MM-DD já no fuso da loja).
export function dayLabel(date: string, today: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const t = new Date(`${today}T12:00:00Z`);
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  const short = `${date.slice(8, 10)}/${date.slice(5, 7)}`;
  if (diff === 0) return `Hoje, ${short}`;
  if (diff === 1) return `Amanhã, ${short}`;
  const week = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' }).format(d).replace('.', '');
  return `${week.charAt(0).toUpperCase()}${week.slice(1)}, ${short}`;
}

export function slotLabel(day: string | undefined, slot: ScheduleSlot | undefined, today: string): string {
  return day && slot ? `${dayLabel(day, today)} às ${slot.time}` : '';
}

export function ScheduleChoice({
  enabled,
  closedNow,
  pickup,
  value,
  onChange,
  refreshKey,
}: {
  enabled: boolean;
  closedNow: boolean;
  pickup: boolean;
  value: ScheduleValue;
  onChange: (next: ScheduleValue) => void;
  refreshKey?: number;
}) {
  const name = useId();
  const [info, setInfo] = useState<ScheduleInfo | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [day, setDay] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    api.get<ScheduleInfo>('/api/schedule').then(
      (data) => {
        if (!alive) return;
        setInfo(data);
        setError('');
        setLoading(false);
      },
      (e) => {
        if (!alive) return;
        setError(friendlyError(e, 'Não foi possível carregar os horários agora.'));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [enabled, refreshKey]);

  const days = info?.days ?? [];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: info?.timezone ?? 'America/Sao_Paulo' }).format(new Date());
  // O dia escolhido segue valendo enquanto existir; senão, o dia da faixa já escolhida ou o primeiro com faixa livre.
  const currentDay = days.find((d) => d.date === day) ?? days.find((d) => d.slots.some((s) => s.at === value.at)) ?? days.find((d) => d.slots.some((s) => s.available));
  const chosen = currentDay?.slots.find((s) => s.at === value.at);

  // Loja fechada agora: só dá para agendar.
  useEffect(() => {
    if (enabled && closedNow && value.mode === 'now') onChange({ mode: 'later', at: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, closedNow]);

  // A faixa escolhida deixou de existir (outra pessoa pegou a última vaga, o dia virou): limpa a escolha.
  useEffect(() => {
    if (value.mode === 'later' && value.at && info && !days.some((d) => d.slots.some((s) => s.at === value.at && s.available))) onChange({ mode: 'later', at: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  if (!enabled) return null;

  const radio = (mode: 'now' | 'later', title: string, subtitle: string, disabled = false) => (
    <label
      className={`relative flex cursor-pointer items-center gap-3 rounded-2xl border p-3.5 transition-all duration-200 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-white ${
        value.mode === mode ? 'border-[#2563FF] bg-[#145CFF]/15' : 'border-white/10 bg-white/[0.03] hover:border-white/30'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <input
        type="radio"
        name={name}
        className="sr-only"
        checked={value.mode === mode}
        disabled={disabled}
        onChange={() => onChange({ mode, at: mode === 'now' ? '' : value.at })}
        data-schedule-mode={mode}
      />
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-[#8FB1FF]" aria-hidden="true">
        {mode === 'now' ? <Clock className="h-5 w-5" /> : <CalendarClock className="h-5 w-5" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-white">{title}</span>
        <span className="block text-xs text-white/60">{subtitle}</span>
      </span>
    </label>
  );

  return (
    <div data-schedule className="mb-5">
      <p className="mb-2 text-sm font-semibold text-white/80">{pickup ? 'Quando você quer retirar?' : 'Quando você quer receber?'}</p>
      <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Quando">
        {radio('now', 'O quanto antes', closedNow ? 'A loja está fechada agora' : 'Assim que o pedido ficar pronto', closedNow)}
        {radio('later', 'Agendar', 'Escolha o dia e o horário')}
      </div>
      {value.mode === 'later' && (
        <div className="mt-4">
          {loading && !info ? (
            <p className="flex items-center gap-2 text-sm text-white/60">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Buscando os horários…
            </p>
          ) : error ? (
            <p role="alert" className="text-sm font-semibold text-rose-300">
              {error}
            </p>
          ) : days.length === 0 ? (
            <p data-schedule-empty className="rounded-2xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-2.5 text-sm text-amber-100">
              Não há horários disponíveis para agendar agora. {closedNow ? 'Volte quando a loja abrir.' : 'Escolha “O quanto antes”.'}
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor={`${name}-dia`} className="mb-1.5 block text-[13px] font-semibold text-white/80">
                  Dia
                </label>
                <select
                  id={`${name}-dia`}
                  data-schedule-day
                  value={currentDay?.date ?? ''}
                  onChange={(e) => {
                    setDay(e.target.value);
                    onChange({ mode: 'later', at: '' });
                  }}
                  className={`${FIELD} appearance-none`}
                >
                  {days.map((d) => (
                    <option key={d.date} value={d.date} className="bg-[#0A0D14]">
                      {dayLabel(d.date, today)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${name}-hora`} className="mb-1.5 block text-[13px] font-semibold text-white/80">
                  Horário
                </label>
                <select
                  id={`${name}-hora`}
                  data-schedule-time
                  value={chosen?.at ?? ''}
                  onChange={(e) => onChange({ mode: 'later', at: e.target.value })}
                  aria-invalid={!value.at ? undefined : false}
                  className={`${FIELD} appearance-none`}
                >
                  <option value="" className="bg-[#0A0D14]">
                    Escolha o horário
                  </option>
                  {(currentDay?.slots ?? []).map((s) => (
                    <option key={s.at} value={s.at} disabled={!s.available} className="bg-[#0A0D14]">
                      {s.time}
                      {s.available ? '' : ' (lotado)'}
                    </option>
                  ))}
                </select>
              </div>
              {chosen && currentDay && (
                <p data-schedule-summary className="text-xs text-emerald-200/90 sm:col-span-2">
                  Seu pedido fica agendado para {slotLabel(currentDay.date, chosen, today)}. O estoque é reservado agora.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
