import { useEffect, useRef } from 'react';

/**
 * Calls `fn` every `intervalMs`. Pauses when the tab is hidden
 * (document.visibilityState === 'hidden') to avoid wasted fetches.
 */
export function usePolling(fn: () => void, intervalMs: number): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (intervalMs <= 0) return;

    let timerId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timerId !== null) return;
      // Fire immediately on start/resume so there's no initial delay.
      fnRef.current();
      timerId = setInterval(() => fnRef.current(), intervalMs);
    };

    const stop = () => {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        start();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);

    if (document.visibilityState !== 'hidden') {
      start();
    }

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}
