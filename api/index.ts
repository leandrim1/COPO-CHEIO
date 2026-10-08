// Função da Vercel: recebe todas as chamadas /api/* e entrega para o handler em server/.
//
// O vercel.json reescreve /api/:path* para esta função com ?__path=:path*. A Vercel só liga um arquivo
// `api/[...x].ts` a UM segmento (/api/products, mas não /api/auth/me), por isso o caminho de verdade
// vem desse parâmetro; sem ele (vite dev, testes), vale o caminho da própria requisição.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handle } from '../server/index.js';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim();
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const url = new URL(req.url ?? '/', `${proto}://${host}`);
  const routed = url.searchParams.get('__path');
  if (routed !== null) {
    url.pathname = `/api/${routed}`;
    url.searchParams.delete('__path');
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }

  const request = new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
  } as RequestInit);

  const response = await handle(request);

  res.statusCode = response.status;
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') res.setHeader(key, value);
  });
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}
