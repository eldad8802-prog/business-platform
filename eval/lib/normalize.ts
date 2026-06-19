/**
 * Phase 0 — value normalization for accuracy comparison.
 *
 * These functions ONLY decide whether a predicted value "matches" a ground-truth
 * value for measurement. They do NOT touch production extraction and are never
 * imported by app/ or lib/services. Frozen definitions: do not loosen mid-baseline,
 * or "Before/After" numbers stop being comparable.
 */

export function normalizeVendorKey(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/[״"]/g, '"')
    .replace(/[׳']/g, "'")
    .toLowerCase()
    .replace(/[^֐-׿a-z0-9]+/g, "")
    .trim();
}

/** Primary, strict: exact match after key-normalization. */
export function vendorMatchesStrict(
  truth: string | null | undefined,
  predicted: string | null | undefined
): boolean {
  const t = normalizeVendorKey(truth);
  const p = normalizeVendorKey(predicted);
  if (!t || !p) return false;
  return t === p;
}

/** Secondary, lenient: one side contains the other (suffix/prefix variants). */
export function vendorMatchesLenient(
  truth: string | null | undefined,
  predicted: string | null | undefined
): boolean {
  const t = normalizeVendorKey(truth);
  const p = normalizeVendorKey(predicted);
  if (!t || !p) return false;
  if (t === p) return true;
  return t.includes(p) || p.includes(t);
}

export function amountMatches(
  truth: number | null | undefined,
  predicted: number | null | undefined,
  tolerance = 0.01
): boolean {
  if (truth === null || truth === undefined) return false;
  if (predicted === null || predicted === undefined) return false;
  if (!Number.isFinite(Number(truth)) || !Number.isFinite(Number(predicted))) {
    return false;
  }
  return Math.abs(Number(truth) - Number(predicted)) <= tolerance;
}

export function dateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

/** Day-precision match (ignores time-of-day). */
export function dateMatches(
  truth: Date | string | null | undefined,
  predicted: Date | string | null | undefined
): boolean {
  const a = dateKey(truth);
  const b = dateKey(predicted);
  return Boolean(a) && Boolean(b) && a === b;
}

export function stringMatches(
  truth: string | null | undefined,
  predicted: string | null | undefined
): boolean {
  const t = String(truth ?? "").trim().toLowerCase();
  const p = String(predicted ?? "").trim().toLowerCase();
  if (!t || !p) return false;
  return t === p;
}
