// CSV para Excel/Google Planilhas em português: separador ";", vírgula decimal, UTF-8 com BOM, linhas terminadas em CRLF.
// Proteção contra injeção de fórmulas ("CSV injection"): um texto que a PESSOA digitou (nome, observação, bairro, nome de produto...) começando com = + - @ (ou
// TAB / CR) viraria fórmula ao abrir a planilha. Esses textos ganham um apóstrofo na frente, que a planilha esconde. Números NÃO passam por isso: o que sai como
// número (valores em reais) vai sem apóstrofo, para continuar sendo número.

export type Cell = string | number | boolean | null | undefined | Date;

const FORMULA_START = /^[=+\-@\t\r]/;

// Texto livre → célula segura. Tira caracteres de controle (exceto quebra de linha dentro do texto, que o CSV aceita entre aspas) e neutraliza fórmulas.
export function safeText(value: string): string {
  const clean = value.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  // Também vale para texto que começa depois de espaços/quebras: algumas planilhas os ignoram antes de ler a fórmula.
  return FORMULA_START.test(clean.replace(/^[\s ]+/, '')) || FORMULA_START.test(clean) ? `'${clean}` : clean;
}

const money = (n: number) => n.toFixed(2).replace('.', ',');

export function cell(value: Cell): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'number') text = Number.isFinite(value) ? (Number.isInteger(value) ? String(value) : money(value)) : '';
  else if (typeof value === 'boolean') text = value ? 'sim' : 'não';
  else if (value instanceof Date) text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  else text = safeText(String(value));
  // Aspas quando tem separador, aspas, quebra de linha ou espaço nas pontas (e as aspas de dentro dobram).
  return /[;"\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Valor em reais já arredondado (duas casas, vírgula): sempre número para a planilha, nunca fórmula.
export const reais = (value: number | string | null | undefined): string => {
  const n = Number(value);
  return Number.isFinite(n) ? money(n) : '';
};

export function toCsv(rows: Cell[][]): string {
  return `﻿${rows.map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`;
}
