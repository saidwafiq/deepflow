import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'theme';

function getInitialDark(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark') return true;
    if (stored === 'light') return false;
  } catch {
    // localStorage may be unavailable
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Manages dark/light theme.
 *
 * - On init: checks localStorage('theme') first; falls back to prefers-color-scheme.
 * - Toggle: writes 'dark'/'light' to localStorage and toggles .dark on <html>.
 * - Listens for OS preference changes only when no localStorage override is set.
 *
 * Returns { isDark, toggleTheme }.
 * The hook is also usable with no return value (backward-compatible void usage).
 */
export function useTheme(): { isDark: boolean; toggleTheme: () => void } {
  const [isDark, setIsDark] = useState<boolean>(getInitialDark);

  // Apply class to <html> whenever isDark changes
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  // Listen for OS preference changes only when no manual override is stored
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    const handler = (e: MediaQueryListEvent) => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === 'dark' || stored === 'light') return; // user has overridden
      } catch {
        // ignore
      }
      setIsDark(e.matches);
    };

    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return { isDark, toggleTheme };
}
