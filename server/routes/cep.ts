// Consulta de CEP para preencher o endereço no checkout. O navegador pergunta a ESTE servidor; só o servidor fala com o serviço público de CEP (ViaCEP, gratuito e sem
// chave), então o endereço de internet do cliente não vai para terceiros e a política de segurança do site (CSP) não precisa liberar nenhum domínio novo.
// Se o serviço estiver fora do ar, o checkout continua: a pessoa preenche o endereço à mão.
import { reserve } from '../auth.js';
import { query } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json } from '../http.js';
import type { Router } from '../http.js';

// Endereço do serviço de CEP. Só os testes trocam (CEP_API_URL, um servidor falso local); em produção vale o padrão.
const baseUrl = () => ((process.env.VERCEL_ENV === 'production' ? '' : process.env.CEP_API_URL) || 'https://viacep.com.br/ws').replace(/\/+$/, '');

const TTL = 24 * 3600 * 1000;
const cache = new Map<string, { at: number; value: CepResult | null }>();

export type CepResult = { cep: string; street: string; neighborhood: string; city: string; state: string };

const clean = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

// Sem acento, minúsculas e espaços únicos: "São Sebastião" = "sao sebastiao".
export const normalizeName = (value: string): string => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

async function lookup(cep: string): Promise<CepResult | null> {
  const hit = cache.get(cep);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/${cep}/json/`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
  } catch {
    throw new HttpError(502, 'Não foi possível consultar o CEP agora. Preencha o endereço à mão.', { code: 'cep_unavailable' });
  }
  // O serviço responde 400 para CEP com formato inválido e 200 com { erro: true } para CEP que não existe.
  if (response.status === 400 || response.status === 404) return remember(cep, null);
  if (!response.ok) throw new HttpError(502, 'Não foi possível consultar o CEP agora. Preencha o endereço à mão.', { code: 'cep_unavailable' });
  let data: Row;
  try {
    data = (await response.json()) as Row;
  } catch {
    throw new HttpError(502, 'Não foi possível consultar o CEP agora. Preencha o endereço à mão.', { code: 'cep_unavailable' });
  }
  if (!data || typeof data !== 'object' || data.erro === true || data.erro === 'true') return remember(cep, null);
  const value: CepResult = {
    cep,
    street: clean(data.logradouro, 120),
    neighborhood: clean(data.bairro, 60),
    city: clean(data.localidade, 60),
    state: clean(data.uf, 2).toUpperCase(),
  };
  return remember(cep, value);
}

function remember(cep: string, value: CepResult | null): CepResult | null {
  if (cache.size > 500) cache.clear();
  cache.set(cep, { at: Date.now(), value });
  return value;
}

export function registerCep(r: Router) {
  r.get('/api/cep/:cep', 'public', async (ctx) => {
    const cep = String(ctx.params.cep ?? '').replace(/\D/g, '');
    if (!/^\d{8}$/.test(cep)) throw new HttpError(400, 'Informe um CEP com 8 números.');
    await reserve('cep', ctx.ip, 600, 60, 'Muitas consultas de CEP em pouco tempo. Preencha o endereço à mão ou aguarde um pouco.');
    const found = await lookup(cep);
    if (!found) throw new HttpError(404, 'Não encontramos esse CEP. Confira os números ou preencha o endereço à mão.', { code: 'cep_not_found' });
    // O bairro do CEP bate com algum bairro atendido? (só a loja decide: bairros cadastrados e ativos; sem bairros cadastrados vale a taxa única)
    const zones = await query<Row>('select name, fee from delivery_zones where active');
    let zone: { name: string; fee: number } | null = null;
    if (zones.length && found.neighborhood) {
      const wanted = normalizeName(found.neighborhood);
      const match = zones.find((z) => normalizeName(String(z.name)) === wanted);
      if (match) zone = { name: String(match.name), fee: Number(match.fee) };
    }
    return json({ address: found, zone, zones_configured: zones.length > 0 }, 200, { 'cache-control': 'private, max-age=3600' });
  });
}
