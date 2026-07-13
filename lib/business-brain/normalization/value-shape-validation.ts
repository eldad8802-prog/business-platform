/**
 * Father Engine — C0 / PR3. Value ↔ concept ValueShape validation.
 *
 * Structural only: mode, scale, and unit must agree with the concept's declared
 * valueShape. On mismatch it returns the STRUCTURED expected/actual so the caller
 * can build a canonical rejection identity (no free-form detail string).
 */

import type { Mode, Value } from "../observation.types";
import type { ConceptValueShape } from "../registry/concept-registry";

export type ValueShapeCheck =
  | { ok: true }
  | {
      ok: false;
      expectedMode: Mode;
      expectedScale: Value["scale"];
      expectedUnitDimension: string | null;
      actualMode: Mode;
      actualScale: Value["scale"];
      actualUnit: string | null;
    };

export function validateValueShape(
  value: Value,
  mode: Mode,
  shape: ConceptValueShape
): ValueShapeCheck {
  const needsUnit = shape.unitDimension !== undefined;
  const unitOk = needsUnit ? value.unit !== null : value.unit === null;
  const matches = mode === shape.mode && value.scale === shape.scale && unitOk;
  if (matches) return { ok: true };
  return {
    ok: false,
    expectedMode: shape.mode,
    expectedScale: shape.scale,
    expectedUnitDimension: shape.unitDimension ?? null,
    actualMode: mode,
    actualScale: value.scale,
    actualUnit: value.unit,
  };
}
