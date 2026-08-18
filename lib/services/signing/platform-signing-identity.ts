/**
 * Platform signing identity — PRODUCTION resolver + secret contract (Phase 2B-2).
 *
 * Resolves the single Dubiz PLATFORM signing identity into `SigningMaterial` for the
 * Phase 2A signer. This is the production identity boundary: it loads private signing
 * material from a server-only secret, validates it, and exposes non-secret metadata.
 *
 * What this module does NOT do (hard gates for Phase 2B-2):
 *  - It never SIGNS a PDF (no signPdf call, no runtime wiring to issuance/download).
 *  - It never reaches into Billing, Prisma, storage, or a DB.
 *  - It has NO fallback to test material: a missing/invalid secret FAILS CLOSED.
 *  - It never falls back to "unsigned" behavior.
 *  - The signer stays identity-agnostic — it only ever receives `SigningMaterial`.
 *
 * Platform semantics: the certificate is Dubiz's; a signature attests that *Dubiz*
 * signed and the bytes are unchanged since — not that the business signed. In v1 the
 * material is identical for every tenant (`businessId` is validated but not used to
 * select material, preserving the future per-business contract).
 *
 * SERVER-ONLY. The private material must never reach a browser bundle.
 */
import forge from "node-forge";
import { createHash } from "node:crypto";
import type { SigningMaterial, SigningIdentityResolver } from "./signing-types";
import {
  PLATFORM_SIGNING_IDENTITY_KIND,
  type SigningIdentityMetadata,
  type CertificateValidityStatus,
} from "./signing-identity.types";

// Defensive server-only guard: this module carries a path to private key material
// and must never execute in a browser. (The repo has no `server-only` package; this
// is the lightweight equivalent.)
if (typeof window !== "undefined") {
  throw new Error("platform-signing-identity is server-only and must not be imported by client code");
}

/**
 * Secret contract — server-only env variables. Signing-specific and non-generic;
 * do NOT reuse any existing secret for this. Actual provisioning of these values in
 * Vercel/GitHub/Neon/Production is a SEPARATE gated action — not part of this phase.
 *
 *  - DUBIZ_SIGNING_P12_BASE64      base64 of the platform PKCS#12 (.p12/.pfx) DER
 *                                  (private key + signing certificate [+ chain]).
 *  - DUBIZ_SIGNING_P12_PASSPHRASE  passphrase protecting the PKCS#12 (optional but
 *                                  strongly expected for a real platform key).
 */
export const ENV_PLATFORM_SIGNING_P12_BASE64 = "DUBIZ_SIGNING_P12_BASE64";
export const ENV_PLATFORM_SIGNING_P12_PASSPHRASE = "DUBIZ_SIGNING_P12_PASSPHRASE";

/** Where the resolver reads the raw secret from. Injectable ONLY to let tests supply
 *  disposable material; the production default reads env and nothing else. There is
 *  deliberately no built-in test identity to fall back to. */
export type PlatformSigningSecretSource = () => {
  p12Base64?: string;
  passphrase?: string;
};

const envSecretSource: PlatformSigningSecretSource = () => ({
  p12Base64: process.env[ENV_PLATFORM_SIGNING_P12_BASE64],
  passphrase: process.env[ENV_PLATFORM_SIGNING_P12_PASSPHRASE],
});

export type SigningIdentityErrorCode =
  | "missing" // no secret configured
  | "malformed" // not valid base64 / not a parseable PKCS#12
  | "invalid_passphrase" // PKCS#12 present but passphrase wrong
  | "invalid_material" // missing key/cert, or key/cert mismatch
  | "certificate_expired" // certificate validity window has ended (now > notAfter)
  | "certificate_not_yet_valid" // certificate validity window has not begun (now < notBefore)
  | "invalid_business"; // caller passed an invalid businessId

/** Error that never carries secret material — only a stable code + safe message. */
export class SigningIdentityError extends Error {
  readonly code: SigningIdentityErrorCode;
  constructor(code: SigningIdentityErrorCode, message: string) {
    super(message);
    this.name = "SigningIdentityError";
    this.code = code;
  }
}

function decodeBase64Strict(p12Base64: string): Buffer {
  const cleaned = p12Base64.trim();
  // Node is lenient about base64; re-encode and compare to reject clearly-malformed
  // input rather than silently accepting garbage that yields a bad buffer.
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0 || buf.toString("base64").replace(/=+$/, "") !== cleaned.replace(/=+$/, "")) {
    throw new SigningIdentityError("malformed", "platform signing secret is not valid base64");
  }
  return buf;
}

type ParsedIdentity = {
  metadata: SigningIdentityMetadata;
};

function subjectCommonName(cert: forge.pki.Certificate, which: "subject" | "issuer"): string | null {
  const field = cert[which].getField("CN");
  return field && typeof field.value === "string" ? field.value : null;
}

function certificateFingerprintSha256(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return createHash("sha256").update(Buffer.from(der, "binary")).digest("hex");
}

function privateKeyMatchesCertificate(
  privateKey: forge.pki.rsa.PrivateKey,
  cert: forge.pki.Certificate
): boolean {
  try {
    const derivedPublic = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
    const derivedPem = forge.pki.publicKeyToPem(derivedPublic);
    const certPem = forge.pki.publicKeyToPem(cert.publicKey as forge.pki.rsa.PublicKey);
    return derivedPem === certPem;
  } catch {
    return false;
  }
}

/**
 * Parse + validate the PKCS#12. Wraps node-forge so that NO forge internals or secret
 * bytes escape — only typed, safe errors. Never logs material.
 */
function parseAndValidate(der: Buffer, passphrase: string | undefined): ParsedIdentity {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(der.toString("binary"));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase ?? "");
  } catch {
    // Forge cannot distinguish "wrong passphrase" from "malformed" perfectly; its MAC
    // failure is the common wrong-passphrase signal. We surface a conservative code
    // without echoing the underlying (potentially content-bearing) error.
    throw new SigningIdentityError(
      "invalid_passphrase",
      "platform signing PKCS#12 could not be opened (malformed or wrong passphrase)"
    );
  }

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const keyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
  const cert = certBags.find((b) => b.cert)?.cert;
  const privateKey = keyBags.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;

  if (!cert) {
    throw new SigningIdentityError("invalid_material", "platform signing PKCS#12 has no certificate");
  }
  if (!privateKey) {
    throw new SigningIdentityError("invalid_material", "platform signing PKCS#12 has no private key");
  }
  if (!privateKeyMatchesCertificate(privateKey, cert)) {
    throw new SigningIdentityError(
      "invalid_material",
      "platform signing private key does not match its certificate"
    );
  }

  const metadata: SigningIdentityMetadata = {
    kind: PLATFORM_SIGNING_IDENTITY_KIND,
    certificateSubjectCommonName: subjectCommonName(cert, "subject"),
    certificateIssuerCommonName: subjectCommonName(cert, "issuer"),
    certificateFingerprintSha256: certificateFingerprintSha256(cert),
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
  };
  return { metadata };
}

/**
 * Parse + validate the secret into material + metadata WITHOUT a validity-window gate.
 * Fails closed on missing/malformed/wrong-passphrase/mismatch. This is the inspection
 * layer — it can describe an expired certificate (you must be able to see that it is
 * expired). It is NOT the "provide material for a new signature" path — that is
 * `loadPlatformSigningIdentity`, which additionally enforces the validity window.
 */
function parsePlatformSigningIdentity(
  source: PlatformSigningSecretSource
): { material: SigningMaterial; metadata: SigningIdentityMetadata } {
  const { p12Base64, passphrase } = source();
  if (!p12Base64 || p12Base64.trim().length === 0) {
    throw new SigningIdentityError("missing", "platform signing secret is not configured");
  }
  const der = decodeBase64Strict(p12Base64);
  const { metadata } = parseAndValidate(der, passphrase);
  return {
    material: { p12: der, passphrase },
    metadata,
  };
}

/**
 * Point-in-time validity assessment (X.509 semantics: the window [notBefore, notAfter]
 * is INCLUSIVE of both bounds). Used both to enforce the signing gate and to expose
 * status for audit/diagnostics.
 */
export function assessCertificateValidity(
  metadata: SigningIdentityMetadata,
  now: Date
): CertificateValidityStatus {
  if (now.getTime() < metadata.notBefore.getTime()) return "not_yet_valid";
  if (now.getTime() > metadata.notAfter.getTime()) return "expired";
  return "valid";
}

/**
 * Load the platform signing material for creating a NEW signature. Returns the
 * server-only material + non-secret metadata, or throws `SigningIdentityError`
 * (fail closed).
 *
 * POLICY (Phase 2B-2 hardening): a production signing identity MUST be valid at the
 * moment of use. Beyond missing/malformed/wrong-passphrase/mismatch, this path also
 * FAILS CLOSED when the certificate is `expired` or `not_yet_valid` — Dubiz must not
 * mint new signatures with an out-of-window certificate. (This does NOT invalidate
 * historical PDFs signed while the cert was valid; their embedded certificate stays
 * part of the artifact.) The gate lives here in the identity layer; the generic
 * signer stays identity-agnostic and never knows about validity policy.
 *
 * `opts.now` is injectable for deterministic tests; production defaults to wall-clock.
 */
export function loadPlatformSigningIdentity(
  source: PlatformSigningSecretSource = envSecretSource,
  opts?: { now?: Date }
): { material: SigningMaterial; metadata: SigningIdentityMetadata } {
  const parsed = parsePlatformSigningIdentity(source);
  const now = opts?.now ?? new Date();
  const status = assessCertificateValidity(parsed.metadata, now);
  if (status === "not_yet_valid") {
    throw new SigningIdentityError(
      "certificate_not_yet_valid",
      "platform signing certificate is not yet valid; refusing to create a new signature"
    );
  }
  if (status === "expired") {
    throw new SigningIdentityError(
      "certificate_expired",
      "platform signing certificate has expired; refusing to create a new signature"
    );
  }
  return parsed;
}

/**
 * Inspect the platform signing identity's non-secret metadata (no material returned).
 * Deliberately UNGATED on validity so an expired/not-yet-valid identity can still be
 * examined for audit/diagnostics.
 */
export function describePlatformSigningIdentity(
  source: PlatformSigningSecretSource = envSecretSource
): SigningIdentityMetadata {
  return parsePlatformSigningIdentity(source).metadata;
}

/**
 * Production resolver implementing the Phase 2A `SigningIdentityResolver` seam.
 * Tenant-neutral in v1: validates `businessId` (future contract) but returns the same
 * platform material for every tenant. Fails closed — including on expired/not-yet-valid
 * certificates — and never yields test material.
 *
 * `opts.now` is injectable for deterministic tests; production defaults to wall-clock.
 */
export function createPlatformSigningIdentityResolver(
  source: PlatformSigningSecretSource = envSecretSource,
  opts?: { now?: () => Date }
): SigningIdentityResolver {
  const nowFn = opts?.now ?? (() => new Date());
  return {
    async resolveSigningIdentity(businessId: number): Promise<SigningMaterial> {
      if (!Number.isInteger(businessId) || businessId <= 0) {
        throw new SigningIdentityError("invalid_business", "resolveSigningIdentity requires a positive integer businessId");
      }
      return loadPlatformSigningIdentity(source, { now: nowFn() }).material;
    },
  };
}
