/**
 * Platform signing identity — non-secret descriptive types (Phase 2B-2).
 *
 * Extends the Phase 2A signer seam (`SigningMaterial` / `SigningIdentityResolver`)
 * with the metadata needed to INSPECT a platform signing identity for audit /
 * diagnostics WITHOUT exposing any private material. The private key and PKCS#12
 * bytes never appear here — only `SigningMaterial` carries those, server-side.
 *
 * Platform identity semantics (v1):
 *   "Dubiz signed this PDF and attests that the bytes have not changed since
 *    signing."
 * NOT:
 *   "The business cryptographically signed this PDF."
 * The signing certificate belongs to the Dubiz platform, is identical for every
 * tenant in v1, and asserts integrity/attribution by the platform — not authorship
 * by the individual business. Keep this distinction intact in code, types, and tests.
 */

/** The only identity kind in v1: a single platform (Dubiz) signing certificate. */
export const PLATFORM_SIGNING_IDENTITY_KIND = "platform" as const;
export type SigningIdentityKind = typeof PLATFORM_SIGNING_IDENTITY_KIND;

/** Point-in-time assessment of the signing certificate's validity window. */
export type CertificateValidityStatus = "valid" | "not_yet_valid" | "expired";

/**
 * Non-secret, inspectable description of a signing identity. Safe to log, persist
 * for audit, or surface in a future UI. Contains NO private key and NO passphrase.
 */
export type SigningIdentityMetadata = {
  kind: SigningIdentityKind;
  /** Certificate subject CN (e.g. the platform signer name), or null if absent. */
  certificateSubjectCommonName: string | null;
  /** Certificate issuer CN; equals the subject CN for a self-signed platform cert. */
  certificateIssuerCommonName: string | null;
  /**
   * SHA-256 fingerprint of the DER-encoded certificate, hex. A stable, NON-SECRET
   * identifier — useful for audit, diagnostics, and rotation tracking without ever
   * storing the certificate itself.
   */
  certificateFingerprintSha256: string;
  /** Start of the certificate validity window. */
  notBefore: Date;
  /** End of the certificate validity window. */
  notAfter: Date;
};
