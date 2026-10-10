import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../lib/api';
import type { CustomerAccount } from '../lib/types';

// Conta do cliente (opcional). O estado vem do servidor (/api/account/me, cookie HttpOnly); nada de
// credencial fica no navegador. A consulta só acontece quando uma página que precisa dela é aberta.

type State = { status: 'idle' | 'loading' | 'in' | 'out' | 'error'; customer: CustomerAccount | null };

let state: State = { status: 'idle', customer: null };
const listeners = new Set<() => void>();
const set = (next: State) => {
  state = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

let inflight: Promise<void> | null = null;

export function loadCustomer(force = false): Promise<void> {
  if (!force && (state.status === 'in' || state.status === 'out')) return Promise.resolve();
  if (inflight) return inflight;
  if (state.status !== 'in') set({ status: 'loading', customer: state.customer });
  inflight = api
    .get<{ customer: CustomerAccount | null }>('/api/account/me')
    .then(({ customer }) => set(customer ? { status: 'in', customer } : { status: 'out', customer: null }))
    .catch(() => set({ status: state.customer ? 'in' : 'error', customer: state.customer }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export const setCustomer = (customer: CustomerAccount | null) => set(customer ? { status: 'in', customer } : { status: 'out', customer: null });

export async function logoutCustomer(): Promise<void> {
  await api.post('/api/account/logout').catch(() => undefined);
  setCustomer(null);
}

export function useCustomer(): State & { reload: () => Promise<void> } {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    void loadCustomer();
  }, []);
  return { ...snapshot, reload: () => loadCustomer(true) };
}

// Para onde voltar depois do login: só caminhos do próprio site (nada de redirecionar para fora).
export function safeReturn(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  return /^\/(pedido|acompanhar-pedido|conta|checkout|bebidas)(\/|$|\?)/.test(value) ? value : null;
}

// E-mail que acabou de ser confirmado (pelo link): preenche o campo de login. Só na memória desta aba.
let loginPrefill = '';
export const setLoginPrefill = (email: string) => {
  loginPrefill = email;
};
export const getLoginPrefill = (): string => loginPrefill;

// E-mail digitado na tela de entrada, levado para "Esqueci minha senha" (só na memória desta aba).
let recoverPrefill = '';
export const setRecoverPrefill = (email: string) => {
  recoverPrefill = email;
};
export const getRecoverPrefill = (): string => recoverPrefill;
