import { writable } from 'svelte/store';
import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { authMe, login as apiLogin, logout as apiLogout } from './api.js';

interface AuthState {
  authenticated: boolean;
  loading: boolean;
}

function createAuthStore() {
  const { subscribe, set, update } = writable<AuthState>({
    authenticated: false,
    loading: true,
  });

  return {
    subscribe,

    async check() {
      try {
        const res = await authMe();
        set({ authenticated: res.authenticated, loading: false });
        return res.authenticated;
      } catch {
        set({ authenticated: false, loading: false });
        return false;
      }
    },

    async login(token: string) {
      await apiLogin(token);
      set({ authenticated: true, loading: false });
    },

    async logout() {
      try {
        await apiLogout();
      } catch {
        // ignore errors on logout
      }
      set({ authenticated: false, loading: false });
      goto(`${base}/login`);
    },
  };
}

export const auth = createAuthStore();
