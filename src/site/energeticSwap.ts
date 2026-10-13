import { createContext, useContext } from 'react';

// Como qualquer parte do site abre a lista "QUERO TROCAR O ENERGÉTICO" (os combos). A janela fica numa só instância no PublicSite
// (EnergeticSwap.tsx); este arquivo é só o contrato, para as peças pequenas (aviso e linha do pedido) usarem sem importar a janela inteira.
export type EnergeticSwapApi = {
  // Abre a lista com todos os energéticos do site.
  open: () => void;
  // Há energéticos para mostrar? Sem eles o botão nem aparece.
  available: boolean;
};

export const EnergeticSwapContext = createContext<EnergeticSwapApi | null>(null);

export function useEnergeticSwap(): EnergeticSwapApi {
  const swap = useContext(EnergeticSwapContext);
  if (!swap) throw new Error('useEnergeticSwap precisa do EnergeticSwapProvider');
  return swap;
}
