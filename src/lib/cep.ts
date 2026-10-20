import { api } from './api';

// Consulta de CEP feita pelo servidor da loja (GET /api/cep/:cep). Devolve a rua e o bairro; se a loja cadastrou bairros atendidos e o bairro do CEP é um deles,
// `zone` traz o nome cadastrado (é ele que vale no pedido).
export type CepAnswer = {
  address: { cep: string; street: string; neighborhood: string; city: string; state: string };
  zone: { name: string; fee: number } | null;
  zones_configured: boolean;
};

export const maskCep = (input: string): string => {
  const digits = input.replace(/\D/g, '').slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
};

export const fetchCep = (digits: string): Promise<CepAnswer> => api.get<CepAnswer>(`/api/cep/${digits}`);
