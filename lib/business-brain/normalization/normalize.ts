/**
 * Father Engine — C0 / PR3. normalize() — the pure orchestrator.
 *
 *   Raw Fixture → Translator → Concept Resolution → ValueShape → Field Provenance
 *   → Coverage Resolution → Identity Binding → Confidence Grounds
 *   → CanonicalObservation Account   (or a typed rejection — never a fabricated COT)
 *
 * No DB, no Source of Truth, no wall-clock, no Replay. Concept-version selection
 * uses observationTime against the PINNED snapshot only. Coverage grounds are
 * carried as-is (FULL/PARTIAL/UNCOVERED) — NO mapping to the Observability
 * Ontology's T1/T2/T3.
 */

import { sealObservation } from "../observation-identity";
import type {
  ExecutionContext,
  ObservationContent,
  ObservationTime,
  Provenance,
} from "../observation.types";
import type { Coverage } from "../coverage.types";
import type {
  BusinessConceptDefinition,
  ConceptRegistry,
} from "../registry/concept-registry";
import type { CoverageKey, CoverageRegistry } from "../registry/coverage-registry";
import type { RealityTierValidator } from "./reality-tier-registry";
import { validateValueShape } from "./value-shape-validation";
import { validateProvenance } from "./provenance-validation";
import type { RawInput, Translator, TranslatorProjection } from "./translator.interface";
import type {
  NormalizationRejectionIdentity,
  NormalizationResult,
  SourceRef,
} from "./normalization-result.types";
import {
  normalizationPolicyVersion,
  type NormalizationPolicyVersion,
} from "../versioning.types";

/**
 * Pins the normalize() decision ruleset: concept-version selection + effective-time
 * rules, value-shape validation, required-field rules, provenance structural
 * validation, RealityTier boundary behaviour, coverage resolution behaviour, the
 * failure-reason taxonomy, and rejection-identity construction. Bump on ANY change
 * to these rules (replay pins it via ReplayDependencyContext).
 */
export const NORMALIZATION_POLICY_VERSION: NormalizationPolicyVersion =
  normalizationPolicyVersion("normalize@1");

export interface NormalizeDeps {
  translator: Translator;
  conceptRegistry: ConceptRegistry;
  coverageRegistry: CoverageRegistry;
  realityTierValidator: RealityTierValidator;
  /** The pinned run identity. */
  context: ExecutionContext;
}

export function normalize(
  input: RawInput,
  deps: NormalizeDeps
): readonly NormalizationResult[] {
  // Snapshot pinning precondition — the registry MUST be the one pinned by context.
  if (deps.conceptRegistry.snapshot.digest !== deps.context.conceptRegistrySnapshot) {
    return [
      {
        ok: false,
        source: { ref: input.ref },
        identity: {
          reason: "SNAPSHOT_MISMATCH",
          expectedSnapshot: deps.context.conceptRegistrySnapshot,
          actualSnapshot: deps.conceptRegistry.snapshot.digest,
        },
      },
    ];
  }
  return deps.translator.translate(input).map((p) => processProjection(p, input, deps));
}

type VersionSelection =
  | { ok: true; definition: BusinessConceptDefinition }
  | { ok: false; identity: NormalizationRejectionIdentity };

function selectConceptVersion(
  projection: TranslatorProjection,
  observationTime: ObservationTime,
  registry: ConceptRegistry
): VersionSelection {
  const conceptId = projection.conceptId;
  const versions = registry.listVersions(conceptId);
  if (versions.length === 0) {
    return { ok: false, identity: { reason: "UNKNOWN_CONCEPT", conceptId } };
  }

  const t = Date.parse(observationTime.at);
  const isEffective = (d: BusinessConceptDefinition): boolean => {
    const from = Date.parse(d.effectiveFrom);
    const to = d.effectiveTo ? Date.parse(d.effectiveTo) : Number.POSITIVE_INFINITY;
    return from <= t && t < to;
  };

  // Explicit-version path — validate, never silently fall back.
  const requestedVersion = projection.requestedConceptVersion;
  if (requestedVersion !== undefined) {
    const exact = versions.find((d) => d.conceptVersion === requestedVersion);
    if (!exact) {
      return { ok: false, identity: { reason: "UNKNOWN_CONCEPT_VERSION", conceptId, requestedVersion } };
    }
    if (!isEffective(exact)) {
      return {
        ok: false,
        identity: {
          reason: "REQUESTED_CONCEPT_VERSION_NOT_EFFECTIVE",
          conceptId,
          requestedVersion,
          observationTime,
        },
      };
    }
    return { ok: true, definition: exact };
  }

  // LIVE path — select the unique version effective at observationTime.
  const eligible = versions.filter(isEffective);
  if (eligible.length === 0) {
    return { ok: false, identity: { reason: "NO_EFFECTIVE_CONCEPT_VERSION", conceptId, observationTime } };
  }
  if (eligible.length > 1) {
    // Canonical: sorted, de-duplicated — never insertion order.
    const candidateVersions = [...new Set(eligible.map((d) => d.conceptVersion))].sort();
    return {
      ok: false,
      identity: { reason: "CONCEPT_VERSION_AMBIGUOUS", conceptId, observationTime, candidateVersions },
    };
  }
  return { ok: true, definition: eligible[0]! };
}

function requiredFieldsPresent(
  projection: TranslatorProjection
): { ok: true } | { ok: false; field: string } {
  const magnitude =
    projection.mode === "MEASURE" ||
    projection.value.scale === "INTERVAL" ||
    projection.value.scale === "RATIO" ||
    projection.value.scale === "CARDINAL";
  if (magnitude && (projection.value.datum === null || projection.value.datum === undefined)) {
    return { ok: false, field: "value.datum" };
  }
  return { ok: true };
}

type CoverageResolution =
  | { ok: true; coverage: Coverage }
  | { ok: false; coverageKey: CoverageKey };

function resolveCoverage(
  projection: TranslatorProjection,
  def: BusinessConceptDefinition,
  registry: CoverageRegistry
): CoverageResolution {
  const key: CoverageKey = {
    referentType: projection.referentDraft.referentType,
    ...(projection.referentDraft.referentSubtype !== undefined
      ? { referentSubtype: projection.referentDraft.referentSubtype }
      : {}),
    conceptId: def.conceptId,
    sourceSensor: projection.sourceSensor,
  };
  const resolved = registry.resolve(key);
  if (resolved.status === "FOUND") {
    // Carry the explicit grounds VERBATIM — state, sensorState and
    // absenceInformative are never inferred or defaulted here.
    return {
      ok: true,
      coverage: {
        state: resolved.entry.coverageState,
        sensorState: resolved.entry.sensorState,
        absenceInformative: resolved.entry.absenceInformative,
        scopeRef: `${projection.sourceSensor}:${def.conceptId}`,
      },
    };
  }
  // NO_ENTRY is NOT the same as a declared UNCOVERED. A missing coverage
  // declaration is a typed rejection — we never fabricate coverage grounds
  // (missing != negative; do not hide a configuration gap).
  return { ok: false, coverageKey: key };
}

function processProjection(
  projection: TranslatorProjection,
  input: RawInput,
  deps: NormalizeDeps
): NormalizationResult {
  const source: SourceRef = {
    ref: input.ref,
    emittedObservationIndex: projection.emittedObservationIndex,
  };

  const selection = selectConceptVersion(projection, input.observationTime, deps.conceptRegistry);
  if (!selection.ok) {
    return { ok: false, source, identity: selection.identity };
  }
  const def = selection.definition;

  const shapeCheck = validateValueShape(projection.value, projection.mode, def.valueShape);
  if (!shapeCheck.ok) {
    return {
      ok: false,
      source,
      identity: {
        reason: "VALUE_SHAPE_MISMATCH",
        expectedMode: shapeCheck.expectedMode,
        expectedScale: shapeCheck.expectedScale,
        expectedUnitDimension: shapeCheck.expectedUnitDimension,
        actualMode: shapeCheck.actualMode,
        actualScale: shapeCheck.actualScale,
        actualUnit: shapeCheck.actualUnit,
      },
    };
  }

  const required = requiredFieldsPresent(projection);
  if (!required.ok) {
    return {
      ok: false,
      source,
      identity: { reason: "MISSING_REQUIRED_FIELD", field: required.field },
    };
  }

  const provenance: Provenance = {
    realityTier: projection.provenanceDraft.realityTier,
    authentication: projection.provenanceDraft.authentication,
    channel: projection.provenanceDraft.channel,
    ...(projection.provenanceDraft.inference !== undefined
      ? { inference: projection.provenanceDraft.inference }
      : {}),
    ...(projection.provenanceDraft.fieldProvenance !== undefined
      ? { fieldProvenance: projection.provenanceDraft.fieldProvenance }
      : {}),
  };
  const provCheck = validateProvenance(provenance, deps.realityTierValidator);
  if (!provCheck.ok) {
    return { ok: false, source, identity: provCheck.identity };
  }

  const coverageResolution = resolveCoverage(projection, def, deps.coverageRegistry);
  if (!coverageResolution.ok) {
    return {
      ok: false,
      source,
      identity: { reason: "COVERAGE_ENTRY_MISSING", coverageKey: coverageResolution.coverageKey },
    };
  }
  const coverage = coverageResolution.coverage;

  const content: ObservationContent = {
    tenant: input.tenant,
    source: {
      featureDomain: input.ref.featureDomain,
      sourceModel: input.ref.sourceModel,
      sourceRecordId: input.ref.sourceRecordId,
      emittedObservationIndex: projection.emittedObservationIndex,
    },
    concept: { conceptId: def.conceptId, conceptVersion: def.conceptVersion },
    referent: {
      referentType: projection.referentDraft.referentType,
      ...(projection.referentDraft.referentSubtype !== undefined
        ? { referentSubtype: projection.referentDraft.referentSubtype }
        : {}),
      identityBinding: projection.referentDraft.identity,
    },
    value: projection.value,
    mode: projection.mode,
    eventTime: projection.eventTime,
    observationTime: input.observationTime,
    provenance,
    completeness: projection.completeness,
    coverage,
    confidenceBasis: projection.confidenceBasis ?? {},
    ...(projection.causeRef !== undefined ? { causeRef: projection.causeRef } : {}),
    ...(projection.processInstanceRef !== undefined
      ? { processInstanceRef: projection.processInstanceRef }
      : {}),
    context: deps.context,
  };

  return { ok: true, observation: sealObservation(content) };
}
