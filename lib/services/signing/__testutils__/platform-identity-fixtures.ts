/**
 * ⚠️ TEST ONLY — NOT FOR PRODUCTION ⚠️
 *
 * Disposable PKCS#12 fixtures for exercising the platform signing identity resolver.
 * Generates a fresh, self-signed, CA-less key+cert in-memory and returns it base64-
 * encoded, exactly matching the production secret contract (DUBIZ_SIGNING_P12_BASE64
 * + DUBIZ_SIGNING_P12_PASSPHRASE) so the REAL resolver code path can be tested with
 * throwaway material. No Production key/cert exists here.
 */
import forge from "node-forge";
import { createHash } from "node:crypto";
import type { PlatformSigningSecretSource } from "../platform-signing-identity";

// ASCII-only subject values: node-forge mis-encodes non-ASCII into the PKCS#12 MAC.
const DEFAULT_CN = "Dubiz Platform TEST Signer - NOT FOR PRODUCTION";
const DEFAULT_PASSPHRASE = "test-only-platform-passphrase";

export type DisposableP12Options = {
  commonName?: string;
  passphrase?: string;
  notBefore?: Date;
  notAfter?: Date;
  /** If true, generate a second independent keypair so the cert's key mismatches. */
  mismatchKey?: boolean;
};

export type DisposableP12 = {
  p12Base64: string;
  passphrase: string;
  commonName: string;
  /** Independently-computed SHA-256 fingerprint of the cert DER (hex). */
  fingerprintSha256: string;
  notBefore: Date;
  notAfter: Date;
};

/** Generate a disposable platform-style PKCS#12 as base64 (SHA-256 self-signature). */
export function makeDisposableP12(opts: DisposableP12Options = {}): DisposableP12 {
  const commonName = opts.commonName ?? DEFAULT_CN;
  const passphrase = opts.passphrase ?? DEFAULT_PASSPHRASE;
  const notBefore = opts.notBefore ?? new Date("2026-01-01T00:00:00Z");
  const notAfter = opts.notAfter ?? new Date("2030-01-01T00:00:00Z");

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  // Optionally bind the cert to a DIFFERENT public key to simulate key/cert mismatch.
  cert.publicKey = opts.mismatchKey ? forge.pki.rsa.generateKeyPair(2048).publicKey : keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [
    { name: "commonName", value: commonName },
    { name: "organizationName", value: "Dubiz TEST" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const fingerprintSha256 = createHash("sha256").update(Buffer.from(der, "binary")).digest("hex");

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: "3des" });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  const p12Base64 = Buffer.from(p12Der, "binary").toString("base64");

  return { p12Base64, passphrase, commonName, fingerprintSha256, notBefore, notAfter };
}

/** Build a secret source (as the resolver expects) from a disposable P12. */
export function sourceFrom(p12: DisposableP12): PlatformSigningSecretSource {
  return () => ({ p12Base64: p12.p12Base64, passphrase: p12.passphrase });
}

/** A secret source with an explicit (possibly wrong/missing) passphrase. */
export function sourceWith(p12Base64: string | undefined, passphrase: string | undefined): PlatformSigningSecretSource {
  return () => ({ p12Base64, passphrase });
}
