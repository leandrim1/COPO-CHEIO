// Entregadores: o essencial. A loja cadastra quem entrega e escolhe o entregador de cada pedido; o NOME fica gravado no pedido (renomear ou apagar o entregador
// depois não muda o histórico). O cliente vê só o primeiro nome, e só enquanto o pedido está a caminho.
import { audit } from '../audit.js';
import { insertRow, one, query, updateRow } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import { bool, digits, parse, text } from '../validate.js';
import type { Spec } from '../validate.js';

const spec: Spec = {
  name: text('Nome', { min: 2, max: 60, required: true }),
  phone: digits('Telefone', { min: 10, max: 13, nullable: true }),
  active: bool('Ativo'),
};

export function registerCouriers(r: Router) {
  r.get('/api/admin/couriers', 'admin', async () =>
    json({
      couriers: await query<Row>(
        `select c.*, (select count(*)::int from orders o where o.courier_id = c.id and o.order_status = 'out_for_delivery') as on_route
           from couriers c order by c.active desc, c.name`,
      ),
    }),
  );

  r.post('/api/admin/couriers', 'admin', async (ctx) => {
    const { values } = parse(spec, await readJson(ctx.req, 2048));
    const courier = await insertRow<Row>('couriers', values);
    await audit(ctx, { action: 'courier.create', summary: `Cadastrou o entregador ${values.name}`, entity: 'courier', entityId: courier?.id });
    return json({ courier }, 201);
  });

  r.patch('/api/admin/couriers/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const { values } = parse(spec, await readJson(ctx.req, 2048), { partial: true });
    const courier = await updateRow('couriers', { column: 'id', value: id }, values);
    if (!courier) throw new HttpError(404, 'Entregador não encontrado.');
    await audit(ctx, { action: 'courier.update', summary: `Atualizou o entregador ${courier.name}`, entity: 'courier', entityId: id });
    return json({ courier });
  });

  r.delete('/api/admin/couriers/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const removed = await one<Row>('delete from couriers where id = $1 returning name', [id]);
    if (!removed) throw new HttpError(404, 'Entregador não encontrado.');
    await audit(ctx, { action: 'courier.delete', summary: `Removeu o entregador ${removed.name} (os pedidos antigos mantêm o nome)`, entity: 'courier', entityId: id });
    return json({ ok: true });
  });

  // Escolhe (ou tira) o entregador de um pedido de ENTREGA que ainda não foi cancelado. O nome é copiado para o pedido.
  r.patch('/api/admin/orders/:id/courier', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 512);
    const courierId = body.courier_id === null || body.courier_id === undefined || body.courier_id === '' ? null : String(body.courier_id);
    if (courierId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(courierId)) throw new HttpError(400, 'Entregador inválido.');
    const order = await one<Row>('select id, order_number, delivery_type, order_status from orders where id = $1', [id]);
    if (!order) throw new HttpError(404, 'Pedido não encontrado.');
    if (order.delivery_type !== 'delivery') throw new HttpError(409, 'Só pedido de entrega tem entregador.');
    if (order.order_status === 'cancelled') throw new HttpError(409, 'Pedido cancelado não tem entregador.');
    let name: string | null = null;
    if (courierId !== null) {
      const courier = await one<Row>('select name, active from couriers where id = $1', [courierId]);
      if (!courier) throw new HttpError(404, 'Entregador não encontrado.');
      if (!courier.active) throw new HttpError(409, 'Este entregador está desativado.');
      name = String(courier.name);
    }
    const updated = await one<Row>('update orders set courier_id = $2, courier_name = $3 where id = $1 returning id, courier_id, courier_name', [id, courierId, name]);
    await audit(ctx, { action: 'order.courier', summary: name ? `Pedido #${order.order_number}: entregador ${name}` : `Pedido #${order.order_number}: sem entregador`, entity: 'order', entityId: id });
    return json({ order: updated });
  });
}
