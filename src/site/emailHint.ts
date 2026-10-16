// Dica de erro de digitação no domínio do e-mail ("maria@gmial.com" → "maria@gmail.com").
//
// É SÓ uma sugestão para a pessoa conferir: nunca bloqueia nada e não existe lista de domínios aceitos (qualquer provedor ou empresa pode ser usado).
// A lista abaixo serve apenas de modelo para reconhecer o erro de digitação mais comum nos provedores mais usados no Brasil. Um endereço que não se
// parece com nenhum deles passa em branco, sem sugestão.

const POPULAR = [
  'gmail.com', 'hotmail.com', 'hotmail.com.br', 'outlook.com', 'outlook.com.br', 'yahoo.com', 'yahoo.com.br', 'icloud.com', 'live.com', 'msn.com',
  'uol.com.br', 'bol.com.br', 'terra.com.br', 'globo.com', 'ig.com.br', 'protonmail.com', 'proton.me',
];

// Provedores de verdade que parecem erro de digitação de um popular: nunca recebem sugestão.
const REAL_NEIGHBOURS = new Set(['email.com', 'mail.com', 'gmx.com', 'ymail.com', 'outlook.com.br', 'live.com.br', 'hotmail.com.br']);

// Erros que a distância de edição não pega bem (domínio de outro país no fim, "com" colado no nome etc.).
const KNOWN_TYPOS: Record<string, string> = {
  'gmail.con': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.cm': 'gmail.com',
  'gmail.om': 'gmail.com',
  'gmail.com.br': 'gmail.com',
  'gmail.comm': 'gmail.com',
  'gmailcom': 'gmail.com',
  'gmail,com': 'gmail.com',
  'hotmail.con': 'hotmail.com',
  'hotmail.co': 'hotmail.com',
  'hotmail.cm': 'hotmail.com',
  'hotmailcom': 'hotmail.com',
  'outlook.con': 'outlook.com',
  'outlook.co': 'outlook.com',
  'yahoo.con': 'yahoo.com',
  'yahoo.co': 'yahoo.com',
  'yahoo.com.b': 'yahoo.com.br',
  'yahoo.com.brr': 'yahoo.com.br',
  'icloud.con': 'icloud.com',
  'icloud.co': 'icloud.com',
  'uol.com': 'uol.com.br',
  'uol.com.b': 'uol.com.br',
  'bol.com': 'bol.com.br',
  'terra.com': 'terra.com.br',
};

// Distância de edição com troca de letras vizinhas contando como um erro só (Damerau–Levenshtein, na versão simples).
function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Devolve o endereço corrigido, ou null quando não há o que sugerir (o endereço pode estar certo, e qualquer provedor vale).
export function suggestEmail(input: string): string | null {
  const text = input.replace(/[​-‍⁠﻿]/g, '').trim();
  const at = text.lastIndexOf('@');
  if (at < 1 || at !== text.indexOf('@')) return null;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1).toLowerCase();
  if (domain.length < 4 || POPULAR.includes(domain) || REAL_NEIGHBOURS.has(domain)) return null;
  const known = KNOWN_TYPOS[domain];
  if (known) return `${local}@${known}`;
  // Um único erro de digitação (letra a mais, a menos, errada ou trocada) em relação a um provedor conhecido de nome comprido o bastante
  // para a sugestão não ser chute (nomes curtos como "uol.com.br" só entram pela lista de erros conhecidos acima).
  let best: { domain: string; d: number } | null = null;
  for (const popular of POPULAR) {
    if (popular.length < 9) continue;
    if (Math.abs(popular.length - domain.length) > 1) continue;
    const d = distance(domain, popular);
    if (d === 1 && (!best || d < best.d)) best = { domain: popular, d };
  }
  return best ? `${local}@${best.domain}` : null;
}
