// Única porta de entrada das operadoras de pagamento.
//
// HOJE NÃO HÁ NENHUM ADAPTADOR DE PRODUÇÃO: a integração com a ValidaPay depende da documentação oficial (endpoints, escopos OAuth, formato
// das cobranças, divisão da comissão, avisos e assinatura dos webhooks), que ainda não foi consultada. Sem adaptador, o pagamento online
// fica indisponível: o painel não deixa ligar o "Pix online" e o servidor recusa cobranças com um aviso claro. Nada é simulado aqui.
//
// Quando o adaptador existir, é só devolvê-lo daqui (lendo as credenciais das variáveis de ambiente do servidor, nunca do navegador).
// Os testes automatizados trocam este módulo, na hora de montar a API de teste, por um simulador (tests/payments-sim.mjs): o simulador
// nunca faz parte do código que vai para produção.
import type { PaymentProvider } from './types.js';

export function createProvider(): PaymentProvider | null {
  return null;
}
