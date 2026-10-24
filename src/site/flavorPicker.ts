import { createContext, useContext } from 'react';
import type { CartLine, Product } from './data';

// Como qualquer parte do site abre a escolha dos gelos saborizados de um combo. A janela (FlavorChoice.tsx) fica numa só instância no PublicSite; este arquivo é
// só o contrato, para as peças pequenas (cartão do produto, linha do pedido, checkout) usarem sem importar a janela inteira.
export type FlavorPickerApi = {
  // Abre a escolha dos gelos de um combo e, confirmada, põe UMA unidade do combo no pedido com os sabores escolhidos.
  pick: (product: Product) => void;
  // Reabre a escolha de uma unidade que já está no pedido, com os sabores dela já marcados.
  edit: (line: CartLine) => void;
};

export const FlavorPickerContext = createContext<FlavorPickerApi | null>(null);

export function useFlavorPicker(): FlavorPickerApi {
  const picker = useContext(FlavorPickerContext);
  if (!picker) throw new Error('useFlavorPicker precisa do FlavorPickerProvider');
  return picker;
}
