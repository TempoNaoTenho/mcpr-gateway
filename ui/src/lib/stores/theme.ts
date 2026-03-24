import { writable } from 'svelte/store';
import { browser } from '$app/environment';

type Theme = 'light' | 'dark';

function readStoredTheme(): Theme | null {
  if (!browser) return null;
  const v = localStorage.getItem('theme');
  if (v === 'light' || v === 'dark') return v;
  return null;
}

function createThemeStore() {
  const initial: Theme = browser ? (readStoredTheme() ?? 'dark') : 'dark';

  const { subscribe, set } = writable<Theme>(initial);

  function apply(theme: Theme) {
    if (!browser) return;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
  }

  if (browser) apply(initial);

  return {
    subscribe,
    toggle() {
      let current: Theme | undefined;
      const unsub = subscribe((v) => (current = v));
      unsub();
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      set(next);
      apply(next);
    },
    set(theme: Theme) {
      set(theme);
      apply(theme);
    },
  };
}

export const theme = createThemeStore();
