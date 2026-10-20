// Agendamento de pedidos e dias especiais da loja (feriados e horários excepcionais).
// Público: as faixas de horário que o cliente pode escolher (o banco decide: antecedência, limite de dias, horário de funcionamento, dias especiais e lotação).
// Painel: o admin cadastra e remove dias especiais. A configuração do agendamento (ligar, antecedência, faixas) fica em PATCH /api/admin/store.
import { audit } from '../audit.js';
import { query, one } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Router } from '../http.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseDay(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DAY.test(value) || Number.isNaN(new Date(`${value}T12:00:00Z`).getTime())) throw new HttpError(400, `${label}: use o formato AAAA-MM-DD.`);
  return value;
}

export function registerSchedule(r: Router) {
  // Configuração e faixas dos próximos dias (só os dias que têm alguma faixa). Sem agendamento ligado: { enabled: false }.
  r.get('/api/schedule', 'public', async () => {
    const cfg = await one<Row>(
      `select scheduling_enabled, schedule_lead_minutes, schedule_max_days, schedule_slot_minutes, schedule_slot_capacity, timezone, (now() at time zone timezone)::date::text as today
         from store_settings where id = 1`,
    );
    if (!cfg || !cfg.scheduling_enabled) return json({ enabled: false });
    const rows = await query<Row>(
      `select d::date::text as date, schedule_slots(d::date) as slots
         from generate_series($1::date, $1::date + $2::integer, interval '1 day') d`,
      [cfg.today, cfg.schedule_max_days],
    );
    const days = rows.filter((row) => Array.isArray(row.slots) && (row.slots as unknown[]).length > 0).map((row) => ({ date: row.date, slots: row.slots }));
    return json({ enabled: true, lead_minutes: cfg.schedule_lead_minutes, max_days: cfg.schedule_max_days, slot_minutes: cfg.schedule_slot_minutes, timezone: cfg.timezone, days });
  });

  // ---- Dias especiais (painel) -----------------------------------------------------------------------------------

  r.get('/api/admin/exceptions', 'admin', async () =>
    json({
      exceptions: await query<Row>(
        `select day::text as day, kind, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time, reason
           from store_exceptions
          where day >= ((now() at time zone (select timezone from store_settings where id = 1))::date - 30)
          order by day`,
      ),
    }),
  );

  r.post('/api/admin/exceptions', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const day = parseDay(body.day, 'Dia');
    const kind = body.kind;
    if (kind !== 'closed' && kind !== 'custom') throw new HttpError(400, 'Tipo: escolha "fechado" ou "horário especial".');
    let start: string | null = null;
    let end: string | null = null;
    if (kind === 'custom') {
      if (typeof body.start_time !== 'string' || typeof body.end_time !== 'string' || !TIME.test(body.start_time) || !TIME.test(body.end_time)) throw new HttpError(400, 'Horário: use o formato HH:MM (ex.: 10:00).');
      start = body.start_time;
      end = body.end_time;
      if (start > end) throw new HttpError(400, 'Horário: o horário especial não pode atravessar a meia-noite. O fim precisa ser depois do início.');
    }
    const reason = typeof body.reason === 'string' ? body.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || null : null;
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') throw new HttpError(400, 'Motivo: texto inválido.');
    const window = await one<{ ok: boolean }>(
      `select ($1::date >= ((now() at time zone (select timezone from store_settings where id = 1))::date - 1) and $1::date <= ((now() at time zone (select timezone from store_settings where id = 1))::date + 400)) as ok`,
      [day],
    );
    if (!window?.ok) throw new HttpError(400, 'Dia: escolha uma data a partir de ontem e até 400 dias à frente.');
    const saved = await one<Row>(
      `insert into store_exceptions (day, kind, start_time, end_time, reason, created_by) values ($1, $2, $3, $4, $5, $6)
       on conflict (day) do update set kind = excluded.kind, start_time = excluded.start_time, end_time = excluded.end_time, reason = excluded.reason, created_by = excluded.created_by
       returning day::text as day, kind, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time, reason`,
      [day, kind, start, end, reason, ctx.admin!.id],
    );
    await audit(ctx, {
      action: 'exception.save',
      summary: `Dia especial ${day}: ${kind === 'closed' ? 'loja fechada' : `aberta das ${start} às ${end}`}${reason ? ` (${reason})` : ''}`,
      entity: 'exception',
      details: { day, kind, start, end },
    });
    return json({ exception: saved }, 201);
  });

  r.delete('/api/admin/exceptions/:day', 'admin', async (ctx) => {
    const day = parseDay(ctx.params.day, 'Dia');
    const removed = await one<{ day: string }>('delete from store_exceptions where day = $1 returning day::text as day', [day]);
    if (!removed) throw new HttpError(404, 'Dia especial não encontrado.');
    await audit(ctx, { action: 'exception.delete', summary: `Removeu o dia especial ${day}`, entity: 'exception' });
    return json({ ok: true });
  });
}
