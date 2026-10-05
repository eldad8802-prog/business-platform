"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { usePathname } from "next/navigation";
import { getCurrentEntryId, subscribeTrail } from "@/lib/navigation/back-nav/trail-runtime";

/**
 * useState that belongs to the current HISTORY ENTRY.
 *
 * Use it for the "where was I" state of a list screen — search text, filter,
 * sort, tab, page / visible count. When the user comes back to this entry
 * (in-app back, browser Back/Forward, refresh) the value is restored; a fresh
 * navigation to the screen (a new entry) starts from `initial`, exactly like
 * useState. Values live in sessionStorage (per tab) keyed by
 * entry id + pathname + key, and must be JSON-serializable.
 *
 * It is a useSyncExternalStore over sessionStorage: during a traversal the
 * router renders after `popstate`, so the destination entry's value is read on
 * the very first render (no flash, no double fetch); on a full reload the
 * hydration render uses `initial` (server snapshot) and React re-renders with
 * the stored value right after.
 */
const STORE_KEY = "dz.nav.state.v1";
const MAX_KEYS = 400;

type Bag = Record<string, { v: unknown; t: number }>;

const listeners = new Set<() => void>();
let bagCache: { raw: string | null; bag: Bag } = { raw: null, bag: {} };

function readBag(): Bag {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(STORE_KEY);
  } catch {
    return {};
  }
  if (raw === bagCache.raw) return bagCache.bag;
  let bag: Bag = {};
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null;
    if (data && typeof data === "object" && !Array.isArray(data)) bag = data as Bag;
  } catch {
    bag = {};
  }
  // Keep the identity of unchanged values, so a screen's effects keyed on a
  // stored object do not re-run when an unrelated key is written.
  const prev = bagCache.bag;
  for (const k of Object.keys(bag)) {
    if (k in prev && JSON.stringify(prev[k].v) === JSON.stringify(bag[k].v)) bag[k].v = prev[k].v;
  }
  bagCache = { raw, bag };
  return bag;
}

function writeBag(bag: Bag): void {
  const keys = Object.keys(bag);
  if (keys.length > MAX_KEYS) {
    keys
      .sort((a, b) => bag[a].t - bag[b].t)
      .slice(0, keys.length - MAX_KEYS)
      .forEach((k) => delete bag[k]);
  }
  try {
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(bag));
  } catch {
    /* storage blocked / full — the value just is not remembered */
  }
  for (const l of listeners) l();
}

function slot(pathname: string, key: string): string | null {
  const id = getCurrentEntryId();
  // The entry must currently show this pathname: during a forward push the new
  // screen renders while history still points at the previous entry.
  if (!id || window.location.pathname !== pathname) return null;
  return `${id}|${pathname}|${key}`;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const off = subscribeTrail(cb);
  return () => {
    listeners.delete(cb);
    off();
  };
}

export function useEntryState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const pathname = usePathname() || "/";
  // `local` carries the value while no stored one applies (fresh entry).
  const [local, setLocal] = useState<T>(initial);

  const getSnapshot = useCallback((): T => {
    const s = slot(pathname, key);
    if (!s) return local;
    const bag = readBag();
    return s in bag ? (bag[s].v as T) : local;
  }, [pathname, key, local]);

  const getServerSnapshot = useCallback(() => local, [local]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // The last committed value, for functional updates without re-creating the
  // setter on every change.
  const committed = useRef(value);
  useEffect(() => {
    committed.current = value;
  }, [value]);

  // Stable identity (like React's setState).
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const prev = committed.current;
      const next = typeof action === "function" ? (action as (p: T) => T)(prev) : action;
      committed.current = next;
      setLocal(next);
      const s = slot(pathname, key);
      if (s) writeBag({ ...readBag(), [s]: { v: next, t: Date.now() } });
    },
    [pathname, key],
  );

  return [value, setValue];
}
