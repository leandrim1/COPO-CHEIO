// Variáveis que a integração da Vercel já cadastra no projeto "copocheio":
//   DATABASE_URL (ou POSTGRES_URL)  → Neon "copocheio-db"
//   BLOB_READ_WRITE_TOKEN           → Vercel Blob "copocheio-uploads" (lida pelo @vercel/blob)
// Ficam só no servidor: nada aqui é exposto ao navegador.

export const databaseUrl = (): string | undefined => process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;

// A integração do Blob cadastra BLOB_READ_WRITE_TOKEN. Se o armazenamento foi conectado com um prefixo, a
// variável vira <PREFIXO>_READ_WRITE_TOKEN: aceitamos essa também, desde que haja uma só.
export function blobToken(): string | undefined {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const prefixed = Object.keys(process.env).filter((name) => name.endsWith('_READ_WRITE_TOKEN') && process.env[name]);
  return prefixed.length === 1 ? process.env[prefixed[0]] : undefined;
}

// Falta de configuração vira uma resposta 503 que diz exatamente qual variável não foi encontrada.
export class MissingConfig extends Error {
  constructor(public missing: string[]) {
    super(`Variável de ambiente ausente: ${missing.join(', ')}.`);
  }
}
