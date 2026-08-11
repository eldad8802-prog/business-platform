/**
 * Detection Grammar — Equality · the Domain contract the operator DEPENDS ON.
 *
 * EA2 — the equality criterion is supplied by the authorized Domain; Equality does
 * not invent, infer, broaden, or relax it. EB3 — the Domain owns admissibility /
 * membership. EB4 — the Domain owns parsing / normalization / canonicalization. The
 * operator sees only admissible Domain values and delegates the criterion here; it
 * defines no criterion, no canonicalization, and no membership of its own.
 */
import type { AdmittedValue, EqualityOutcome } from "./equality.types";

/** EB3 — a Domain-owned admission result. On failure the Domain supplies the
 *  detail; the caller maps this to a Family-B classification (EE2 — never invented
 *  by Equality). */
export type AdmissionResult =
  | { readonly admissible: true; readonly value: AdmittedValue }
  | { readonly admissible: false; readonly detail: string };

export interface EqualityDomain {
  /** EA3 — explicit Domain ID. */
  readonly domainId: string;
  /** EA3 / ED4 — explicit Domain Version (the Domain-owned semantics authority). */
  readonly domainVersion: string;
  /** EB3 + EB4 — admit and canonicalize a raw datum into a Domain value witness. */
  admit(rawDatum: unknown): AdmissionResult;
  /** EA2 — the Domain-owned equality criterion over two admitted values. It must
   *  mean identity of the same abstract value (never similarity / tolerance /
   *  approximation / business substitutability). */
  criterion(a: AdmittedValue, b: AdmittedValue): EqualityOutcome;
}
