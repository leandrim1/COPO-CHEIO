// Máscaras e conferências dos campos do cartão. Servem só para dar retorno rápido a quem digita: quem decide é a operadora do cartão e, no CPF/CNPJ, o
// servidor. NADA daqui guarda o cartão: os valores vivem só nos campos da tela e vão direto para a operadora.

export const digitsOf = (text: string): string => text.replace(/\D/g, '');

// 4111111111111111 → "4111 1111 1111 1111" (até 19 dígitos).
export function maskCardNumber(input: string): string {
  return digitsOf(input).slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');
}

// Digitando "1230" → "12/30". Aceita "1/30" (vira "01/30").
export function maskExpiry(input: string): string {
  let d = digitsOf(input).slice(0, 4);
  if (d.length === 1 && Number(d) > 1) d = `0${d}`;
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

// CPF (até 11 dígitos) ou CNPJ (12 a 14).
export function maskDocument(input: string): string {
  const d = digitsOf(input).slice(0, 14);
  if (d.length <= 11) return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2');
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
}

// Algoritmo de Luhn: pega número de cartão digitado errado antes de enviar.
export function luhnOk(number: string): boolean {
  const d = digitsOf(number);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

// "MM/AA" ainda válido neste mês? Devolve o formato da operadora ("MM/AAAA") ou null.
export function expiryForProvider(input: string, now = new Date()): string | null {
  const match = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(input.trim());
  if (!match) return null;
  const year = 2000 + Number(match[2]);
  const month = Number(match[1]);
  // O cartão vale até o último dia do mês indicado.
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) return null;
  if (year > now.getFullYear() + 25) return null;
  return `${match[1]}/${year}`;
}

export function validCpf(input: string): boolean {
  if (!/^\d{11}$/.test(input) || /^(\d)\1{10}$/.test(input)) return false;
  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(input[i]) * (size + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(input[size])) return false;
  }
  return true;
}

export function validCnpj(input: string): boolean {
  if (!/^\d{14}$/.test(input) || /^(\d)\1{13}$/.test(input)) return false;
  for (const size of [12, 13]) {
    const weights = size === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(input[i]) * weights[i];
    const digit = sum % 11 < 2 ? 0 : 11 - (sum % 11);
    if (digit !== Number(input[size])) return false;
  }
  return true;
}

export const validDocument = (input: string): boolean => {
  const d = digitsOf(input);
  return d.length === 11 ? validCpf(d) : d.length === 14 ? validCnpj(d) : false;
};
