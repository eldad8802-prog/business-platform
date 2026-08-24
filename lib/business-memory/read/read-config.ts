/**
 * Business Memory READ-4 · Read flag — BUSINESS_MEMORY_READ.
 *
 * Gates the comparison-only product wiring. Completely SEPARATE from BUSINESS_MEMORY_SHADOW (the write
 * flag). Comparison-only never overrides the product decision; even ON, the product returns the incumbent.
 *
 * Read is OFF unless BUSINESS_MEMORY_READ is EXPLICITLY the string "true" (trimmed, case-insensitive).
 * Absent / empty / "false" / "0" / "1" / malformed => OFF. Fail-closed, default OFF. No tenant flag,
 * no DB flag — a single cheap env check.
 */
export function isReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.BUSINESS_MEMORY_READ;
  return typeof v === "string" && v.trim().toLowerCase() === "true";
}
