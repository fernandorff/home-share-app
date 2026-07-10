"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

export interface UseFetchResult<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  reload: () => Promise<void>;
}

/**
 * GET `path` on mount and whenever the active house changes, returning
 * { data, loading, error, reload }. `reload` is stable (safe to call after mutations).
 * Keyed on the active group so switching houses never shows another house's data; a
 * request counter discards stale responses from rapid switches/reloads. `onError` is read
 * via a ref so it never has to be a dependency (avoids the unstable-callback refetch loop).
 * `enabled` (default true) lets a caller defer the first fetch until it's actually needed
 * (e.g. a tab that isn't the default view) — flipping it to true triggers the fetch.
 */
export function useFetch<T>(
  path: string,
  opts: { onError?: (error: unknown) => void; enabled?: boolean } = {}
): UseFetchResult<T> {
  const { activeGroup } = useSession();
  const { enabled = true } = opts;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<unknown>(null);

  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;
  const reqId = useRef(0);

  const reload = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const res = await api.get<T>(path);
      if (reqId.current === id) {
        setData(res);
        setError(null);
      }
    } catch (e) {
      if (reqId.current === id) {
        setError(e);
        onErrorRef.current?.(e);
      }
    } finally {
      if (reqId.current === id) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (!enabled) return;
    reload();
  }, [activeGroup?.id, reload, enabled]);

  return { data, loading, error, reload };
}
