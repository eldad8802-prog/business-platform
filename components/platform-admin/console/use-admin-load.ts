"use client";

/**
 * One load per request key, without setting state synchronously in an effect.
 *
 * The result remembers the key it was produced for; "loading" is simply "the
 * stored result belongs to another key". A new key (new page, new filter, a
 * reload) therefore shows as loading on the very render it changes, and a slow
 * stale response can never overwrite a newer one.
 */
import { useCallback, useEffect, useState } from "react";

type Stored<T> = { key: string; data: T | null; error: unknown };

export type AdminLoad<T> = {
  data: T | null;
  /** The last successful data, kept while a newer request is in flight. */
  previous: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
};

export function useAdminLoad<T>(key: string, fn: () => Promise<T>, enabled = true): AdminLoad<T> {
  const [nonce, setNonce] = useState(0);
  const [stored, setStored] = useState<Stored<T> | null>(null);
  const [lastGood, setLastGood] = useState<T | null>(null);
  const fullKey = `${key}#${nonce}`;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fn().then(
      (data) => {
        if (cancelled) return;
        setStored({ key: fullKey, data, error: null });
        setLastGood(data);
      },
      (error) => {
        if (!cancelled) setStored({ key: fullKey, data: null, error });
      }
    );
    return () => {
      cancelled = true;
    };
    // `fn` closes over the values that make up `key`; the key is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullKey, enabled]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const current = stored?.key === fullKey ? stored : null;

  return {
    data: current?.data ?? null,
    previous: lastGood,
    error: current?.error ?? null,
    loading: enabled && current === null,
    reload,
  };
}
