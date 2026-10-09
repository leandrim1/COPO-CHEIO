// Endereço de e-mail: formato, normalização e máscara para mostrar na tela.
//
// Normalização (a mesma em todo o sistema, sem mudar o significado do endereço):
//  • tira espaços das pontas e caracteres invisíveis colados por teclados de celular (espaço de largura zero etc.);
//  • o domínio vai para minúsculas e, se tiver acento, para a forma ASCII (punycode), que é como ele circula na internet;
//  • a parte antes do @ vai para minúsculas (é assim que o cadastro já guardava e que todos os provedores tratam).
//  NÃO mexe em pontos nem em "+etiqueta" do Gmail e parecidos: isso mudaria o endereço (são apelidos legítimos).
// Só aceita o formato comum de endereço (sem aspas, comentários, IP no lugar do domínio nem acento antes do @).
import { domainToASCII } from 'node:url';
import { HttpError } from './http.js';

export type ParsedEmail = { email: string; local: string; domain: string };

const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const INVISIBLE = /[​-‍⁠﻿]/g;

const FORMAT = 'Confira o e-mail: ele precisa ter o formato nome@dominio.com (por exemplo, maria@gmail.com).';
const bad = (message: string) => new HttpError(400, message, { code: 'invalid_email' });

export function parseEmail(input: unknown): ParsedEmail {
  if (typeof input !== 'string') throw bad('Informe o e-mail.');
  const text = input.replace(INVISIBLE, '').trim();
  if (!text) throw bad('Informe o e-mail.');
  if (/\s/.test(text)) throw bad('O e-mail não pode ter espaços.');
  if (text.length > 254) throw bad('O e-mail é longo demais.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(text)) throw bad(FORMAT);

  const at = text.indexOf('@');
  if (at < 1 || at !== text.lastIndexOf('@')) throw bad(FORMAT);
  const local = text.slice(0, at);
  const rawDomain = text.slice(at + 1);

  if (local.length > 64) throw bad('A parte do e-mail antes do @ é longa demais.');
  if (!local.split('.').every((atom) => atom.length > 0 && LOCAL_ATOM.test(atom))) {
    throw bad('Confira a parte do e-mail antes do @: use letras sem acento, números e, se precisar, pontos (nunca dois seguidos nem no começo ou no fim).');
  }

  const domain = domainToASCII(rawDomain);
  const labels = domain.split('.');
  if (!domain || domain.length > 253 || labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !TLD.test(labels[labels.length - 1])) {
    throw bad('Confira o domínio do e-mail (a parte depois do @), por exemplo gmail.com ou hotmail.com.');
  }

  return { email: `${local.toLowerCase()}@${domain}`, local: local.toLowerCase(), domain };
}

// Para o login: normaliza igual ao cadastro, mas nunca falha (quem digita errado só recebe "e-mail ou senha incorretos").
export function normalizeLoginEmail(input: unknown): string {
  try {
    return parseEmail(input).email;
  } catch {
    // Sem caracteres de controle (o nulo, por exemplo, o Postgres nem aceita): texto assim não é e-mail de ninguém.
    const raw = typeof input === 'string' ? input.replace(INVISIBLE, '').trim().toLowerCase().slice(0, 254) : '';
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u001F\u007F]/.test(raw) ? '' : raw;
  }
}

// "maria.silva@gmail.com" → "m***@gmail.com" (para mostrar onde o código foi parar sem expor o endereço inteiro).
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
