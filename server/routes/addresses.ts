// Endereços extras salvos na conta do cliente (o endereço principal continua em /api/account, como sempre foi). Só o dono da conta lê e mexe nos seus.
import { reserve } from '../auth.js';
import { requireCustomer } from '../customer.js';
import { one, query } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import { digits, parse, text } from '../validate.js';
import type { Spec } from '../validate.js';

const COLUMNS = 'id, label, cep, address, address_number, neighborhood, complement, reference';

const spec: Spec = {
  label: text('Apelido', { min: 1, max: 30, required: true }),
  cep: digits('CEP', { min: 8, max: 8, nullable: true }),
  address: text('Rua', { min: 1, max: 120, required: true }),
  address_number: text('Número', { min: 1, max: 20, required: true }),
  neighborhood: text('Bairro', { min: 1, max: 60, required: true }),
  complement: text('Complemento', { max: 60, nullable: true }),
  reference: text('Ponto de referência', { max: 120, nullable: true }),
};

export function registerAddresses(r: Router) {
  r.get('/api/account/addresses', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    return json({ addresses: await query<Row>(`select ${COLUMNS} from customer_addresses where customer_id = $1 order by created_at, id`, [customer.id]) });
  });

  r.post('/api/account/addresses', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    await reserve('cust-address', customer.id, 600, 30, 'Muitas alterações de endereço em pouco tempo. Aguarde alguns minutos.');
    const { values } = parse(spec, await readJson(ctx.req, 4 * 1024));
    const keys = Object.keys(values);
    const row = await one<Row>(
      `insert into customer_addresses (customer_id, ${keys.join(', ')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning ${COLUMNS}`,
      [customer.id, ...keys.map((k) => values[k])],
    );
    return json({ address: row }, 201);
  });

  r.patch('/api/account/addresses/:id', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const id = uuidParam(ctx);
    const { values } = parse(spec, await readJson(ctx.req, 4 * 1024), { partial: true });
    const keys = Object.keys(values);
    if (!keys.length) throw new HttpError(400, 'Nada para salvar.');
    // O endereço de outra conta responde 404 como se não existisse.
    const row = await one<Row>(
      `update customer_addresses set ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} where id = $${keys.length + 1} and customer_id = $${keys.length + 2} returning ${COLUMNS}`,
      [...keys.map((k) => values[k]), id, customer.id],
    );
    if (!row) throw new HttpError(404, 'Endereço não encontrado.');
    return json({ address: row });
  });

  r.delete('/api/account/addresses/:id', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const id = uuidParam(ctx);
    const removed = await one<Row>('delete from customer_addresses where id = $1 and customer_id = $2 returning id', [id, customer.id]);
    if (!removed) throw new HttpError(404, 'Endereço não encontrado.');
    return json({ ok: true });
  });
}
