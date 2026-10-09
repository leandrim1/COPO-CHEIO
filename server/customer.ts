// Conta do cliente (opcional): sessão opaca guardada no Neon (só o hash) e entregue em cookie HttpOnly.
// Separada do login do painel: outro cookie, outra tabela, outro conjunto de rotas.
import { randomBytes } from 'node:crypto';
import { cookieHeader, readCookie, sha256 } from './auth.js';
import { one, query } from './db.js';
import { HttpError } from './http.js';
import type { Ctx } from './http.js';

export const CUSTOMER_COOKIE = 'copocheio_cliente';
const SESSION_DAYS = 30;

export type Customer = {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string | null;
  address_number: string | null;
  neighborhood: string | null;
  complement: string | null;
  reference: string | null;
};

export const CUSTOMER_COLUMNS = 'c.id, c.name, c.email, c.phone, c.address, c.address_number, c.neighborhood, c.complement, c.reference';

export const customerCookie = (req: Request, token: string, maxAge: number): string => cookieHeader(req, CUSTOMER_COOKIE, token, maxAge);

export async function createCustomerSession(customerId: string): Promise<{ token: string; maxAge: number }> {
  const token = randomBytes(32).toString('base64url');
  await query(`insert into customer_sessions (token_hash, customer_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`, [sha256(token), customerId, SESSION_DAYS]);
  // Limpeza de dados técnicos vencidos, de vez em quando.
  if (Math.random() < 0.05) await query('select purge_expired_data()');
  return { token, maxAge: SESSION_DAYS * 86400 };
}

// Sem cookie nem chega a consultar o banco.
export async function customerFromRequest(req: Request): Promise<Customer | null> {
  const token = readCookie(req, CUSTOMER_COOKIE);
  if (!token || token.length > 100) return null;
  return one<Customer>(
    `select ${CUSTOMER_COLUMNS}
       from customer_sessions s join customers c on c.id = s.customer_id
      where s.token_hash = $1 and s.expires_at > now() and c.active`,
    [sha256(token)],
  );
}

export async function requireCustomer(ctx: Ctx): Promise<Customer> {
  const customer = await customerFromRequest(ctx.req);
  if (!customer) throw new HttpError(401, 'Faça login para continuar.');
  return customer;
}

export async function destroyCustomerSession(req: Request): Promise<void> {
  const token = readCookie(req, CUSTOMER_COOKIE);
  if (token) await query('delete from customer_sessions where token_hash = $1', [sha256(token)]);
}
