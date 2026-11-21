import { useSyncExternalStore } from 'react';
import type { User } from './types';

/**
 * In-memory authentication state.
 *
 * The access token is deliberately NOT persisted (no localStorage / sessionStorage)
 * so an XSS payload cannot exfiltrate a long-lived credential. After a reload the
 * session is restored through the HttpOnly refresh cookie.
 */
export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  accessToken: string | null;
}

let state: AuthState = { status: 'loading', user: null, accessToken: null };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const authStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setSession(accessToken: string, user: User) {
    state = { status: 'authenticated', user, accessToken };
    emit();
  },
  setUser(user: User) {
    state = { ...state, user };
    emit();
  },
  clear() {
    state = { status: 'anonymous', user: null, accessToken: null };
    emit();
  },
};

export function useAuthState(): AuthState {
  return useSyncExternalStore(authStore.subscribe, authStore.get, authStore.get);
}
