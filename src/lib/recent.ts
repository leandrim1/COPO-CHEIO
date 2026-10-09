// Pedidos feitos neste aparelho: só uma conveniência para voltar rápido. A fonte de verdade é o banco; o
// pedido continua acessível pelo link, por número + código ou pela conta, mesmo sem nada guardado aqui.
const KEY = 'copocheio:pedidos-recentes';
const MAX = 5;

export type RecentOrder = { number: number; token: string; at: string };

export function loadRecent(): RecentOrder[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is RecentOrder => !!r && typeof r.number === 'number' && typeof r.token === 'string' && typeof r.at === 'string')
      .slice(0, MAX);
  } catch {
    return [];
  }
}

function save(list: RecentOrder[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* modo privado ou sem espaço: tudo bem, o link continua valendo */
  }
}

export function rememberOrder(number: number, token: string) {
  save([{ number, token, at: new Date().toISOString() }, ...loadRecent().filter((r) => r.number !== number)]);
}

export function forgetOrder(number: number) {
  save(loadRecent().filter((r) => r.number !== number));
}

export function forgetAllOrders() {
  save([]);
}
