// Variáveis que a integração da Vercel já cadastra no projeto "copocheio":
//   DATABASE_URL (ou POSTGRES_URL)  → Neon "copocheio-db"
//   credencial do Vercel Blob "copocheio-uploads" (veja blobToken abaixo)
// Ficam só no servidor: nada aqui é exposto ao navegador.

export const databaseUrl = (): string | undefined => process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;

// Vercel Blob tem dois modos de autenticação, e o servidor aceita os dois:
//  • token clássico: BLOB_READ_WRITE_TOKEN (ou <PREFIXO>_READ_WRITE_TOKEN, quando a integração foi conectada
//    com prefixo e é a única dessas variáveis);
//  • Blobs novos: sem token; a Vercel identifica a função por OIDC e a loja vem de BLOB_STORE_ID. O @vercel/blob
//    faz isso sozinho, então basta existir BLOB_STORE_ID.
export function blobToken(): string | undefined {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const prefixed = Object.keys(process.env).filter((name) => name.endsWith('_READ_WRITE_TOKEN') && process.env[name]);
  return prefixed.length === 1 ? process.env[prefixed[0]] : undefined;
}

export const blobConfigured = (): boolean => Boolean(blobToken() || process.env.BLOB_STORE_ID);

// Falta de configuração vira uma resposta 503 que diz exatamente qual variável não foi encontrada.
export class MissingConfig extends Error {
  constructor(
    public missing: string[],
    message?: string,
  ) {
    super(message ?? `Variável de ambiente ausente: ${missing.join(', ')}.`);
  }
}
