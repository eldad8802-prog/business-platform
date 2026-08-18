/**
 * Cryptographic PDF signing — substrate types (Phase 2A).
 *
 * These types define the boundary between the SIGNER (which only knows how to turn
 * an unsigned PDF + signing material into a signed PDF) and the IDENTITY provider
 * (which decides WHICH material to use). The signer never owns identity provisioning.
 *
 * Nothing here touches Billing, Prisma, storage, env, or the client.
 */

/**
 * The minimal material a signer needs to produce a PKCS#7/PAdES signature.
 * Server-only. Never serialize to a client, never log.
 *
 * `p12` is a PKCS#12 (.p12/.pfx) container holding the private key + certificate
 * (chain). The private key never leaves this process.
 */
export type SigningMaterial = {
  /** PKCS#12 (DER) bytes: private key + signing certificate (+ optional chain). */
  p12: Buffer;
  /** Passphrase protecting the PKCS#12, if any. */
  passphrase?: string;
};

/** Result of signing — the signed PDF bytes plus non-secret descriptive metadata. */
export type SignedPdf = {
  /** The signed PDF (original content + embedded PKCS#7 signature). */
  bytes: Buffer;
  /** Digest algorithm used for the signature (Phase 2A: SHA-256). */
  digestAlgorithm: "sha256";
};

/**
 * Identity seam. In Phase 2A this interface is defined and exercised ONLY by a
 * test resolver — there is NO production implementation and NO Production secret.
 * The point is to prove the signer is agnostic to where the material came from.
 */
export interface SigningIdentityResolver {
  /**
   * Return the signing material for a business (or a platform identity). The
   * signer receives whatever this returns and never reaches for env/DB/secrets.
   */
  resolveSigningIdentity(businessId: number): Promise<SigningMaterial>;
}
