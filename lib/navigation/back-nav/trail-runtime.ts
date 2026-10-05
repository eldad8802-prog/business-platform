"use client";

/**
 * Navigation trail — browser runtime (singleton, installed once from
 * <NavTrailInit/> in the root layout).
 *
 * Responsibilities:
 *  1. Identity per history entry. `history.pushState` / `replaceState` are
 *     wrapped so EVERY entry (Next.js router pushes included) carries
 *     `__dzNav: <id>` in its state, and the entry is recorded in the trail
 *     store with its URL and the id it was pushed from. The wrapper composes
 *     with Next's own patch in either install order: Next only copies its own
 *     keys and our key rides along. replaceState keeps the current id, so
 *     Next's internal replaces (which reset custom state) never lose it.
 *  2. Persistence in sessionStorage (per tab; survives refresh because
 *     `history.state` survives refresh too). A new tab starts with a fresh
 *     history and therefore no chain — the back control then uses its
 *     labelled fallback rather than pretending.
 *  3. Scroll memory per entry and restoration on traversal (browser Back /
 *     Forward, in-app back, refresh) once the content is tall enough.
 *  4. A short re-entrancy lock so repeated / rapid back activations can only
 *     ever move ONE screen.
 */

import {
  parseStore,
  pruneStore,
  resolveBackTarget,
  type BackTarget,
  type TrailStore,
} from "./trail-core";
import { isTransientPath, screenKeyOf } from "./route-registry";

const STORE_KEY = "dz.nav.trail.v1";
const SCROLL_KEY = "dz.nav.scroll.v1";
const STATE_FIELD = "__dzNav";
const LOCK_MS = 1500;
const RESTORE_WINDOW_MS = 6000;

type HistoryFn = (data: unknown, unused: string, url?: string | URL | null) => void;

let installed = false;
let store: TrailStore = {};
let scrolls: Record<string, number> = {};
let currentId: string | null = null;
let version = 0;
let lockedUntil = 0;
let restoringId: string | null = null;
const listeners = new Set<() => void>();

/* ------------------------------------------------------------- helpers -- */

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* storage full / blocked — the trail degrades to fallbacks */
  }
}

function urlToAppPath(url: string | URL | null | undefined): string {
  try {
    const u = new URL(url == null ? window.location.href : String(url), window.location.href);
    return `${u.pathname}${u.search}`;
  } catch {
    return `${window.location.pathname}${window.location.search}`;
  }
}

/**
 * Session scope = the signed-in user id from the bearer token payload (the
 * token is `v.<payloadB64url>.<sig>`). Not a security boundary by itself — the
 * server authorizes every screen — but it keeps back from walking into screens
 * recorded under another account in the same tab.
 */
export function readScope(): string | null {
  let token: string | null = null;
  try {
    token = window.localStorage.getItem("token");
  } catch {
    return null;
  }
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length === 3) {
    try {
      const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
      const sub = (JSON.parse(json) as { sub?: unknown }).sub;
      if (typeof sub === "number" || typeof sub === "string") return `u:${sub}`;
    } catch {
      /* fall through */
    }
  }
  return "opaque";
}

function stateId(state: unknown): string | null {
  const id = (state as Record<string, unknown> | null)?.[STATE_FIELD];
  return typeof id === "string" ? id : null;
}

function withId(data: unknown, id: string): Record<string, unknown> {
  const base = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  // Mutate in place when possible: Next passes its own object and copies its
  // internal keys onto `data` — keeping the same object keeps both sets.
  if (data && typeof data === "object") {
    base[STATE_FIELD] = id;
    return base;
  }
  return { [STATE_FIELD]: id };
}

function persist(): void {
  store = pruneStore(store, currentId ? [currentId] : []);
  writeSession(STORE_KEY, JSON.stringify(store));
}

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

function releaseLock(): void {
  lockedUntil = 0;
}

/* ------------------------------------------------------------- entries -- */

function recordNew(url: string, prev: string | null): string {
  const id = newId();
  store[id] = { id, url, prev, scope: readScope(), t: Date.now() };
  return id;
}

function touchCurrent(url: string): void {
  if (!currentId) return;
  const e = store[currentId];
  if (e) {
    e.url = url;
    e.t = Date.now();
    // An entry recorded while signed out adopts the scope of a sign-in that
    // happens on it (e.g. /register replaced to /app). An entry never moves
    // from one account to another.
    if (e.scope === null) e.scope = readScope();
  }
}

/* -------------------------------------------------------------- scroll -- */

function saveScroll(): void {
  if (!currentId || restoringId === currentId) return;
  scrolls[currentId] = Math.max(0, Math.round(window.scrollY));
  writeSession(SCROLL_KEY, JSON.stringify(scrolls));
}

let scrollRaf = 0;
function onScroll(): void {
  if (scrollRaf) return;
  scrollRaf = window.requestAnimationFrame(() => {
    scrollRaf = 0;
    saveScroll();
  });
}

function restoreScrollFor(id: string): void {
  const target = scrolls[id];
  if (!target || target <= 0) {
    // Saved at the top (or never scrolled): the previous screen's offset must
    // not leak into this one under manual restoration.
    restoringId = null;
    window.scrollTo(0, 0);
    return;
  }
  restoringId = id;
  const started = performance.now();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  for (const ev of events) window.addEventListener(ev, cancel, { once: true, passive: true });
  const cleanup = () => {
    for (const ev of events) window.removeEventListener(ev, cancel);
    if (restoringId === id) restoringId = null;
  };
  const tick = () => {
    if (cancelled || currentId !== id) return cleanup();
    const el = document.scrollingElement ?? document.documentElement;
    const max = el.scrollHeight - window.innerHeight;
    if (max >= target - 2) {
      window.scrollTo(0, target);
      // Re-assert once after layout settles (late images / fonts).
      window.requestAnimationFrame(() => {
        if (!cancelled && currentId === id && Math.abs(window.scrollY - target) > 2) {
          window.scrollTo(0, target);
        }
        cleanup();
      });
      return;
    }
    if (performance.now() - started > RESTORE_WINDOW_MS) {
      window.scrollTo(0, Math.max(0, max));
      return cleanup();
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

/* ------------------------------------------------------------- install -- */

export function installNavTrail(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  store = parseStore(readSession(STORE_KEY));
  try {
    const raw = JSON.parse(readSession(SCROLL_KEY) ?? "{}") as unknown;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) scrolls[k] = v;
      }
    }
  } catch {
    scrolls = {};
  }
  try {
    // We restore scroll ourselves (after async content renders) for every
    // traversal, so the browser's early, content-less attempt is disabled.
    window.history.scrollRestoration = "manual";
  } catch {
    /* unsupported — harmless */
  }

  const origPush = window.history.pushState.bind(window.history) as HistoryFn;
  const origReplace = window.history.replaceState.bind(window.history) as HistoryFn;

  // Current entry: refresh / bfcache keeps history.state → same id & chain.
  const existing = stateId(window.history.state);
  const here = urlToAppPath(null);
  if (existing && store[existing]) {
    currentId = existing;
    touchCurrent(here);
  } else {
    // Fresh document (direct link, new tab, typed URL) or an entry we lost:
    // a new root of the trail. No guessing at what came before.
    currentId = existing ?? recordNew(here, null);
    if (existing) store[existing] = { id: existing, url: here, prev: null, scope: readScope(), t: Date.now() };
    // Only stamp when Next has already initialised the entry: a state without
    // Next's `__NA` would make Next hard-reload on popstate.
    const st = window.history.state as Record<string, unknown> | null;
    if (!existing && st && st.__NA) origReplace(withId({ ...st }, currentId), "");
  }
  persist();

  window.history.pushState = function pushState(data: unknown, unused: string, url?: string | URL | null) {
    // No scroll save here: pushState runs inside React's commit, after the DOM
    // swap, so scrollY may already be clamped by the new (shorter) screen. The
    // throttled scroll listener has recorded the real position.
    const nextUrl = urlToAppPath(url);
    const id = recordNew(nextUrl, currentId);
    origPush(withId(data, id), unused, url);
    currentId = id;
    releaseLock();
    persist();
    emit();
  } as History["pushState"];

  window.history.replaceState = function replaceState(data: unknown, unused: string, url?: string | URL | null) {
    const id = currentId ?? recordNew(urlToAppPath(url), null);
    const before = store[id]?.url;
    origReplace(withId(data, id), unused, url);
    currentId = id;
    const after = urlToAppPath(url);
    touchCurrent(after);
    if (before !== after) releaseLock();
    persist();
    emit();
  } as History["replaceState"];

  window.addEventListener("popstate", (event) => {
    const id = stateId(event.state);
    if (id && store[id]) {
      currentId = id;
      touchCurrent(urlToAppPath(null));
    } else if (id) {
      store[id] = { id, url: urlToAppPath(null), prev: null, scope: readScope(), t: Date.now() };
      currentId = id;
    } else {
      // An entry we never stamped (e.g. a #hash jump): unknown chain.
      currentId = null;
    }
    releaseLock();
    persist();
    emit();
    if (currentId) restoreScrollFor(currentId);
  });

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("pagehide", saveScroll);

  // Refresh: restore this entry's own scroll once content is back.
  if (currentId && existing) restoreScrollFor(currentId);
  emit();
}

/* --------------------------------------------------------------- query -- */

export function subscribeTrail(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getTrailVersion(): number {
  return version;
}

export function getCurrentEntryId(): string | null {
  if (!installed) return stateId(typeof window === "undefined" ? null : window.history.state);
  return currentId;
}

export function getBackTarget(): BackTarget {
  if (!installed) return { kind: "none" };
  return resolveBackTarget({
    store,
    currentId,
    scope: readScope(),
    isTransient: isTransientPath,
    screenKey: screenKeyOf,
  });
}

/**
 * Acquire the back-navigation lock. Returns false while a previous back is
 * still in flight, so double / rapid activations move exactly one screen.
 * Released as soon as the history entry changes, or after LOCK_MS.
 */
export function acquireBackLock(): boolean {
  const now = Date.now();
  if (now < lockedUntil) return false;
  lockedUntil = now + LOCK_MS;
  return true;
}

export { releaseLock as releaseBackLock };
