// Painel: administradores (só o owner gerencia).
import { checkNewPassword, hashPassword } from '../auth.js';
import { one, query } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import { bool, email, oneOf, parse, text } from '../validate.js';
import type { Spec } from '../validate.js';

const adminSpec: Spec = {
  name: text('Nome', { min: 1, max: 80, required: true }),
  email,
  role: oneOf('Função', ['owner', 'admin'] as const),
  active: bool('Ativo'),
};

const COLUMNS = 'id, name, email, role, active, last_login_at, created_at';

export function registerTeam(r: Router) {
  r.get('/api/admin/admins', 'owner', async () => json({ admins: await query(`select ${COLUMNS} from admins order by created_at`) }));

  r.post('/api/admin/admins', 'owner', async (ctx) => {
    const body = await readJson(ctx.req, 8 * 1024);
    const { values } = parse(adminSpec, body);
    const passwordHash = await hashPassword(checkNewPassword(body.password));
    const admin = await one(
      `insert into admins (name, email, password_hash, role) values ($1, $2, $3, $4) returning ${COLUMNS}`,
      [values.name, values.email, passwordHash, values.role ?? 'admin'],
    );
    return json({ admin }, 201);
  });

  r.patch('/api/admin/admins/:id', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 8 * 1024);
    const { values } = parse(adminSpec, body, { partial: true });
    if (id === ctx.admin!.id && (values.active === false || (values.role && values.role !== 'owner'))) {
      throw new HttpError(400, 'Você não pode desativar nem rebaixar a própria conta.');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of Object.entries(values)) {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    // Redefinir a senha de alguém encerra as sessões abertas dessa pessoa.
    if (body.password !== undefined) {
      params.push(await hashPassword(checkNewPassword(body.password)));
      sets.push(`password_hash = $${params.length}`);
      await query('delete from admin_sessions where admin_id = $1', [id]);
    }
    if (!sets.length) throw new HttpError(400, 'Nada para atualizar.');
    params.push(id);
    const admin = await one(`update admins set ${sets.join(', ')} where id = $${params.length} returning ${COLUMNS}`, params);
    if (!admin) throw new HttpError(404, 'Administrador não encontrado.');
    return json({ admin });
  });

  r.delete('/api/admin/admins/:id', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    if (id === ctx.admin!.id) throw new HttpError(400, 'Você não pode remover a própria conta.');
    if (!(await one('delete from admins where id = $1 returning id', [id]))) throw new HttpError(404, 'Administrador não encontrado.');
    return json({ ok: true });
  });
}
