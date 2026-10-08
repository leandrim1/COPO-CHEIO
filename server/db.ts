import { neon, types } from '@neondatabase/serverless';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { MissingConfig, databaseUrl } from './env.js';

export type Row = Record<string, any>;
export type Statement = [text: string, params?: unknown[]];

// numeric (preços) e bigint (contagens, número do pedido) chegam como número, não como texto.
const NUMERIC = 1700;
const FLOAT8 = 701;
const INT8 = 20;
const parsers = {
  getTypeParser: ((oid: number, format?: string) =>
    oid === NUMERIC || oid === FLOAT8 ? Number.parseFloat : oid === INT8 ? Number : types.getTypeParser(oid, format as 'text')) as typeof types.getTypeParser,
};

let client: NeonQueryFunction<false, false> | null = null;

function sql() {
  if (!client) {
    const url = databaseUrl();
    if (!url) throw new MissingConfig(['DATABASE_URL']);
    // Driver HTTP do Neon: uma requisição por consulta, sem conexão aberta (ideal para funções serverless).
    client = neon(url);
  }
  return client;
}

export async function query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await sql().query(text, params, { types: parsers })) as T[];
}

export async function one<T = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await query<T>(text, params))[0] ?? null;
}

// Vários comandos numa única transação (tudo ou nada), numa só ida ao banco.
export async function batch(statements: Statement[]): Promise<Row[][]> {
  const db = sql();
  return (await db.transaction(statements.map(([text, params]) => db.query(text, params ?? [], { types: parsers })))) as Row[][];
}

// ---- Montagem de INSERT/UPDATE a partir de campos já validados ---------------------------------

const IDENT = /^[a-z_][a-z0-9_]*$/;

export type Cast = Record<string, string>;

function columns(values: Row, cast: Cast = {}) {
  const keys = Object.keys(values);
  keys.forEach((k) => {
    if (!IDENT.test(k)) throw new Error(`coluna inválida: ${k}`);
  });
  return { keys, placeholders: keys.map((k, i) => `$${i + 1}${cast[k] ? `::${cast[k]}` : ''}`), params: keys.map((k) => values[k]) };
}

export function insertRow<T = Row>(table: string, values: Row, cast?: Cast): Promise<T | null> {
  const c = columns(values, cast);
  const text = c.keys.length
    ? `insert into ${table} (${c.keys.join(', ')}) values (${c.placeholders.join(', ')}) returning *`
    : `insert into ${table} default values returning *`;
  return one<T>(text, c.params);
}

export function updateRow<T = Row>(table: string, where: { column: string; value: unknown }, values: Row, cast?: Cast): Promise<T | null> {
  const c = columns(values, cast);
  if (!IDENT.test(where.column)) throw new Error('coluna inválida');
  if (!c.keys.length) return one<T>(`select * from ${table} where ${where.column} = $1`, [where.value]);
  const sets = c.keys.map((k, i) => `${k} = ${c.placeholders[i]}`).join(', ');
  return one<T>(`update ${table} set ${sets} where ${where.column} = $${c.keys.length + 1} returning *`, [...c.params, where.value]);
}
