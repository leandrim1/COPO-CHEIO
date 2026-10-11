// Registro de atividades do painel: quem fez o quê e quando (tabela audit_log).
//
// • Nunca derruba a ação que está sendo registrada: se a gravação falhar, o erro vai para o log do servidor e a ação continua.
// • Não grava senha, código, link nem dado pessoal além do que a própria ação mostra (nome do produto, valores, e-mail do admin).
import { query } from './db.js';
import type { Row } from './db.js';
import type { Ctx } from './http.js';

export type AuditInput = {
  // Ex.: product.update, store.update, customer.reset_link
  action: string;
  // Frase pronta em português.
  summary: string;
  entity?: string;
  entityId?: string | number | null;
  details?: Row | null;
};

const clip = (value: string, max: number) => (Array.from(value).length > max ? Array.from(value).slice(0, max - 1).join('') + '…' : value);

export async function audit(ctx: Pick<Ctx, 'admin' | 'ip'>, input: AuditInput): Promise<void> {
  try {
    await query(
      `insert into audit_log (actor_id, actor_name, actor_email, action, entity, entity_id, summary, details, ip)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        ctx.admin?.id ?? null,
        ctx.admin ? clip(ctx.admin.name, 120) : null,
        ctx.admin?.email ?? null,
        clip(input.action, 60),
        input.entity ? clip(input.entity, 40) : null,
        input.entityId === undefined || input.entityId === null ? null : clip(String(input.entityId), 80),
        clip(input.summary, 400),
        input.details ? JSON.stringify(input.details) : null,
        ctx.ip && ctx.ip !== 'unknown' ? clip(ctx.ip, 64) : null,
      ],
    );
  } catch (error) {
    console.error('[auditoria] não foi possível registrar a atividade:', error instanceof Error ? error.message : error);
  }
}

// ---- Diferença entre o que estava e o que ficou -----------------------------------------------------------

export type FieldFormat = 'text' | 'money' | 'bool' | 'date' | 'changed';
export type FieldLabels = Record<string, { label: string; format?: FieldFormat; json?: boolean }>;

const brl = (value: unknown) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) ? `R$ ${Number(value).toFixed(2).replace('.', ',')}` : 'sem valor');

function show(value: unknown, format: FieldFormat): string {
  if (value === null || value === undefined || value === '') return 'vazio';
  switch (format) {
    case 'money':
      return brl(value);
    case 'bool':
      return value ? 'sim' : 'não';
    case 'date': {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? 'vazio' : d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
    }
    default:
      return clip(String(value), 60);
  }
}

const canon = (value: unknown, json: boolean | undefined): string => {
  let v = value;
  if (json && typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      /* fica como texto */
    }
  }
  if (v instanceof Date) v = v.toISOString();
  return JSON.stringify(v ?? null);
};

// Campos que mudaram entre `before` (linha do banco) e `values` (o que o painel mandou salvar). Devolve null se nada mudou.
// `text` é a frase para o histórico; `details` guarda de/para para consulta.
export function changedFields(before: Row | null, values: Row, labels: FieldLabels): { text: string; details: Row; names: string[] } | null {
  const parts: string[] = [];
  const details: Row = {};
  const names: string[] = [];
  for (const [key, meta] of Object.entries(labels)) {
    if (!(key in values)) continue;
    const from = before ? before[key] : null;
    const to = values[key];
    // Números do banco chegam como número; o painel pode mandar texto ("12,5" já virou número na validação).
    const same = meta.format === 'money' ? Number(from ?? NaN) === Number(to ?? NaN) || (from == null && to == null) : canon(from, meta.json) === canon(to, meta.json);
    if (same) continue;
    names.push(key);
    const format = meta.format ?? 'text';
    if (format === 'changed') {
      parts.push(`${meta.label} alterado`);
      details[key] = { changed: true };
    } else {
      parts.push(`${meta.label}: ${show(from, format)} → ${show(to, format)}`);
      details[key] = { from: meta.json && typeof from === 'object' ? from : (from ?? null), to: meta.json && typeof to === 'string' ? safeParse(to) : (to ?? null) };
    }
  }
  return parts.length ? { text: parts.join('; '), details, names } : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
