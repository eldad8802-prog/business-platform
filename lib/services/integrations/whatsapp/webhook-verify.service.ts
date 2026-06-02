import { createHmac, timingSafeEqual } from "node:crypto";

function getVerifyToken(): string | null {
  const v = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getAppSecret(): string | null {
  const v = process.env.WHATSAPP_APP_SECRET;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type VerifySubscribeChallengeResult =
  | { ok: true; challenge: string }
  | { ok: false; reason: "missing_env" | "invalid_mode" | "invalid_token" | "missing_challenge" };

/**
 * Meta GET webhook verification (hub.mode / hub.verify_token / hub.challenge).
 */
export function verifySubscribeChallenge(params: {
  mode: string | null;
  verifyToken: string | null;
  challenge: string | null;
}): VerifySubscribeChallengeResult {
  const expectedToken = getVerifyToken();
  if (!expectedToken) {
    return { ok: false, reason: "missing_env" };
  }

  if (params.mode !== "subscribe") {
    return { ok: false, reason: "invalid_mode" };
  }

  if (!params.challenge || params.challenge.trim().length === 0) {
    return { ok: false, reason: "missing_challenge" };
  }

  if (params.verifyToken !== expectedToken) {
    return { ok: false, reason: "invalid_token" };
  }

  return { ok: true, challenge: params.challenge };
}

export type VerifySignatureResult =
  | { ok: true }
  | { ok: false; reason: "missing_env" | "missing_header" | "invalid_format" | "mismatch" };

/**
 * Validates `X-Hub-Signature-256` against the raw request body (HMAC-SHA256).
 */
export function verifyWebhookSignature(params: {
  rawBody: string;
  signatureHeader: string | null;
}): VerifySignatureResult {
  const secret = getAppSecret();
  if (!secret) {
    return { ok: false, reason: "missing_env" };
  }

  const header = params.signatureHeader?.trim();
  if (!header) {
    return { ok: false, reason: "missing_header" };
  }

  const prefix = "sha256=";
  if (!header.startsWith(prefix)) {
    return { ok: false, reason: "invalid_format" };
  }

  const receivedHex = header.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/i.test(receivedHex)) {
    return { ok: false, reason: "invalid_format" };
  }

  const expectedHex = createHmac("sha256", secret)
    .update(params.rawBody, "utf8")
    .digest("hex");

  const receivedBuf = Buffer.from(receivedHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");

  if (receivedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: "mismatch" };
  }

  if (!timingSafeEqual(receivedBuf, expectedBuf)) {
    return { ok: false, reason: "mismatch" };
  }

  return { ok: true };
}
