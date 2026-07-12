/**
 * Father Engine — C0 (Canonical Observation Model).
 *
 * Deterministic canonicalization + hashing. This is the substrate on which the
 * whole identity contract rests (see observation-identity.ts):
 *
 *   • Object keys are sorted recursively → insertion order never affects output.
 *   • `undefined` properties are stripped → `{a:1}` ≡ `{a:1, b:undefined}`.
 *   • Dates → ISO strings; non-finite numbers are rejected (not silently NaN'd).
 *   • Arrays preserve order (order IS content for sequences).
 *
 * Guarantee: two structurally-equal values produce byte-identical output and the
 * same hash, on any machine, regardless of how the object was built. This is what
 * makes ObservationAccountId content-derived and Replay identity-reproducible.
 */

import { createHash } from "crypto";
import { BrainError } from "./brain-error";

/** Recursively reduce a value to its canonical, order-independent JSON string. */
export function canonicalize(value: unknown): string {
  // `seen` is a PATH tracker (added on enter, removed on exit), used only to
  // detect true cycles (a back-edge to an ancestor). It is never part of the
  // output — acyclic content always produces the identical string/hash, and a
  // value shared across sibling positions (an acyclic DAG) serializes fine.
  const canonical = toCanonical(value, new WeakSet());
  return JSON.stringify(canonical ?? null);
}

/** sha256 hex of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Content hash of an arbitrary value, in the repo's "sha256:" convention.
 * Deterministic: same content → same hash.
 */
export function contentHash(value: unknown): string {
  return "sha256:" + sha256Hex(canonicalize(value));
}

function toCanonical(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();

  const t = typeof value;

  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new BrainError(
        "NON_FINITE_NUMBER",
        "Non-finite number cannot appear in canonical content",
        { value }
      );
    }
    return value;
  }

  if (t === "string" || t === "boolean") return value;

  // Stripped by the parent object; a bare undefined canonicalizes to null.
  if (t === "undefined") return undefined;

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new BrainError("UNSERIALIZABLE", "Cyclic reference in canonical content");
    }
    seen.add(value);
    // Order is content — never sort arrays. Undefined elements → null to keep index.
    const out = value.map((v) => {
      const c = toCanonical(v, seen);
      return c === undefined ? null : c;
    });
    seen.delete(value); // path-based: allow the same value in a sibling (acyclic) slot
    return out;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) {
      throw new BrainError("UNSERIALIZABLE", "Cyclic reference in canonical content");
    }
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const cv = toCanonical(obj[key], seen);
      if (cv !== undefined) out[key] = cv; // strip undefined properties
    }
    seen.delete(obj);
    return out;
  }

  throw new BrainError("UNSERIALIZABLE", `Cannot canonicalize value of type "${t}"`, {
    value,
  });
}
