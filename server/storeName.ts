// Nome da loja como aparece nos aplicativos de verificação em duas etapas e em outros textos curtos do servidor.
import { one } from './db.js';

export async function loadStoreName(): Promise<string> {
  try {
    const row = await one<{ store_name: string | null }>('select store_name from store_settings where id = 1');
    return row?.store_name?.trim() || 'Copo Cheio';
  } catch {
    return 'Copo Cheio';
  }
}
