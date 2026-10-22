/**
 * Exact decimal ⇄ scaled-integer arithmetic for money (never floating point).
 *
 * A decimal is carried as a BigInt scaled by 10^scale. Every conversion either is exact or rounds
 * by an explicit, named mode — there is no implicit rounding anywhere in the money engine.
 *
 * Pure and runtime-agnostic (server, client, tests): no Prisma import, so client components can
 * use it. Prisma.Decimal values are accepted through their `toString()`.
 */

export type RoundingMode = "HALF_UP" | "HALF_EVEN";

export class InvalidDecimalError extends Error {
  readonly code = "INVALID_DECIMAL";
  constructor(readonly input: unknown, reason: string) {
    super(`Invalid decimal ${JSON.stringify(String(input))}: ${reason}`);
    this.name = "InvalidDecimalError";
  }
}

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;
/** Decimal-like inputs the engine accepts: strings, finite numbers, Prisma.Decimal (via toString). */
export type DecimalInput = string | number | { toString(): string };

function decimalText(input: DecimalInput): string {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new InvalidDecimalError(input, "not finite");
    // Number → shortest round-trip text ("0.1" stays "0.1"); exponent notation is refused below.
    return String(input);
  }
  return String(input).trim();
}

/**
 * Parses a decimal into a BigInt scaled by 10^scale.
 * - `rounding` omitted → exact: digits beyond `scale` must be zero, otherwise it throws.
 * - `rounding` given  → rounds the excess digits by that mode.
 */
export function parseScaled(input: DecimalInput, scale: number, rounding?: RoundingMode): bigint {
  const text = decimalText(input);
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new InvalidDecimalError(input, "not a plain decimal");
  const negative = m[1] === "-";
  const whole = m[2];
  const frac = m[3] ?? "";
  const kept = frac.slice(0, scale).padEnd(scale, "0");
  const excess = frac.slice(scale);
  let magnitude = BigInt(whole + kept);
  if (/[1-9]/.test(excess)) {
    if (!rounding) throw new InvalidDecimalError(input, `more than ${scale} decimal places`);
    const first = Number(excess[0]);
    const restNonZero = /[1-9]/.test(excess.slice(1));
    const roundUp =
      first > 5 ||
      (first === 5 && (restNonZero || rounding === "HALF_UP" || magnitude % BigInt(2) === BigInt(1)));
    if (roundUp) magnitude += BigInt(1);
  }
  return negative && magnitude !== BigInt(0) ? -magnitude : magnitude;
}

/** Formats a scaled BigInt back to a plain decimal string with exactly `scale` places. */
export function formatScaled(value: bigint, scale: number): string {
  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const frac = scale === 0 ? "" : `.${digits.slice(-scale)}`;
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/** Integer division n / d rounded by `mode` (d ≠ 0; signs handled symmetrically). */
export function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d === BigInt(0)) throw new RangeError("division by zero");
  const negative = n < BigInt(0) !== d < BigInt(0);
  const an = n < BigInt(0) ? -n : n;
  const ad = d < BigInt(0) ? -d : d;
  let q = an / ad;
  const r2 = (an % ad) * BigInt(2);
  if (r2 > ad || (r2 === ad && (mode === "HALF_UP" || q % BigInt(2) === BigInt(1)))) q += BigInt(1);
  return negative && q !== BigInt(0) ? -q : q;
}

export function pow10(exp: number): bigint {
  return BigInt(10) ** BigInt(exp);
}
