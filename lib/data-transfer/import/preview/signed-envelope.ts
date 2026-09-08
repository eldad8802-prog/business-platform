/**
 * The signed envelope every data-transfer attestation is built from.
 *
 * Extracted from `preview-token.ts` when historical import needed an
 * attestation of its own. Two envelopes with the same construction is fine;
 * two IMPLEMENTATIONS of that construction is how one of them quietly stops
 * comparing in constant time.
 *
 * # What an envelope guarantees, stated honestly
 *
 * It is SIGNED, not encrypted. The payload is base64url and anyone holding one
 * can read it. What the signature buys is:
 *
 *   integrity      the facts cannot be edited
 *   authenticity   they were asserted by this server
 *   expiry         the assertion stops being usable
 *   binding        it belongs to whatever the facts say it belongs to
 *
 * NOT confidentiality. Which is why a payload must never carry row values.
 *
 * # Purpose separation
 *
 * The signing key is DERIVED from `AUTH_TOKEN_SECRET` with a per-purpose label,
 * so an envelope minted for one purpose can never validate for another — an
 * auth bearer token cannot be a preview token, and a tabular preview token
 * cannot be a historical one. That is a property of the key derivation, not of
 * a field somebody remembered to check.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export class SignedEnvelopeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedEnvelopeConfigError";
  }
}

export type EnvelopeSpec = {
  /** Key-derivation label. Distinct per envelope kind. */
  keyLabel: string;
  /** Recorded in the payload and checked on verify. */
  purpose: string;
  /** Payload version. A change invalidates every envelope in flight. */
  version: number;
  /** Lifetime in seconds. */
  ttlSeconds: number;
};

type Envelope<F> = F & {
  v: number;
  purpose: string;
  nonce: string;
  iat: number;
  exp: number;
};

function signingKey(label: string): Buffer {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) {
    throw new SignedEnvelopeConfigError("AUTH_TOKEN_SECRET is not configured");
  }
  return createHmac("sha256", secret).update(label).digest();
}

export function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromB64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

/** Mint an envelope carrying `facts`. */
export function signEnvelope<F extends object>(
  spec: EnvelopeSpec,
  facts: F,
  now: Date = new Date()
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: Envelope<F> = {
    ...facts,
    v: spec.version,
    purpose: spec.purpose,
    nonce: randomBytes(12).toString("hex"),
    iat,
    exp: iat + spec.ttlSeconds,
  };
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(createHmac("sha256", signingKey(spec.keyLabel)).update(body).digest());
  return `${body}.${mac}`;
}

export type EnvelopeFailure = "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "WRONG_PURPOSE";

export type EnvelopeResult<F> =
  | { ok: true; facts: F; expiresAt: Date }
  | { ok: false; reason: EnvelopeFailure };

/**
 * Verify an envelope. Fails closed on anything unexpected.
 *
 * The signature is compared in constant time, and it is compared BEFORE the
 * payload is parsed for anything — so a forged envelope never reaches a
 * business check.
 */
export function verifyEnvelope<F extends object>(
  spec: EnvelopeSpec,
  token: unknown,
  now: Date = new Date()
): EnvelopeResult<Envelope<F>> {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "MALFORMED" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "MALFORMED" };

  const [body, mac] = parts;
  const expected = createHmac("sha256", signingKey(spec.keyLabel)).update(body).digest();
  const provided = fromB64url(mac);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let payload: Envelope<F>;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }

  if (payload?.v !== spec.version || payload?.purpose !== spec.purpose) {
    return { ok: false, reason: "WRONG_PURPOSE" };
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now.getTime()) {
    return { ok: false, reason: "EXPIRED" };
  }

  return { ok: true, facts: payload, expiresAt: new Date(payload.exp * 1000) };
}
