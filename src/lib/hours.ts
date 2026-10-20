import type { DayHours, DayKey, OpeningHours, StoreException } from './types';

// Mesma regra da função store_open_now() do banco: "início = fim" é 24 horas e um fim antes do
// início atravessa a meia-noite (ex.: 18:00 às 02:00).

export const DAYS: { key: DayKey; label: string; short: string }[] = [
  { key: 'mon', label: 'Segunda', short: 'Seg' },
  { key: 'tue', label: 'Terça', short: 'Ter' },
  { key: 'wed', label: 'Quarta', short: 'Qua' },
  { key: 'thu', label: 'Quinta', short: 'Qui' },
  { key: 'fri', label: 'Sexta', short: 'Sex' },
  { key: 'sat', label: 'Sábado', short: 'Sáb' },
  { key: 'sun', label: 'Domingo', short: 'Dom' },
];
const BY_DOW: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function localNow(timeZone: string, now: Date) {
  let parts: Intl.DateTimeFormatPart[];
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone, ...options }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dow, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')), date: `${get('year')}-${get('month')}-${get('day')}` };
}

// AAAA-MM-DD + n dias (conta em UTC ao meio-dia, sem depender do fuso do aparelho).
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// A janela de um dia: o dia especial (feriado fechado ou horário especial), se houver, vale no lugar do horário da semana.
function windowOf(date: string, weekly: DayHours | undefined, exceptions: StoreException[]): DayHours | undefined {
  const ex = exceptions.find((e) => e.day === date);
  if (!ex) return weekly;
  if (ex.kind === 'closed' || !ex.start_time || !ex.end_time) return { open: false, start: '00:00', end: '00:00' };
  return { open: true, start: ex.start_time.slice(0, 5), end: ex.end_time.slice(0, 5) };
}

export function isOpenNow(hours: OpeningHours, timeZone: string, now = new Date(), exceptions: StoreException[] = []): boolean {
  const { dow, minutes, date } = localNow(timeZone, now);
  const today = windowOf(date, hours[BY_DOW[dow]], exceptions);
  const yesterday = windowOf(addDays(date, -1), hours[BY_DOW[(dow + 6) % 7]], exceptions);
  if (today?.open) {
    const start = toMinutes(today.start);
    const end = toMinutes(today.end);
    if (start === end) return true;
    if (start < end ? minutes >= start && minutes < end : minutes >= start) return true;
  }
  return Boolean(yesterday?.open && toMinutes(yesterday.start) > toMinutes(yesterday.end) && minutes < toMinutes(yesterday.end));
}

const span = (start: string, end: string) => (start === end ? '24 horas' : `${start} às ${end}`);

// Dia da semana de hoje no fuso da loja ('mon' … 'sun'); null se o navegador não souber dizer.
export function todayKey(timeZone: string, now = new Date()): DayKey | null {
  return BY_DOW[localNow(timeZone, now).dow] ?? null;
}

// O texto de um dia na lista de horários: "09:00 às 23:00", "24 horas" ou "Fechado". Mesmo texto de hoursLines().
export const dayHoursText = (hours: DayHours | undefined) => (hours?.open ? span(hours.start, hours.end) : 'Fechado');

// ["Segunda a Sexta: 09:00 às 23:00", "Sábado e Domingo: fechado"]
export function hoursLines(hours: OpeningHours): string[] {
  const groups: { from: number; to: number; text: string }[] = [];
  DAYS.forEach((day, i) => {
    const h = hours[day.key];
    const text = h?.open ? span(h.start, h.end) : 'fechado';
    const last = groups[groups.length - 1];
    if (last && last.text === text && last.to === i - 1) last.to = i;
    else groups.push({ from: i, to: i, text });
  });
  return groups.map(({ from, to, text }) => {
    const days =
      from === to ? DAYS[from].label : to === from + 1 ? `${DAYS[from].label} e ${DAYS[to].label}` : `${DAYS[from].label} a ${DAYS[to].label}`;
    return `${days}: ${text}`;
  });
}

// "Abre hoje às 18:00", "Abre amanhã às 09:00", "Abre segunda às 09:00".
export function nextOpening(hours: OpeningHours, timeZone: string, now = new Date(), exceptions: StoreException[] = []): string {
  const { dow, minutes, date } = localNow(timeZone, now);
  for (let offset = 0; offset < 8; offset++) {
    const key = BY_DOW[(dow + offset) % 7];
    const h = windowOf(addDays(date, offset), hours[key], exceptions);
    if (!h?.open) continue;
    if (offset === 0 && toMinutes(h.start) <= minutes) continue;
    const when = offset === 0 ? 'hoje' : offset === 1 ? 'amanhã' : DAYS.find((d) => d.key === key)!.label.toLowerCase();
    return `Abre ${when} às ${h.start}`;
  }
  return '';
}

export const DEFAULT_DAY = { open: true, start: '09:00', end: '23:00' };
