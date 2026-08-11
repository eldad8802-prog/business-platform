/**
 * Detection Grammar — C1 · Equality Operator (pure).
 *
 * Enforces the operator-OWNED §N commitments and delegates the Domain-owned ones:
 *   • EB1     — exactly two peer relata (missing / malformed → Family A).
 *   • EA3/EB2 — both relata bound to the ONE invoked Domain ID + Version; a mismatch
 *               is a Family-A Equality Contract Failure (ratified R1: this binding
 *               precondition is Equality-owned), never `NOT_EQUAL`.
 *   • EA2     — the equality criterion is the Domain's; the operator never invents it.
 *   • EC1/EC2 — Outcome in {EQUAL, NOT_EQUAL}; terminal disposition = Outcome XOR Failure.
 *   • EE2     — Family A is classified by Equality; Family B is consumed from the Domain.
 *
 * The operator produces neither Evidence nor Belief, never turns a Failure into
 * `NOT_EQUAL`, and never mutates a C0 account (accounts are read-only).
 */
import type { EqualityDomain } from "./equality-domain.interface";
import type {
  Disposition,
  EqualityFailure,
  EqualityProjection,
  OperationSpec,
  Relatum,
} from "./equality.types";
import { EQUALITY_CONTRACT_VERSION } from "./equality.types";
import { operationIdentityDigest } from "./equality-replay";
import { admitFromCot } from "./cot-to-relatum";
import type {
  CanonicalObservation,
  ObservationAccountId,
} from "../../business-brain/observation.types";

const MISSING_REF = "<missing>" as ObservationAccountId;

/** Family A — Equality Contract Failure (Equality-owned; EE1/EE2). */
function familyA(detail: string): EqualityFailure {
  return { kind: "FAILURE", family: "A", classified: true, source: "EQUALITY", detail };
}

function buildProjection(spec: OperationSpec, disposition: Disposition): EqualityProjection {
  return {
    operationSpec: spec,
    operationIdentityDigest: operationIdentityDigest(spec),
    disposition,
    provenance: {
      operatorContractVersion: EQUALITY_CONTRACT_VERSION,
      relatumAccountRefs: spec.orderedRelatumRefs,
    },
  };
}

/**
 * Core operator — assumes both relata were admitted upstream (EB3). Enforces arity
 * and binding (Family A), then delegates the criterion to the bound Domain (EA2).
 */
export function evaluateEquality(
  domain: EqualityDomain,
  relatumA: Relatum | undefined,
  relatumB: Relatum | undefined,
  contractVersion: string = EQUALITY_CONTRACT_VERSION
): EqualityProjection {
  const spec: OperationSpec = {
    contractVersion,
    domainId: domain.domainId,
    domainVersion: domain.domainVersion,
    orderedRelatumRefs: [
      relatumA?.accountRef ?? MISSING_REF,
      relatumB?.accountRef ?? MISSING_REF,
    ],
  };

  // EB1 — exactly two relata present. Equality's own invocation boundary → Family A.
  if (!relatumA || !relatumB) {
    return buildProjection(
      spec,
      familyA("missing relatum: Equality requires exactly two peer relata")
    );
  }

  // EA3 / EB2 — both relata bound to the invoked Domain ID + Version (Family A, R1).
  if (relatumA.domainId !== domain.domainId || relatumB.domainId !== domain.domainId) {
    return buildProjection(
      spec,
      familyA("Domain ID mismatch: relata are not bound to the invoked Domain ID")
    );
  }
  if (
    relatumA.domainVersion !== domain.domainVersion ||
    relatumB.domainVersion !== domain.domainVersion
  ) {
    return buildProjection(
      spec,
      familyA("Domain Version mismatch: relata are not bound to the invoked Domain Version")
    );
  }

  // EA2 — the Domain owns the criterion; the operator only invokes it (EC1/EC2).
  const outcome = domain.criterion(relatumA.value, relatumB.value);
  return buildProjection(spec, { kind: "OUTCOME", outcome });
}

/**
 * Evaluation boundary (EE2 owns Preservation of Outcome XOR Failure) over two C0
 * CanonicalObservation accounts under ONE invoked Domain. Admits both (EB3 upstream),
 * then runs the operator. Inadmissibility → Family B (Domain-supplied).
 */
export function runEqualityFromCots(
  domain: EqualityDomain,
  cotA: CanonicalObservation,
  cotB: CanonicalObservation,
  contractVersion: string = EQUALITY_CONTRACT_VERSION
): EqualityProjection {
  const spec: OperationSpec = {
    contractVersion,
    domainId: domain.domainId,
    domainVersion: domain.domainVersion,
    orderedRelatumRefs: [cotA.observationAccountId, cotB.observationAccountId],
  };
  const a = admitFromCot(domain, cotA);
  if (!a.ok) return buildProjection(spec, a.failure);
  const b = admitFromCot(domain, cotB);
  if (!b.ok) return buildProjection(spec, b.failure);
  return evaluateEquality(domain, a.relatum, b.relatum, contractVersion);
}
