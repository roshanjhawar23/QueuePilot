import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
}

/**
 * Calls `load` now and then every `intervalMs` while `enabled`.
 * Polling pauses while the browser tab is hidden, which keeps API requests (and cost) down.
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number, enabled = true, deps: unknown[] = []): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await loadRef.current();
      setData(result);
      setError(null);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh();
    if (!enabled) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, refresh, ...deps]);

  return { data, error, loading, lastUpdated, refresh };
}
