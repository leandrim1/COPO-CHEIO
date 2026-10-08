// Variáveis que a integração da Vercel já cadastra no projeto "copocheio":
//   DATABASE_URL (ou POSTGRES_URL)  → Neon "copocheio-db"
//   BLOB_READ_WRITE_TOKEN           → Vercel Blob "copocheio-uploads" (lida pelo @vercel/blob)
// Ficam só no servidor: nada aqui é exposto ao navegador.

export const databaseUrl = (): string | undefined => process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;

export const blobToken = (): string | undefined => process.env.BLOB_READ_WRITE_TOKEN || undefined;

// Falta de configuração vira uma resposta 503 que diz exatamente qual variável não foi encontrada.
export class MissingConfig extends Error {
  constructor(public missing: string[]) {
    super(`Variável de ambiente ausente: ${missing.join(', ')}.`);
  }
}
