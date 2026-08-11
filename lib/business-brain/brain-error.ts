/**
 * Father Engine — C0 (Canonical Observation Model).
 *
 * BrainError — the error type for the observation/knowledge layer. Deliberately
 * separate from `lib/errors.ts` (which is HTTP-oriented, AppError): C0 is a pure
 * domain layer with no request/response semantics. A BrainError signals that an
 * observation could not be constructed, canonicalized, or identified — never an
 * HTTP status.
 */

export type BrainErrorCode =
  /** A number in canonical content was NaN / ±Infinity (non-serializable). */
  | "NON_FINITE_NUMBER"
  /** A value could not be reduced to canonical form (function, symbol, bigint…). */
  | "UNSERIALIZABLE"
  /** A CanonicalObservation failed a structural invariant. */
  | "INVALID_OBSERVATION"
  /** A recomputed identity did not match the one carried on the record. */
  | "IDENTITY_MISMATCH"
  /** A branded versioning/identity value was empty or malformed. */
  | "INVALID_VERSIONING_ID"
  /** Two registry entries share the same identity key with identical content. */
  | "REGISTRY_DUPLICATE_ENTRY"
  /** The same (id,version) key was presented with a DIFFERENT definition. */
  | "REGISTRY_IMMUTABLE_VIOLATION";

export class BrainError extends Error {
  readonly code: BrainErrorCode;
  readonly details?: unknown;

  constructor(code: BrainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BrainError";
    this.code = code;
    this.details = details;
    // Preserve prototype chain under ES2017 target (transpiled classes).
    Object.setPrototypeOf(this, BrainError.prototype);
  }
}
