// Utilidades HTTP (Request/Response padrão da web) e o roteador da API.
import type { Row } from './db.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Row,
  ) {
    super(message);
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // Respostas da API nunca ficam em cache: preço, estoque e pedidos precisam estar sempre em dia.
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(data: unknown, status = 200, headers: Record<string, string | string[]> = {}): Response {
  const h = new Headers(JSON_HEADERS);
  for (const [k, v] of Object.entries(headers)) for (const item of Array.isArray(v) ? v : [v]) h.append(k, item);
  return new Response(JSON.stringify(data), { status, headers: h });
}

export async function readBytes(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new HttpError(413, 'O arquivo é grande demais.');
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > maxBytes) throw new HttpError(413, 'O arquivo é grande demais.');
  return body;
}

export async function readJson(req: Request, maxBytes = 256 * 1024): Promise<Row> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Envie os dados em JSON.');
  const bytes = await readBytes(req, maxBytes);
  try {
    const text = new TextDecoder().decode(bytes);
    // O caractere nulo (\u0000) é inválido em texto do Postgres: barra aqui, para nenhuma rota virar erro 500 por causa dele.
    if (/\\u0000/i.test(text)) throw new Error('nulo');
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('formato');
    return parsed as Row;
  } catch {
    throw new HttpError(400, 'Os dados enviados são inválidos.');
  }
}

// ---- Roteador ------------------------------------------------------------------------------------

export type Admin = { id: string; name: string; email: string; role: 'owner' | 'admin' };
export type Access = 'public' | 'admin' | 'owner';

export type Ctx = {
  req: Request;
  url: URL;
  params: Record<string, string>;
  ip: string;
  admin: Admin | null;
};

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

type Route = { method: string; pattern: RegExp; keys: string[]; access: Access; handler: Handler };

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, access: Access, handler: Handler) {
    const keys: string[] = [];
    const source = path.replace(/:([a-z]+)/gi, (_m, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(`^${source}/?$`), keys, access, handler });
    return this;
  }

  get = (path: string, access: Access, handler: Handler) => this.add('GET', path, access, handler);
  post = (path: string, access: Access, handler: Handler) => this.add('POST', path, access, handler);
  put = (path: string, access: Access, handler: Handler) => this.add('PUT', path, access, handler);
  patch = (path: string, access: Access, handler: Handler) => this.add('PATCH', path, access, handler);
  delete = (path: string, access: Access, handler: Handler) => this.add('DELETE', path, access, handler);

  match(method: string, path: string): { route: Route; params: Record<string, string> } | { allowed: string[] } | null {
    const allowed: string[] = [];
    for (const route of this.routes) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      if (route.method !== method) {
        allowed.push(route.method);
        continue;
      }
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch {
          params[key] = m[i + 1];
        }
      });
      return { route, params };
    }
    return allowed.length ? { allowed } : null;
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidParam(ctx: Ctx, key = 'id'): string {
  const value = ctx.params[key];
  if (!UUID.test(value)) throw new HttpError(404, 'Não encontrado.');
  return value;
}
