/**
 * Navigation trail — the pure model behind every in-app back control.
 *
 * Every browser history entry the app creates is stamped with an id (carried in
 * `history.state`, see trail-runtime.ts) and recorded here with the URL it shows
 * and the id of the entry it was pushed FROM. Because the browser stack below
 * the current entry never changes while we stand on it, walking `prev` links
 * from the current entry reproduces the real stack exactly — so "back" can be
 * a precise `history.go(-n)` to the screen the user actually came from, with
 * its state and scroll, instead of a guess based on `history.length`.
 *
 * Rules for the target (resolveBackTarget):
 *  - walk prev links only through entries we recorded ourselves; an unknown or
 *    missing link ends the walk (no blind steps);
 *  - stop at an entry recorded under a different session scope (other user /
 *    signed-out) — back never crosses into another account's screens;
 *  - skip entries showing the SAME screen as the current one (same screen key:
 *    the pathname plus any identity params the route registry declares — e.g.
 *    a filter change that pushed, or the detail page re-pushed after an edit)
 *    — back always leaves the current screen;
 *  - skip transient / technical screens (login, redirects, completed flow
 *    steps registered as transient);
 *  - never more than MAX_WALK steps.
 * When nothing qualifies the caller uses the screen's declared fallback.
 */

import { isTechnicalPath, pathnameOf, toSafeInternalPath } from "./safe-path";

export type TrailEntry = {
  id: string;
  /** "/path?query" shown by this history entry (kept current on replaceState). */
  url: string;
  /** Id of the entry this one was pushed from; null = first entry we know. */
  prev: string | null;
  /** Session scope (user) the entry was recorded under; null = signed out. */
  scope: string | null;
  /** Last-touched time (ms) — used for pruning only. */
  t: number;
};

export type TrailStore = Record<string, TrailEntry>;

export type BackTarget =
  | { kind: "history"; delta: number; url: string }
  | { kind: "none" };

export const MAX_WALK = 50;
export const MAX_ENTRIES = 300;

export type ResolveOptions = {
  store: TrailStore;
  currentId: string | null;
  scope: string | null;
  /** Extra per-path skip rule (route registry `transient`). */
  isTransient?: (pathname: string) => boolean;
  /** Screen identity of a URL (default: its pathname). */
  screenKey?: (url: string) => string;
};

export function resolveBackTarget({
  store,
  currentId,
  scope,
  isTransient,
  screenKey = pathnameOf,
}: ResolveOptions): BackTarget {
  if (!currentId) return { kind: "none" };
  const current = store[currentId];
  if (!current) return { kind: "none" };
  if (scope === null || current.scope !== scope) return { kind: "none" };

  const currentKey = screenKey(current.url);
  const seen = new Set<string>([current.id]);
  let steps = 0;
  let cursor = current.prev;

  while (cursor && steps < MAX_WALK) {
    if (seen.has(cursor)) break; // corrupted chain — never loop
    seen.add(cursor);
    const entry = store[cursor];
    if (!entry) break; // unknown link — cannot verify what is there
    steps += 1;
    if (entry.scope !== scope) break; // other account / signed out boundary

    const path = pathnameOf(entry.url);
    const safe = toSafeInternalPath(entry.url);
    const skippable =
      !safe ||
      screenKey(entry.url) === currentKey ||
      isTechnicalPath(path) ||
      (isTransient?.(path) ?? false);
    if (!skippable && safe) {
      return { kind: "history", delta: -steps, url: safe };
    }
    cursor = entry.prev;
  }
  return { kind: "none" };
}

/** Drops the oldest entries beyond MAX_ENTRIES (never the protected ids). */
export function pruneStore(store: TrailStore, protect: Iterable<string> = []): TrailStore {
  const ids = Object.keys(store);
  if (ids.length <= MAX_ENTRIES) return store;
  const keep = new Set(protect);
  const sorted = ids
    .filter((id) => !keep.has(id))
    .sort((a, b) => store[a].t - store[b].t);
  const drop = new Set(sorted.slice(0, ids.length - MAX_ENTRIES));
  const next: TrailStore = {};
  for (const id of ids) if (!drop.has(id)) next[id] = store[id];
  return next;
}

/** Defensive parse of a persisted store (sessionStorage is user-writable). */
export function parseStore(raw: string | null): TrailStore {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: TrailStore = {};
    for (const [id, value] of Object.entries(data as Record<string, unknown>)) {
      const v = value as Partial<TrailEntry> | null;
      if (
        v &&
        typeof v === "object" &&
        v.id === id &&
        typeof v.url === "string" &&
        (v.prev === null || typeof v.prev === "string") &&
        (v.scope === null || typeof v.scope === "string") &&
        typeof v.t === "number"
      ) {
        out[id] = { id, url: v.url, prev: v.prev, scope: v.scope, t: v.t };
      }
    }
    return out;
  } catch {
    return {};
  }
}
