/**
 * WP2 — Uniform Export software-identity config.
 *
 * Two configs live here, and they are NOT interchangeable:
 * - `DUBIZ_SOFTWARE_CONFIG` — the LIVE identity used by the production export
 *   endpoint. Carries the official ITA registration number (270901).
 * - `SIMULATOR_SOFTWARE_CONFIG` — frozen simulator identity, kept ONLY so the
 *   historical 2026-07-02 "תקינה" run stays byte-for-byte reproducible. It is
 *   NOT a production config and must not be updated to the official number.
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
 * SIMULATOR-ONLY frozen config — the exact identity used in the official
 * simulator run of 2026-07-02 ("תקינה"). DO NOT update these values to the
 * official registration number: they exist to keep that historical run
 * deterministically reproducible (see the certification doc). The live identity
 * is `DUBIZ_SOFTWARE_CONFIG` below.
 * (The simulator's own example uses registration number "00000001".)
 */
export const SIMULATOR_SOFTWARE_CONFIG: UniformSoftwareConfig = {
  isSimulator: true,
  softwareRegistrationNumber: "00000001", // 1006 — SIMULATOR ONLY
  softwareName: "דוביז Dubiz", // 1007 — software-house name accepted by the simulator
  softwareVersion: "1.0", // 1008
  vendorVatNumber: "515000123", // 1009 — SIMULATOR ONLY: valid check-digit test ע"מ (must NOT be zeroed); real vendor ע"מ after Form 513
  vendorName: "נהרי אלדד", // 1010 — software vendor name accepted by the simulator
  compressionSoftwareName: "ZIP", // 1030
  softwareType: 2, // 1011 — multi-year
  accountingType: 0, // 1013 — not relevant (BD-1: document-only)
  languageCode: 0, // 1028 — Hebrew
  charset: 1, // 1029 — ISO-8859-8-i
  leadingCurrency: "ILS", // 1032
};

/**
 * Canonical LIVE software-identity config for the Dubiz production export
 * endpoint (real software-house identity — NOT the simulator).
 *
 * Field 1009 (vendor entity number) = "312260110" — the registered entity/
 * dealer number of the software house ("אלדד נהרי"). 1010 must stay matched to
 * that entity ("אלדד נהרי"); "דוביז Dubiz" is the PRODUCT name (1007), not the
 * vendor.
 *
 * Field 1006 (softwareRegistrationNumber) = "270901" — the OFFICIAL ITA
 * software registration certificate number issued for "דוביז dubiz" מהדורה 1.0
 * (file / software-house number 312260110), valid 22/07/2026 – 31/07/2028.
 * Source: the ITA registration certificate. Do NOT change this value without an
 * official source document.
 */
export const DUBIZ_SOFTWARE_CONFIG: UniformSoftwareConfig = {
  isSimulator: false,
  softwareRegistrationNumber: "270901", // 1006 — official ITA registration certificate number
  softwareName: "דוביז Dubiz", // 1007 — product name
  softwareVersion: "1.0", // 1008
  vendorVatNumber: "312260110", // 1009 — real vendor entity/dealer number (software house)
  vendorName: "אלדד נהרי", // 1010 — vendor entity name (matches 1009)
  compressionSoftwareName: "ZIP", // 1030
  softwareType: 2, // 1011 — multi-year
  accountingType: 0, // 1013 — not relevant (BD-1: document-only)
  languageCode: 0, // 1028 — Hebrew
  charset: 1, // 1029 — ISO-8859-8-i
  leadingCurrency: "ILS", // 1032
};
