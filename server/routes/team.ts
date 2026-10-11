// Painel: administradores (só o owner gerencia).
import { audit } from '../audit.js';
import { checkNewPassword, hashPassword } from '../auth.js';
import { batch, one, query } from '../db.js';
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

const COLUMNS = 'id, name, email, role, active, last_login_at, created_at, (totp_enabled_at is not null) as two_factor';

export function registerTeam(r: Router) {
  r.get('/api/admin/admins', 'owner', async () => json({ admins: await query(`select ${COLUMNS} from admins order by created_at`) }));

  r.post('/api/admin/admins', 'owner', async (ctx) => {
    const body = await readJson(ctx.req, 8 * 1024);
    const { values } = parse(adminSpec, body);
    const passwordHash = await hashPassword(checkNewPassword(body.password, { kind: 'admin', email: String(values.email), name: String(values.name) }));
    const admin = await one<{ id: string }>(
      `insert into admins (name, email, password_hash, role) values ($1, $2, $3, $4) returning ${COLUMNS}`,
      [values.name, values.email, passwordHash, values.role ?? 'admin'],
    );
    await audit(ctx, { action: 'admin.create', summary: `Adicionou o administrador ${values.name} (${values.email}) como ${values.role ?? 'admin'}`, entity: 'admin', entityId: admin?.id });
    return json({ admin }, 201);
  });

  r.patch('/api/admin/admins/:id', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 8 * 1024);
    const { values } = parse(adminSpec, body, { partial: true });
    if (id === ctx.admin!.id && (values.active === false || (values.role && values.role !== 'owner'))) {
      throw new HttpError(400, 'Você não pode desativar nem rebaixar a própria conta.');
    }
    const before = await one<{ name: string; email: string; role: string; active: boolean }>('select name, email, role, active from admins where id = $1', [id]);
    if (!before) throw new HttpError(404, 'Administrador não encontrado.');
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of Object.entries(values)) {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    // Redefinir a senha de alguém encerra as sessões abertas dessa pessoa.
    if (body.password !== undefined) {
      params.push(await hashPassword(checkNewPassword(body.password, { kind: 'admin', email: String(values.email ?? before.email), name: String(values.name ?? before.name) })));
      sets.push(`password_hash = $${params.length}`);
      await query('delete from admin_sessions where admin_id = $1', [id]);
    }
    if (!sets.length) throw new HttpError(400, 'Nada para atualizar.');
    params.push(id);
    const admin = await one(`update admins set ${sets.join(', ')} where id = $${params.length} returning ${COLUMNS}`, params);
    if (!admin) throw new HttpError(404, 'Administrador não encontrado.');

    const who = `${before.name} (${before.email})`;
    const notes: string[] = [];
    if (body.password !== undefined) notes.push('redefiniu a senha');
    if (values.role !== undefined && values.role !== before.role) notes.push(`mudou a função para ${values.role}`);
    if (values.active !== undefined && values.active !== before.active) notes.push(values.active ? 'reativou o acesso' : 'desativou o acesso');
    if (values.name !== undefined && values.name !== before.name) notes.push(`mudou o nome para ${values.name}`);
    if (values.email !== undefined && values.email !== before.email) notes.push(`mudou o e-mail para ${values.email}`);
    if (notes.length) await audit(ctx, { action: 'admin.update', summary: `Administrador ${who}: ${notes.join('; ')}`, entity: 'admin', entityId: id });
    return json({ admin });
  });

  // Quem perdeu o celular e os códigos de recuperação: o owner desliga a verificação em duas etapas dessa pessoa (as sessões dela
  // são encerradas) e ela configura de novo depois de entrar com a senha.
  r.post('/api/admin/admins/:id/reset-2fa', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const target = await one<{ name: string; email: string }>('select name, email from admins where id = $1', [id]);
    if (!target) throw new HttpError(404, 'Administrador não encontrado.');
    await batch([
      ['update admins set totp_secret = null, totp_enabled_at = null, totp_last_step = null where id = $1', [id]],
      ['delete from admin_recovery_codes where admin_id = $1', [id]],
      ['delete from admin_login_challenges where admin_id = $1', [id]],
      ['delete from admin_sessions where admin_id = $1', [id]],
    ]);
    await audit(ctx, { action: 'admin.reset_2fa', summary: `Desligou a verificação em duas etapas de ${target.name} (${target.email})`, entity: 'admin', entityId: id });
    return json({ ok: true });
  });

  r.delete('/api/admin/admins/:id', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    if (id === ctx.admin!.id) throw new HttpError(400, 'Você não pode remover a própria conta.');
    const removed = await one<{ name: string; email: string }>('delete from admins where id = $1 returning name, email', [id]);
    if (!removed) throw new HttpError(404, 'Administrador não encontrado.');
    await audit(ctx, { action: 'admin.delete', summary: `Removeu o administrador ${removed.name} (${removed.email})`, entity: 'admin', entityId: id });
    return json({ ok: true });
  });
}
