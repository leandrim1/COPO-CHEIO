import { PostgrestClient } from '@supabase/postgrest-js';

// Só variáveis públicas: a URL do projeto e a chave anon/publishable. A service role NUNCA vai para o
// navegador; quem protege os dados são as policies (RLS) do banco.
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? '';
export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';
export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);

// Cliente do site público: só consultas (PostgREST), sempre como visitante, mesmo se o dono estiver
// logado no painel no mesmo navegador. O painel usa o supabase-js completo, com sessão
// (src/admin/client.ts), e só é baixado em /admin.
export const db = supabaseConfigured
  ? new PostgrestClient(`${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
  : null;

export const MEDIA_BUCKET = 'media';

type MaybeError = { message?: string; code?: string; details?: string | null } | null | undefined;

// Mensagem para mostrar à pessoa. As regras do banco já respondem em português (código P0001).
export function friendlyError(error: unknown, fallback: string): string {
  const e = error as MaybeError;
  if (!e) return fallback;
  if (e.code === 'P0001' && e.message) return e.message;
  if (e.code === '42501') return 'Você não tem permissão para isso.';
  if (e.code === '23505') return 'Já existe um item com esse nome ou código.';
  if (e.code === '23514') return 'Algum campo está fora do formato permitido. Confira e tente de novo.';
  if (e.code === '23503') return 'Este item está ligado a outros dados e não pode ser removido.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(e.message ?? '')) return 'Sem conexão. Verifique a internet e tente de novo.';
  return fallback;
}
