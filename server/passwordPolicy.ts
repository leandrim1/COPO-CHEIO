// Regras para escolher uma senha nova. Servem para o painel (mais exigentes: dá acesso a pedidos e dados de clientes) e para as
// contas de clientes. A senha em si nunca é gravada nem registrada: aqui só se decide se ela é aceitável.
import { WEAK_BASES, WEAK_PASSWORDS } from './commonPasswords.js';

export const MIN_CUSTOMER_PASSWORD = 8;
export const MIN_ADMIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;

export type PasswordContext = {
  // 'admin' exige mais caracteres. Padrão: conta de cliente.
  kind?: 'admin' | 'customer';
  // E-mail e nome da pessoa: a senha não pode ser feita com eles.
  email?: string;
  name?: string;
};

// Minúsculas e sem acentos: "Sênha" e "senha" são a mesma coisa para quem tenta adivinhar.
const plain = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

// Sequências de teclado ou de letras/números ("12345678", "87654321", "abcdefgh", "qwertyui").
const RUNS = ['0123456789', '9876543210', 'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba', 'qwertyuiop', 'poiuytrewq', 'asdfghjkl', 'lkjhgfdsa', 'zxcvbnm', 'mnbvcxz'];
// A sequência dá a volta ("1234567890123", "xyzabc"): vale o trecho em qualquer ponto de uma cópia emendada.
function isRun(value: string): boolean {
  if (value.length < 6) return false;
  return RUNS.some((run) => run.repeat(Math.ceil((value.length + run.length) / run.length) + 1).includes(value));
}

// Devolve o motivo (já em português, para mostrar à pessoa) ou null quando a senha pode ser usada.
export function passwordProblem(password: unknown, ctx: PasswordContext = {}): string | null {
  const min = ctx.kind === 'admin' ? MIN_ADMIN_PASSWORD : MIN_CUSTOMER_PASSWORD;
  if (typeof password !== 'string' || Array.from(password).length < min) return `A senha precisa ter pelo menos ${min} caracteres.`;
  if (password.length > MAX_PASSWORD) return 'A senha é longa demais.';
  const lower = plain(password);
  const weak = 'Essa senha é muito comum e fácil de adivinhar. Misture palavras, números e símbolos, ou use uma frase longa.';
  if (WEAK_PASSWORDS.has(lower)) return weak;
  if (/^(.)\1+$/.test(lower) || isRun(lower)) return weak;
  // "brasil2026", "senha@123", "copocheio1": a parte de letras é conhecida e o resto é só número ou símbolo no final.
  const core = lower.replace(/[\d!@#$%&*._\-+=? ]+$/, '');
  if (core.length >= 4 && core.length <= 14 && WEAK_BASES.has(core)) return weak;
  // Só números repetidos em padrão ("11221122", "12121212").
  if (/^\d+$/.test(lower) && new Set(lower).size <= 3) return weak;
  // A senha não pode ser o e-mail (ou o começo dele) com um enfeite curto: "maria.silva2024" para maria.silva@gmail.com. Uma frase
  // longa que apenas cita o nome passa.
  const localPart = plain(ctx.email ?? '').split('@')[0].replace(/[^a-z0-9]/g, '');
  const alnum = lower.replace(/[^a-z0-9]/g, '');
  if (localPart.length >= 4 && alnum.includes(localPart) && alnum.replace(localPart, '').length < 6) return 'A senha não pode ser o seu e-mail com um número no final. Escolha outra.';
  const first = plain(ctx.name ?? '').split(/\s+/)[0]?.replace(/[^a-z]/g, '') ?? '';
  if (first.length >= 5 && lower.replace(/[^a-z]/g, '') === first) return 'A senha não pode ser só o seu nome. Escolha outra.';
  return null;
}
