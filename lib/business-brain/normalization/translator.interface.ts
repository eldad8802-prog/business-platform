/**
 * Father Engine — C0 / PR3. Translator contract.
 *
 * A Translator maps a raw source record to one or more pre-seal, pre-validation
 * Projections. It emits a Business Concept (conceptId), NEVER feature vocabulary.
 * In PR3 it reads fixtures only — no DB, no Source of Truth.
 *
 * Authority split: the Translator proposes the semantic identity (conceptId, and
 * a requestedConceptVersion only when a versioned source is explicitly pinned).
 * normalize() OWNS effective-version selection against the pinned snapshot.
 *
 * causeRef is an ORIGINATING-ACTION CORRELATION reference, NOT a causal claim — it
 * links sibling projections born from the same source action (see documents-fixture-translator).
 */

import type {
  ConceptId,
  ConceptVersion,
  ReferentSubtype,
  TranslatorContractDigest,
  TranslatorName,
  TranslatorVersionTag,
} from "../versioning.types";
import type {
  Authentication,
  CauseRef,
  Completeness,
  ConfidenceBasis,
  EventTime,
  FieldProvenance,
  IdentityBinding,
  InferenceSubstrate,
  Mode,
  ObservationTime,
  ProcessInstanceRef,
  RealityTier,
  ReferentType,
  Tenant,
  Value,
} from "../observation.types";
import type { RawRecordRef } from "./normalization-result.types";

export interface RawInput {
  ref: RawRecordRef;
  tenant: Tenant;
  /** Opaque raw payload — the engine never interprets it except via the Translator. */
  payload: unknown;
  /** When WE sensed it (ingest) — drives LIVE concept-version selection. */
  observationTime: ObservationTime;
  /** Present iff an inference engine produced this input (carries runId). */
  inference?: InferenceSubstrate;
}

export interface ReferentDraft {
  referentType: ReferentType;
  referentSubtype?: ReferentSubtype;
  identity: IdentityBinding;
}

export interface ProvenanceDraft {
  realityTier: RealityTier;
  authentication: Authentication;
  channel: string;
  inference?: InferenceSubstrate;
  fieldProvenance?: FieldProvenance[];
}

export interface TranslatorProjection {
  /** Fan-out discriminator, 0-based, unique within one raw record's emission. */
  emittedObservationIndex: number;
  conceptId: ConceptId;
  /** Only when a versioned source is explicitly bound to a version. */
  requestedConceptVersion?: ConceptVersion;
  referentDraft: ReferentDraft;
  value: Value;
  mode: Mode;
  eventTime: EventTime;
  provenanceDraft: ProvenanceDraft;
  completeness: Completeness;
  confidenceBasis?: ConfidenceBasis;
  causeRef?: CauseRef;
  processInstanceRef?: ProcessInstanceRef;
  /** Which sensor produced this — the coverage-registry key component. */
  sourceSensor: string;
}

export interface Translator {
  readonly name: TranslatorName;
  readonly version: TranslatorVersionTag;
  /** Content-derived fingerprint of this translator's declared contract. A change
   *  in behaviour/meaning MUST bump the version; the digest catches declared drift. */
  readonly contractDigest: TranslatorContractDigest;
  translate(input: RawInput): readonly TranslatorProjection[];
}
