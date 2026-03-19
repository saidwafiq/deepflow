import { useEffect } from 'react';

/**
 * Detects prefers-color-scheme and applies 'dark' class to <html>.
 * Reacts to OS-level changes at runtime.
 */
export function useTheme(): void {
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = (dark: boolean) => {
      root.classList.toggle('dark', dark);
    };

    apply(mq.matches);

    const handler = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
}
