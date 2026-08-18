/**
 * PDF signature verification harness (Phase 2A).
 *
 * Independent of the signer/library: it parses the signed PDF's signature
 * dictionary directly (/ByteRange, /Contents), reconstructs the byte-range that the
 * signature covers, parses the embedded PKCS#7/CMS, and verifies BOTH:
 *   (1) the CMS signed-attributes signature (with the embedded certificate), and
 *   (2) that the `messageDigest` attribute equals SHA-256 over the covered bytes.
 *
 * (2) is what makes tamper detection real: flip any covered byte → digest mismatch
 * → verification fails. Server-side only; used by tests. No Billing/DB/env.
 */
import forge from "node-forge";

const MESSAGE_DIGEST_OID = "1.2.840.113549.1.9.4";

export type SignatureVerification = {
  valid: boolean;
  reason?: string;
  hasSignatureDict: boolean;
  byteRange?: [number, number, number, number];
  digestAlgorithm?: string;
  signatureAlgorithm?: string;
  signerCommonName?: string;
  certificatePem?: string;
};

function parseByteRange(pdf: Buffer): [number, number, number, number] | null {
  const m = pdf.toString("latin1").match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

function parseContentsHex(pdf: Buffer): string | null {
  // /Contents <hex...> — take the hex blob following the ByteRange placeholder.
  const m = pdf.toString("latin1").match(/\/Contents\s*<([0-9A-Fa-f]+)>/);
  return m ? m[1] : null;
}

function oidOf(node: forge.asn1.Asn1): string | null {
  try {
    return forge.asn1.derToOid(node.value as string);
  } catch {
    return null;
  }
}

/** Verify a signed PDF. Returns a structured result; never throws on a bad signature. */
export function verifySignedPdf(signedPdf: Buffer): SignatureVerification {
  const byteRange = parseByteRange(signedPdf);
  const contentsHex = parseContentsHex(signedPdf);
  const hasSignatureDict =
    signedPdf.includes("/Type /Sig") || signedPdf.includes("/Type/Sig") || (byteRange !== null && contentsHex !== null);

  if (!byteRange || !contentsHex) {
    return { valid: false, reason: "no signature dictionary (ByteRange/Contents)", hasSignatureDict };
  }

  try {
    const [a, b, c, d] = byteRange;
    // The bytes the signature covers: everything except the /Contents hex placeholder.
    const covered = Buffer.concat([signedPdf.subarray(a, a + b), signedPdf.subarray(c, c + d)]);

    // Parse the CMS (PKCS#7) from /Contents.
    const der = forge.util.hexToBytes(contentsHex.replace(/(00)+$/i, "")); // strip zero padding
    const p7Asn1 = forge.asn1.fromDer(forge.util.createBuffer(der));
    const msg = forge.pkcs7.messageFromAsn1(p7Asn1) as forge.pkcs7.PkcsSignedData;

    const cert = msg.certificates?.[0];
    if (!cert) return { valid: false, reason: "no certificate in CMS", hasSignatureDict, byteRange };

    const raw = (msg as unknown as { rawCapture: Record<string, unknown> }).rawCapture;
    const authAttrs = raw.authenticatedAttributes as forge.asn1.Asn1[] | undefined;
    const signature = raw.signature as string | undefined;
    if (!authAttrs || !authAttrs.length || typeof signature !== "string") {
      return { valid: false, reason: "CMS missing signed attributes/signature", hasSignatureDict, byteRange };
    }

    // (2) messageDigest attribute must equal SHA-256 over the covered bytes.
    const md = forge.md.sha256.create();
    md.update(covered.toString("binary"));
    const expectedDigest = md.digest().getBytes();

    let attrDigest: string | null = null;
    for (const attr of authAttrs) {
      const seq = attr.value as forge.asn1.Asn1[];
      if (oidOf(seq[0]) === MESSAGE_DIGEST_OID) {
        const set = seq[1].value as forge.asn1.Asn1[];
        attrDigest = set[0].value as string;
        break;
      }
    }
    if (attrDigest === null) {
      return { valid: false, reason: "no messageDigest attribute", hasSignatureDict, byteRange };
    }
    const digestMatches = attrDigest === expectedDigest;

    // (1) verify the RSA signature over the DER of the authenticated-attributes SET.
    const attrSet = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SET,
      true,
      authAttrs
    );
    const attrDer = forge.asn1.toDer(attrSet).getBytes();
    const sigMd = forge.md.sha256.create();
    sigMd.update(attrDer);
    let sigValid = false;
    try {
      sigValid = (cert.publicKey as forge.pki.rsa.PublicKey).verify(sigMd.digest().getBytes(), signature);
    } catch {
      sigValid = false;
    }

    const cn = cert.subject.getField("CN")?.value as string | undefined;

    return {
      valid: sigValid && digestMatches,
      reason: sigValid ? (digestMatches ? undefined : "messageDigest mismatch (tampered)") : "signature invalid",
      hasSignatureDict: true,
      byteRange,
      digestAlgorithm: "sha256",
      signatureAlgorithm: "RSA",
      signerCommonName: cn,
      certificatePem: forge.pki.certificateToPem(cert),
    };
  } catch (err) {
    return { valid: false, reason: `verify error: ${(err as Error).message}`, hasSignatureDict, byteRange: byteRange ?? undefined };
  }
}
