"use client";

import { useState } from "react";

/**
 * Per-viewer DISPLAY preferences of the Home (which metrics are main, which For-you types to show, what was put
 * off). Kept in this browser only, per business — a convenience, never business state: losing it returns the
 * business defaults, and nothing here ever changes what the server holds or enforces. (A synced preference store
 * would need a schema change, which this package deliberately does not make.)
 */
function storageKey(businessId: number | null, name: string): string | null {
  return businessId === null ? null : `dz.home4.${businessId}.${name}`;
}

function read<T>(key: string | null, fallback: T): T {
  if (!key) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function useHomePref<T>(businessId: number | null, name: string, fallback: T): [T, (next: T) => void] {
  const key = storageKey(businessId, name);
  // Re-read when the key changes (the business becomes known): React's "adjust state while rendering" pattern —
  // no effect, no extra paint with the stale value. Storage is read only once a key exists, i.e. on the client.
  const [state, setState] = useState<{ key: string | null; value: T }>({ key: null, value: fallback });
  let current = state;
  if (state.key !== key) {
    current = { key, value: read(key, fallback) };
    setState(current);
  }

  const update = (next: T) => {
    setState({ key, value: next });
    if (!key) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* private mode / blocked storage: the choice holds for this visit only */
    }
  };

  return [current.value, update];
}
