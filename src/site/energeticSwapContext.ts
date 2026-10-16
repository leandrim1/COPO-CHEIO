import { createContext, useContext } from 'react';
import type { Product } from './data';

// Como qualquer parte do site abre a lista "QUERO TROCAR O ENERGÉTICO" de um combo. A janela fica numa só instância no PublicSite
// (EnergeticSwap.tsx); este arquivo é só o contrato, para as peças pequenas (aviso e linha do pedido) usarem sem importar a janela inteira.
export type EnergeticSwapApi = {
  // Abre a lista de energéticos de 2L para trocar o que vem neste combo.
  open: (combo: Product) => void;
  // O combo aceita a troca? (o painel definiu o energético que vem nele e há energéticos de 2L para escolher)
  canSwap: (combo: Product) => boolean;
};

export const EnergeticSwapContext = createContext<EnergeticSwapApi | null>(null);

export function useEnergeticSwap(): EnergeticSwapApi {
  const swap = useContext(EnergeticSwapContext);
  if (!swap) throw new Error('useEnergeticSwap precisa do EnergeticSwapProvider');
  return swap;
}
