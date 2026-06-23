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
 */
export function useFetch<T>(
  path: string,
  opts: { onError?: (error: unknown) => void } = {}
): UseFetchResult<T> {
  const { activeGroup } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
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
    reload();
  }, [activeGroup?.id, reload]);

  return { data, loading, error, reload };
}
