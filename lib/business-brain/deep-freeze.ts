/**
 * Father Engine — C0 (Canonical Observation Model).
 *
 * deepFreeze — recursively freezes the data structure IN PLACE (no clone, object
 * identity preserved). Only plain data structures (plain objects and arrays) are
 * frozen; Date instances and primitives are left as-is (primitives cannot be
 * frozen; a Date is a leaf value, not a mutable structure we traverse). A WeakSet
 * guards against cycles so a self-referential graph cannot stack-overflow.
 *
 * This backs the Immutability invariant of a sealed CanonicalObservation: after
 * sealObservation(), no nested field (value.datum, provenance.channel, …) can be
 * mutated, so the in-memory record can never drift from its canonicalHash.
 */

export function deepFreeze<T>(value: T): T {
  freezeRec(value, new WeakSet<object>());
  return value;
}

function freezeRec(value: unknown, seen: WeakSet<object>): void {
  // Primitives (string/number/boolean/null/undefined/symbol/bigint) — nothing to freeze.
  if (value === null || typeof value !== "object") return;
  // Date is a leaf structure — do not freeze, do not traverse.
  if (value instanceof Date) return;

  const obj = value as object;
  if (seen.has(obj)) return; // cycle guard
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (const el of obj) freezeRec(el, seen);
  } else {
    const rec = obj as Record<string, unknown>;
    for (const key of Object.keys(rec)) freezeRec(rec[key], seen);
  }

  Object.freeze(obj);
}
