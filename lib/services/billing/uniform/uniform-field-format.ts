/**
 * WP2.2 — Fixed-width field formatters per spec 1.31 §2.3–2.4.
 *
 * All formatters return a string of EXACTLY `len` characters (single-byte after
 * encoding), so the serializer can concatenate them into a fixed-width record.
 */

/** Alphanumeric: left-justified, space-padded on the right (§2.3.ה). */
export function formatAlpha(value: string | null | undefined, len: number): string {
  let s = value == null ? "" : String(value);
  if (s.length > len) s = s.slice(0, len); // fixed width → truncate to fit
  return s.padEnd(len, " ");
}

/** Numeric: leading zeros, right-justified (§2.3.ה). Digits only. */
export function formatNumeric(value: string | number | null | undefined, len: number): string {
  const digits = String(value == null ? "" : value).replace(/\D/g, "");
  if (digits.length > len) {
    throw new Error(`Numeric field overflow: "${value}" (${digits.length}) > ${len}`);
  }
  return digits.padStart(len, "0");
}

/**
 * Signed amount, alphanumeric `X9(int)v99` (§2.4, examples):
 * sign(+/-) + zero-padded integer + `frac` decimal digits, NO decimal point.
 * Field length = 1 + intWidth + frac. Zero → "+" (§2.4.יא: 0 shown as +).
 * e.g. len=15,frac=2: -12345.65 → "-000000001234565"? No — intWidth=12:
 *   -12345.65 → "-" + "000000012345" + "65" = "-00000001234565".
 */
export function formatSignedAmount(
  value: string | number | null | undefined,
  len: number,
  frac: number
): string {
  const intWidth = len - 1 - frac;
  if (intWidth < 0) throw new Error(`Bad signed-amount width: len=${len} frac=${frac}`);
  let raw = String(value == null ? "0" : value).trim();
  if (raw === "") raw = "0";
  let negative = false;
  if (raw.startsWith("-")) {
    negative = true;
    raw = raw.slice(1);
  } else if (raw.startsWith("+")) {
    raw = raw.slice(1);
  }
  const [intRaw = "0", fracRaw = ""] = raw.split(".");
  const intPart = intRaw.replace(/\D/g, "") || "0";
  const fracPart = (fracRaw.replace(/\D/g, "") + "0".repeat(frac)).slice(0, frac);
  if (intPart.length > intWidth) {
    throw new Error(`Signed-amount overflow: "${value}" int(${intPart.length}) > ${intWidth}`);
  }
  const sign = negative ? "-" : "+";
  return sign + intPart.padStart(intWidth, "0") + fracPart;
}

/**
 * Unsigned numeric with implied decimals `9(int)v99` (§2.4.ו notation),
 * e.g. VAT rate field 1268 (`9(2)v99`, len 4): "17.00" → "1700".
 * Field length = intWidth + frac (no sign).
 */
export function formatUnsignedAmount(
  value: string | number | null | undefined,
  len: number,
  frac: number
): string {
  const intWidth = len - frac;
  if (intWidth < 0) throw new Error(`Bad unsigned-amount width: len=${len} frac=${frac}`);
  let raw = String(value == null ? "0" : value).trim().replace(/^[+-]/, "");
  if (raw === "") raw = "0";
  const [intRaw = "0", fracRaw = ""] = raw.split(".");
  const intPart = intRaw.replace(/\D/g, "") || "0";
  const fracPart = (fracRaw.replace(/\D/g, "") + "0".repeat(frac)).slice(0, frac);
  if (intPart.length > intWidth) {
    throw new Error(`Unsigned-amount overflow: "${value}" int(${intPart.length}) > ${intWidth}`);
  }
  return intPart.padStart(intWidth, "0") + fracPart;
}

/** Date → YYYYMMDD (§2.4.ב). Accepts ISO or YYYYMMDD; null/invalid → zeros. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "00000000";
  const iso = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const compact = String(value).match(/^(\d{8})$/);
  if (compact) return compact[1];
  return "00000000";
}

/** Time → HHMM (§2.4.ג). Accepts ISO time; null/invalid → zeros. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "0000";
  const m = String(value).match(/[T ](\d{2}):(\d{2})/);
  if (m) return `${m[1]}${m[2]}`;
  const compact = String(value).match(/^(\d{4})$/);
  if (compact) return compact[1];
  return "0000";
}
