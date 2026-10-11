// Painel: histórico de atividades (quem fez o quê e quando). Só o owner consulta.
import { query } from '../db.js';
import { json } from '../http.js';
import type { Router } from '../http.js';

const ENTITIES = ['product', 'category', 'store', 'site', 'hero', 'banner', 'zone', 'payment', 'order', 'customer', 'admin', 'privacy', 'privacy_request'];

export function registerAudit(r: Router) {
  r.get('/api/admin/audit', 'owner', async (ctx) => {
    const q = ctx.url.searchParams;
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 200);
    const where: string[] = [];
    const params: unknown[] = [];
    const before = q.get('before');
    if (before && /^\d{1,18}$/.test(before)) {
      params.push(before);
      where.push(`id < $${params.length}::bigint`);
    }
    const entity = q.get('entity');
    if (entity && ENTITIES.includes(entity)) {
      params.push(entity);
      where.push(`entity = $${params.length}`);
    }
    const actor = q.get('actor');
    if (actor && /^[0-9a-f-]{36}$/i.test(actor)) {
      params.push(actor);
      where.push(`actor_id = $${params.length}::uuid`);
    }
    const term = (q.get('q') ?? '').trim().slice(0, 80);
    if (term) {
      params.push(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(summary ilike $${params.length} or actor_name ilike $${params.length} or actor_email ilike $${params.length})`);
    }
    params.push(limit + 1);
    const rows = await query(
      `select id, created_at, actor_id, actor_name, actor_email, action, entity, entity_id, summary, details, ip
         from audit_log ${where.length ? `where ${where.join(' and ')}` : ''}
        order by id desc limit $${params.length}`,
      params,
    );
    return json({ entries: rows.slice(0, limit), has_more: rows.length > limit });
  });
}
