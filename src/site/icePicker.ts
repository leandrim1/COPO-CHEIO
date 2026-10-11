import { createContext, useContext } from 'react';
import type { CartLine, Product } from './data';

// Como qualquer parte do site pede a pergunta do gelo. O painel que pergunta (IceChoice.tsx) fica numa só instância no PublicSite; este
// arquivo é só o contrato, para as peças pequenas (como a linha do pedido) usarem sem importar o painel inteiro.
export type IcePickerApi = {
  // Pergunta o gelo e, escolhido, põe uma unidade do produto no pedido.
  pick: (product: Product) => void;
  // Troca o gelo de uma linha que já está no pedido (a escolha atual vem marcada).
  edit: (line: CartLine) => void;
};

export const IcePickerContext = createContext<IcePickerApi | null>(null);

export function useIcePicker(): IcePickerApi {
  const picker = useContext(IcePickerContext);
  if (!picker) throw new Error('useIcePicker precisa do IcePickerProvider');
  return picker;
}
