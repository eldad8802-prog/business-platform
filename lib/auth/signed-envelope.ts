/**
 * Purpose-bound HMAC envelopes (step-up, password reset).
 *
 * Same construction as the admin elevation envelope: HMAC-SHA256 under a
 * PURPOSE-DERIVED subkey of AUTH_TOKEN_SECRET, so an envelope minted for one
 * purpose can never validate as another, nor as a session token. Fails closed
 * when the secret is missing.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export class SignedEnvelopeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedEnvelopeConfigError";
  }
}

function deriveKey(label: string): Buffer {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) throw new SignedEnvelopeConfigError("AUTH_TOKEN_SECRET is not configured");
  return createHmac("sha256", secret).update(label).digest();
}

export function randomNonce(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

export function sealEnvelope(label: string, payload: Record<string, unknown>): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", deriveKey(label)).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

/** The payload, or null for anything not minted by us under `label`. Never throws on input. */
export function openEnvelope(label: string, raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", deriveKey(label)).update(parts[0]).digest();
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
