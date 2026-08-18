/**
 * ⚠️ TEST ONLY — NOT FOR PRODUCTION ⚠️
 *
 * Generates a DISPOSABLE self-signed certificate + private key packaged as a
 * PKCS#12, purely to exercise the signer/verifier in isolation. This material is
 * worthless outside these tests: it is freshly generated in-memory, self-signed,
 * chains to no CA, and is clearly labelled as non-production. It must NEVER be used
 * to sign real Dubiz documents and no Production key/cert lives here.
 */
import forge from "node-forge";
import type { SigningMaterial, SigningIdentityResolver } from "../signing-types";

// ASCII only: node-forge mis-encodes non-ASCII subject values into the PKCS#12
// (breaks the MAC), so keep this label plain-ASCII.
const TEST_CN = "Dubiz TEST Signing - NOT FOR PRODUCTION";
const TEST_PASSPHRASE = "test-only-passphrase";

/** Generate a disposable self-signed cert + key as PKCS#12 (SHA-256 self-signature). */
export function generateTestSigningMaterial(commonName = TEST_CN): SigningMaterial & {
  certificatePem: string;
} {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2030-01-01T00:00:00Z");
  const attrs = [
    { name: "commonName", value: commonName },
    { name: "organizationName", value: "Dubiz TEST" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  // SHA-256 self-signature — explicitly NOT SHA-1.
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
    keys.privateKey,
    [cert],
    TEST_PASSPHRASE,
    { algorithm: "3des" }
  );
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  const p12 = Buffer.from(der, "binary");

  return {
    p12,
    passphrase: TEST_PASSPHRASE,
    certificatePem: forge.pki.certificateToPem(cert),
  };
}

/** Test-only resolver: proves the signer takes injected material and never provisions identity itself. */
export class TestSigningIdentityResolver implements SigningIdentityResolver {
  private readonly material: SigningMaterial;
  constructor(material: SigningMaterial) {
    this.material = material;
  }
  async resolveSigningIdentity(_businessId: number): Promise<SigningMaterial> {
    return this.material;
  }
}

export const TEST_SIGNING_PASSPHRASE = TEST_PASSPHRASE;
