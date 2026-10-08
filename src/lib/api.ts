// Cliente da API do COPO CHEIO (/api/*). Roda no servidor (Vercel Functions): o navegador nunca fala
// direto com o banco nem com o armazenamento, e não guarda nenhuma credencial.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public missing?: string[],
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[];
type ErrorBody = { error?: string; code?: string; missing?: string[] };

// Chamado quando uma rota do painel responde 401 (sessão vencida ou encerrada).
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (handler: (() => void) | null) => {
  onUnauthorized = handler;
};

async function request<T>(method: string, path: string, body?: Json | Blob | ArrayBuffer, init: RequestInit = {}): Promise<T> {
  const isJson = body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      ...init,
      headers: { ...(isJson ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: body === undefined ? undefined : isJson ? JSON.stringify(body) : (body as BodyInit),
    });
  } catch {
    throw new ApiError(0, 'Sem conexão. Verifique a internet e tente de novo.', 'network');
  }
  let data: ErrorBody | null = null;
  try {
    data = (await response.json()) as ErrorBody;
  } catch {
    /* corpo vazio ou não JSON */
  }
  if (!response.ok) {
    if (response.status === 401 && path.startsWith('/api/admin')) onUnauthorized?.();
    throw new ApiError(response.status, data?.error ?? `O servidor respondeu com erro ${response.status}. Tente de novo em instantes.`, data?.code, data?.missing);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>('GET', path, undefined, init),
  post: <T>(path: string, body: Json = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: Json) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: Json) => request<T>('PUT', path, body),
  delete: <T>(path: string, body?: Json) => request<T>('DELETE', path, body),
  // Envia um arquivo (imagem) como corpo binário.
  upload: <T>(path: string, file: Blob) => request<T>('POST', path, file, { headers: { 'content-type': file.type || 'application/octet-stream' } }),
};

// Mensagem para mostrar à pessoa. O servidor já responde em português.
export function friendlyError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message) return error.message;
  return fallback;
}
