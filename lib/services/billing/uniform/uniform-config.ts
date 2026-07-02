/**
 * WP2 — Uniform Export software-identity config.
 *
 * ⚠️ SIMULATOR-ONLY PLACEHOLDERS ⚠️
 * The values in `SIMULATOR_SOFTWARE_CONFIG` are placeholders for running the
 * official Tax Authority simulator ONLY. They are NOT production values.
 *
 * After Dubiz receives its real software registration number (via Form 513),
 * swap these for the real config — this is a CONFIG change only, no logic
 * changes in the builders/serializer (which read every value from here).
 *
 * Scope (BD-1): Dubiz is registered as an INVOICE-ISSUANCE software, not a
 * double-entry accounting system → INI field 1013 = 0, and B100/B110/M100 are
 * NOT produced.
 */

export type UniformSoftwareConfig = {
  /** True marks these as simulator placeholders (never production). */
  isSimulator: boolean;
  /** A000/INI field 1006 — software registration number (from Form 513). */
  softwareRegistrationNumber: string;
  /** field 1007 */
  softwareName: string;
  /** field 1008 */
  softwareVersion: string;
  /** field 1009 — software vendor VAT number (ע"מ). */
  vendorVatNumber: string;
  /** field 1010 */
  vendorName: string;
  /** field 1030 — compression tool name. */
  compressionSoftwareName: string;
  /** field 1011 — 1=single-year, 2=multi-year. Dubiz = 2. */
  softwareType: 1 | 2;
  /** field 1013 — 0=not relevant, 1=single-sided, 2=double-entry. BD-1 → 0. */
  accountingType: 0 | 1 | 2;
  /** field 1028 — 0=Hebrew, 1=Arabic, 2=other. */
  languageCode: 0 | 1 | 2;
  /** field 1029 — 1=ISO-8859-8-i, 2=CP-862. */
  charset: 1 | 2;
  /** field 1032 — leading currency (ISO 4217). */
  leadingCurrency: string;
};

/**
 * SIMULATOR-ONLY placeholder config. Replace after real registration.
 * (The simulator's own example uses registration number "00000001".)
 */
export const SIMULATOR_SOFTWARE_CONFIG: UniformSoftwareConfig = {
  isSimulator: true,
  softwareRegistrationNumber: "00000001", // 1006 — SIMULATOR ONLY
  softwareName: "DUBIZ", // 1007
  softwareVersion: "1.0", // 1008
  vendorVatNumber: "515000123", // 1009 — SIMULATOR ONLY: valid check-digit test ע"מ (must NOT be zeroed); real vendor ע"מ after Form 513
  vendorName: "DUBIZ", // 1010
  compressionSoftwareName: "ZIP", // 1030
  softwareType: 2, // 1011 — multi-year
  accountingType: 0, // 1013 — not relevant (BD-1: document-only)
  languageCode: 0, // 1028 — Hebrew
  charset: 1, // 1029 — ISO-8859-8-i
  leadingCurrency: "ILS", // 1032
};
