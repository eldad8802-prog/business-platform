/**
 * Father Engine — C0 / PR3. Fixture Translator — TEST ONLY.
 *
 * Deterministically maps a scenario payload to Projections. It emits Business
 * Concepts (conceptId), assigns emittedObservationIndex, carries OCR/LLM runId via
 * provenance, and derives causeRef as an ORIGINATING-ACTION CORRELATION label (not
 * a causal claim) for sibling projections of one source action. No DB / no SoT.
 */

import {
  conceptId,
  conceptVersion,
  translatorName,
  translatorVersionTag,
  type TranslatorContractDigest,
} from "../../versioning.types";
import { canonicalize, sha256Hex } from "../../canonical-serialize";
import type { RawInput, Translator, TranslatorProjection } from "../translator.interface";

export type FixtureScenario =
  | { kind: "happy" }
  | { kind: "free-text-id"; label: string }
  | { kind: "unresolved-id" }
  | { kind: "partial"; missing: string[] }
  | { kind: "inference"; runId: string; datum: number }
  | { kind: "value-shape-mismatch" }
  | { kind: "missing-field" }
  | { kind: "fan-out" }
  | { kind: "custom-concept"; conceptId: string; requestedConceptVersion?: string }
  | { kind: "process-chain"; instanceId: string }
  | { kind: "bad-reality-tier" }
  | { kind: "bad-field-tier" }
  | { kind: "channel-laundering" }
  | { kind: "blank-field-provenance" }
  | { kind: "blank-field-provenance-second" }
  | { kind: "field-provenance" }
  | { kind: "declared-uncovered" }
  | { kind: "missing-coverage" }
  | { kind: "sensor-inactive" }
  | { kind: "event-interval" }
  | { kind: "event-unknown" };

const FIXTURE_TRANSLATOR_NAME = "documents-normalize";
const FIXTURE_TRANSLATOR_VERSION = "1.0.0";

/** The DECLARED contract of this translator — a canonical statement of what it
 *  emits. Its digest is pinned by replay; changing it (without a version bump)
 *  breaks pinning. `contractVariant` exists only to simulate drift in tests. */
function declaredContract(contractVariant: string) {
  return {
    translatorName: FIXTURE_TRANSLATOR_NAME,
    version: FIXTURE_TRANSLATOR_VERSION,
    contractVariant,
    emitsConcepts: ["SalesCommitment", "Communication", "ResourceLevel"],
  };
}

function contractDigestOf(contractVariant: string): TranslatorContractDigest {
  return ("translatorcontract:sha256:" +
    sha256Hex(canonicalize(declaredContract(contractVariant)))) as TranslatorContractDigest;
}

function base(input: RawInput): TranslatorProjection {
  return {
    emittedObservationIndex: 0,
    conceptId: conceptId("SalesCommitment"),
    referentDraft: {
      referentType: "COMMITMENT",
      identity: {
        kind: "RESOLVED",
        entityType: "BillingDocument",
        entityId: 100,
        resolutionMethod: "DETERMINISTIC_EXACT",
      },
    },
    value: { scale: "NOMINAL", datum: "established", unit: null },
    mode: "EVENT",
    eventTime: { kind: "INSTANT", at: "2026-07-01T00:00:00.000Z" },
    provenanceDraft: {
      realityTier: "tier-observed",
      authentication: "AUTHENTICATED",
      channel: input.ref.featureDomain,
    },
    completeness: { kind: "COMPLETE" },
    sourceSensor: input.ref.featureDomain,
  };
}

/** Correlation label shared by siblings of one originating source action. */
function originatingCorrelation(input: RawInput): { note: string } {
  return { note: `originating-action:${input.ref.sourceRecordId}` };
}

export function createDocumentsFixtureTranslator(
  opts: { contractVariant?: string } = {}
): Translator {
  const contractVariant = opts.contractVariant ?? "v1";
  return {
    name: translatorName(FIXTURE_TRANSLATOR_NAME),
    version: translatorVersionTag(FIXTURE_TRANSLATOR_VERSION),
    contractDigest: contractDigestOf(contractVariant),
    translate(input: RawInput): readonly TranslatorProjection[] {
      const s = input.payload as FixtureScenario;
      const b = base(input);
      switch (s.kind) {
        case "happy":
          return [b];

        case "free-text-id":
          return [
            {
              ...b,
              referentDraft: {
                referentType: "PARTY",
                identity: { kind: "SIGNAL_ONLY", signalType: "free-text", signalValue: s.label },
              },
            },
          ];

        case "unresolved-id":
          return [
            {
              ...b,
              referentDraft: {
                referentType: "PARTY",
                identity: { kind: "UNRESOLVED", reason: "UNRESOLVED_IDENTITY" },
              },
            },
          ];

        case "partial":
          return [{ ...b, completeness: { kind: "PARTIAL", missing: s.missing } }];

        case "inference":
          return [
            {
              ...b,
              conceptId: conceptId("ResourceLevel"),
              referentDraft: {
                referentType: "RESOURCE",
                identity: {
                  kind: "RESOLVED",
                  entityType: "InventoryItem",
                  entityId: 200,
                  resolutionMethod: "DETERMINISTIC_EXACT",
                },
              },
              value: { scale: "RATIO", datum: s.datum, unit: "count" },
              mode: "MEASURE",
              provenanceDraft: {
                realityTier: "tier-inferred",
                authentication: "THIRD_PARTY",
                channel: input.ref.featureDomain,
                inference: {
                  engine: "google-vision",
                  engineVersion: "textDetection-v1",
                  runId: s.runId,
                  nonDeterministic: true,
                },
              },
            },
          ];

        case "value-shape-mismatch":
          // SalesCommitment expects EVENT/NOMINAL; emit MEASURE/RATIO.
          return [{ ...b, value: { scale: "RATIO", datum: 5, unit: "ILS" }, mode: "MEASURE" }];

        case "missing-field":
          // ResourceLevel (MEASURE/RATIO/count) with a null datum → MISSING_REQUIRED_FIELD.
          return [
            {
              ...b,
              conceptId: conceptId("ResourceLevel"),
              value: { scale: "RATIO", datum: null, unit: "count" },
              mode: "MEASURE",
            },
          ];

        case "fan-out": {
          const corr = originatingCorrelation(input);
          return [
            { ...b, emittedObservationIndex: 0, causeRef: corr },
            { ...b, emittedObservationIndex: 1, causeRef: corr },
          ];
        }

        case "custom-concept":
          return [
            {
              ...b,
              conceptId: conceptId(s.conceptId),
              ...(s.requestedConceptVersion !== undefined
                ? { requestedConceptVersion: conceptVersion(s.requestedConceptVersion) }
                : {}),
            },
          ];

        case "process-chain":
          return [
            { ...b, processInstanceRef: { processType: "invoice-lifecycle", instanceId: s.instanceId } },
          ];

        case "bad-reality-tier":
          return [
            {
              ...b,
              provenanceDraft: { ...b.provenanceDraft, realityTier: "tier-nonexistent" },
            },
          ];

        case "bad-field-tier":
          // record tier valid; a FIELD tier is invalid → INVALID_REALITY_TIER @ FIELD
          return [
            {
              ...b,
              provenanceDraft: {
                ...b.provenanceDraft,
                fieldProvenance: [
                  { field: "amount", realityTier: "tier-nonexistent", channel: input.ref.featureDomain },
                ],
              },
            },
          ];

        case "blank-field-provenance":
          // a field-provenance entry with a blank channel → CHANNEL_LAUNDERING @ [0]
          return [
            {
              ...b,
              provenanceDraft: {
                ...b.provenanceDraft,
                fieldProvenance: [{ field: "amount", realityTier: "tier-observed", channel: "" }],
              },
            },
          ];

        case "blank-field-provenance-second":
          // same violation, different field position → CHANNEL_LAUNDERING @ [1]
          return [
            {
              ...b,
              provenanceDraft: {
                ...b.provenanceDraft,
                fieldProvenance: [
                  { field: "amount", realityTier: "tier-observed", channel: "documents" },
                  { field: "vendor", realityTier: "tier-observed", channel: "" },
                ],
              },
            },
          ];

        case "channel-laundering":
          // Inference claim with an empty runId — origin cannot be laundered.
          return [
            {
              ...b,
              provenanceDraft: {
                ...b.provenanceDraft,
                realityTier: "tier-inferred",
                inference: {
                  engine: "google-vision",
                  engineVersion: "textDetection-v1",
                  runId: "",
                  nonDeterministic: true,
                },
              },
            },
          ];

        case "field-provenance":
          return [
            {
              ...b,
              provenanceDraft: {
                ...b.provenanceDraft,
                fieldProvenance: [
                  { field: "amount", realityTier: "tier-observed", channel: input.ref.featureDomain },
                ],
              },
            },
          ];

        case "declared-uncovered":
          // hits an EXPLICIT UNCOVERED coverage entry → valid COT
          return [{ ...b, sourceSensor: "declared-uncovered-sensor" }];

        case "missing-coverage":
          // no coverage entry for this sensor → typed rejection, no COT
          return [{ ...b, sourceSensor: "unwired-sensor" }];

        case "sensor-inactive":
          return [{ ...b, sourceSensor: "inactive-sensor" }];

        case "event-interval":
          return [
            {
              ...b,
              eventTime: {
                kind: "INTERVAL",
                from: "2026-07-02T00:00:00.000Z",
                to: "2026-07-03T00:00:00.000Z",
              },
            },
          ];

        case "event-unknown":
          return [{ ...b, eventTime: { kind: "UNKNOWN", reason: "NOT_OBSERVED" } }];

        default: {
          const _exhaustive: never = s;
          return [_exhaustive];
        }
      }
    },
  };
}
