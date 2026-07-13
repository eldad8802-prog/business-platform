/**
 * Father Engine — C0 / PR3. Value ↔ concept ValueShape validation.
 *
 * Structural only: mode, scale, and unit presence must agree with the concept's
 * declared valueShape. No thresholds, no semantic judgment.
 */

import type { Mode, Value } from "../observation.types";
import type { ConceptValueShape } from "../registry/concept-registry";

export type ValueShapeCheck = { ok: true } | { ok: false; detail: string };

export function validateValueShape(
  value: Value,
  mode: Mode,
  shape: ConceptValueShape
): ValueShapeCheck {
  if (mode !== shape.mode) {
    return { ok: false, detail: `mode "${mode}" != concept "${shape.mode}"` };
  }
  if (value.scale !== shape.scale) {
    return { ok: false, detail: `scale "${value.scale}" != concept "${shape.scale}"` };
  }
  const needsUnit = shape.unitDimension !== undefined;
  if (needsUnit && (value.unit === null || value.unit === undefined)) {
    return { ok: false, detail: `unit required for dimension "${shape.unitDimension}"` };
  }
  if (!needsUnit && value.unit !== null) {
    return { ok: false, detail: "unit must be null for a unitless shape" };
  }
  return { ok: true };
}
