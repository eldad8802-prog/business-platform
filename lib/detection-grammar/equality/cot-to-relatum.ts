/**
 * Detection Grammar — Equality · C0 → relatum adapter.
 *
 * Maps a C0 CanonicalObservation account into an Equality relatum by presenting its
 * canonical datum to the Domain's admission (EB3 — admissibility is an upstream
 * precondition that is Domain-owned; the operator merely consumes the guarantee).
 * The adapter adds NO equality or domain semantics: the Domain decides membership
 * and the canonical value. The relatum's positional reference is the account's own
 * stable identity (ED1); the account is read-only and never mutated.
 */
import type { EqualityDomain } from "./equality-domain.interface";
import type { EqualityFailure, Relatum } from "./equality.types";
import type { CanonicalObservation } from "../../business-brain/observation.types";

export type AdmitFromCotResult =
  | { readonly ok: true; readonly relatum: Relatum }
  | { readonly ok: false; readonly failure: EqualityFailure };

export function admitFromCot(
  domain: EqualityDomain,
  cot: CanonicalObservation
): AdmitFromCotResult {
  // EB3 — the Domain admits or rejects; Equality never establishes membership itself.
  const admission = domain.admit(cot.value.datum);
  if (!admission.admissible) {
    // EE2 — a Family-B classification is consumed from the Domain (the authoritative
    // source), never invented by Equality.
    const failure: EqualityFailure = {
      kind: "FAILURE",
      family: "B",
      classified: true,
      source: "DOMAIN",
      detail: admission.detail,
    };
    return { ok: false, failure };
  }
  const relatum: Relatum = {
    domainId: domain.domainId,
    domainVersion: domain.domainVersion,
    value: admission.value,
    accountRef: cot.observationAccountId,
  };
  return { ok: true, relatum };
}
