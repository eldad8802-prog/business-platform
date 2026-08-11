/**
 * Fixture Domain — normalized integer (PROOF ONLY).
 *
 * Demonstrates value-equality != representation identity: "1" and "01" denote the
 * SAME abstract integer value, with no similarity / tolerance / approximation. The
 * Domain OWNS parsing + admission (EB3), normalization / canonicalization (EB4), and
 * the equality criterion (EA2). This is NOT a production registry: it is explicit,
 * versioned, deterministic, replayable, and fixture-only. No new Primitive, Registry,
 * or Engine is authorized (EB4).
 */
import type { AdmissionResult, EqualityDomain } from "../equality-domain.interface";
import type { AdmittedValue, EqualityOutcome } from "../equality.types";

/**
 * Canonical integer normalization (Domain-owned; EB4). Strips leading zeros and a
 * leading `+`, and normalizes `-0` to `0`. Returns null for a non-integer, which the
 * Domain then rejects as inadmissible (EB3) — it never coerces or approximates.
 */
function normalizeInteger(raw: unknown): string | null {
  let s: string;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) return null;
    s = String(raw);
  } else if (typeof raw === "string") {
    s = raw.trim();
  } else {
    return null;
  }
  if (!/^[+-]?\d+$/.test(s)) return null;
  const negative = s.startsWith("-");
  const digits = s.replace(/^[+-]/, "").replace(/^0+(?=\d)/, ""); // strip leading zeros, keep one
  if (digits === "0") return "0";
  return negative ? "-" + digits : digits;
}

/** Build a fixture normalized-integer Equality Domain. */
export function makeIntegerDomain(
  domainId: string = "fixture:normalized-integer",
  domainVersion: string = "v1"
): EqualityDomain {
  return {
    domainId,
    domainVersion,
    admit(rawDatum: unknown): AdmissionResult {
      const canonical = normalizeInteger(rawDatum);
      if (canonical === null) {
        return {
          admissible: false,
          detail: `not a member of ${domainId}@${domainVersion}: ${JSON.stringify(rawDatum)}`,
        };
      }
      return { admissible: true, value: { witness: canonical } };
    },
    // EA2 — identity of the same abstract integer value; nothing weaker.
    criterion(a: AdmittedValue, b: AdmittedValue): EqualityOutcome {
      return a.witness === b.witness ? "EQUAL" : "NOT_EQUAL";
    },
  };
}
