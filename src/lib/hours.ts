import type { DayKey, OpeningHours } from './types';

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
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dow, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

export function isOpenNow(hours: OpeningHours, timeZone: string, now = new Date()): boolean {
  const { dow, minutes } = localNow(timeZone, now);
  const today = hours[BY_DOW[dow]];
  const yesterday = hours[BY_DOW[(dow + 6) % 7]];
  if (today?.open) {
    const start = toMinutes(today.start);
    const end = toMinutes(today.end);
    if (start === end) return true;
    if (start < end ? minutes >= start && minutes < end : minutes >= start) return true;
  }
  return Boolean(yesterday?.open && toMinutes(yesterday.start) > toMinutes(yesterday.end) && minutes < toMinutes(yesterday.end));
}

const span = (start: string, end: string) => (start === end ? '24 horas' : `${start} às ${end}`);

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

// Só os dias abertos, numa linha: "Segunda a Sexta: 09:00 às 23:00".
export const openHoursSummary = (hours: OpeningHours) =>
  hoursLines(hours).filter((line) => !line.endsWith('fechado')).join(' · ');

// "Abre hoje às 18:00", "Abre amanhã às 09:00", "Abre segunda às 09:00".
export function nextOpening(hours: OpeningHours, timeZone: string, now = new Date()): string {
  const { dow, minutes } = localNow(timeZone, now);
  for (let offset = 0; offset < 8; offset++) {
    const key = BY_DOW[(dow + offset) % 7];
    const h = hours[key];
    if (!h?.open) continue;
    if (offset === 0 && toMinutes(h.start) <= minutes) continue;
    const when = offset === 0 ? 'hoje' : offset === 1 ? 'amanhã' : DAYS.find((d) => d.key === key)!.label.toLowerCase();
    return `Abre ${when} às ${h.start}`;
  }
  return '';
}

export const DEFAULT_DAY = { open: true, start: '09:00', end: '23:00' };
