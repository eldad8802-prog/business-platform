/**
 * Father Engine — C0. Shared coverage types.
 *
 * Coverage GROUNDS live at the Observation/Sensor-account level: how well the
 * source sensing covers what the observation speaks about. This is a DIFFERENT
 * axis from the Business Observability Ontology's detectability class (T1/T2/T3),
 * which classifies a phenomenon/observable world-region after combining sensors,
 * joins, forms and system boundaries. T1/T2/T3 is derived LATER, in the
 * Observability Ontology layer — it is deliberately NOT carried inside the COT.
 *
 * These types are the single shared home consumed by BOTH the COT
 * (observation.types.ts) and the Coverage Registry (registry/coverage-registry.ts) —
 * no mirror.
 */

export type CoverageState = "FULL" | "PARTIAL" | "UNCOVERED";

export type SensorDeclaredState = "ACTIVE" | "INACTIVE" | "UNKNOWN";

/** Declared (static) sensor state pinned by a registry snapshot — NOT a live probe. */
export interface SensorState {
  sensorId: string;
  declared: SensorDeclaredState;
}

/** Observation-level coverage grounds. `absenceInformative` is an EXPLICIT policy —
 *  never inferred from `state`. `scopeRef` links to the coverage statement/policy. */
export interface Coverage {
  state: CoverageState;
  sensorState: SensorState;
  absenceInformative: boolean;
  scopeRef: string;
}
