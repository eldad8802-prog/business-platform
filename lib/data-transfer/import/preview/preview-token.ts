/**
 * Preview attestation — a signed, stateless envelope.
 *
 * After an owner reviews a mapping and a preview, this token records WHAT was
 * analyzed: which business, which user, which domain, which exact file bytes,
 * which exact mapping, which sheet, how many rows. I-6 will be able to demand
 * it and re-derive every one of those facts from the re-submitted file.
 *
 * Modelled directly on `billing-authority-signed-state.service.ts` — the same
 * purpose-separated HMAC over `AUTH_TOKEN_SECRET`, so there is no new secret
 * and an envelope minted for another purpose can never validate here.
 *
 * # What this guarantees, stated honestly
 *
 * The envelope is SIGNED, not encrypted. The payload is base64url and anyone
 * holding the token can read it. What the signature buys is:
 *
 *   integrity      the facts cannot be edited
 *   authenticity   they were asserted by this server
 *   expiry         the assertion stops being usable
 *   binding        it belongs to one business, user, domain, file and mapping
 *
 * NOT confidentiality. Which is why the payload carries no rows, no sample
 * values, no uploaded data and no business records — only hashes and counts.
 *
 * # Known limit, deliberately left for I-6
 *
 * A stateless signed token is REPLAYABLE while it is valid. That is acceptable
 * here because preview is read-only: replaying it re-reads. It is NOT
 * acceptable for execution, where a replay would double-create records. Before
 * I-6 mutates anything, idempotency / consumed-state / retry semantics have to
 * be decided explicitly. This module does not pretend to solve that, and no DB
 * model or Redis key was added on the assumption that it will.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { IMPORT_PREVIEW_TTL_SECONDS } from "@/lib/data-transfer/import/import-config";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";

const VERSION = 1;
const PURPOSE = "data-transfer-import-preview";
const KEY_DERIVATION_LABEL = "dubiz-data-transfer-import-preview-v1";

export class PreviewTokenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewTokenConfigError";
  }
}

export type PreviewTokenFacts = {
  businessId: number;
  userId: number;
  domain: DataTransferDomainId;
  /** SHA-256 of the exact uploaded bytes. */
  contentHash: string;
  /** SHA-256 of the canonicalized finalized mapping. */
  mappingHash: string;
  /** Worksheet the data was read from; null for CSV. */
  sheetName: string | null;
  /** Data rows considered (header excluded). */
  rowCount: number;
};

type PreviewTokenPayload = PreviewTokenFacts & {
  v: number;
  purpose: string;
  nonce: string;
  iat: number;
  exp: number;
};

function signingKey(): Buffer {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) {
    throw new PreviewTokenConfigError("AUTH_TOKEN_SECRET is not configured");
  }
  // Purpose-separated derivation: an auth bearer token or the ITA OAuth state
  // can never validate here, and this can never validate there.
  return createHmac("sha256", secret).update(KEY_DERIVATION_LABEL).digest();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

/** SHA-256 hex — used for both the file bytes and the canonical mapping. */
export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Mint an attestation for a completed preview. */
export function issuePreviewToken(
  facts: PreviewTokenFacts,
  now: Date = new Date()
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: PreviewTokenPayload = {
    ...facts,
    v: VERSION,
    purpose: PURPOSE,
    nonce: randomBytes(12).toString("hex"),
    iat,
    exp: iat + IMPORT_PREVIEW_TTL_SECONDS,
  };
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(createHmac("sha256", signingKey()).update(body).digest());
  return `${body}.${mac}`;
}

export type PreviewTokenResult =
  | { ok: true; facts: PreviewTokenFacts; expiresAt: Date }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "WRONG_PURPOSE" };

/**
 * Verify an attestation. Fails closed on anything unexpected.
 *
 * The signature is compared in constant time, and it is compared BEFORE the
 * payload is trusted for anything — so a forged token never reaches the
 * business checks.
 */
export function verifyPreviewToken(
  token: unknown,
  now: Date = new Date()
): PreviewTokenResult {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "MALFORMED" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "MALFORMED" };

  const [body, mac] = parts;
  const expected = createHmac("sha256", signingKey()).update(body).digest();
  const provided = fromB64url(mac);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let payload: PreviewTokenPayload;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }

  if (payload?.v !== VERSION || payload?.purpose !== PURPOSE) {
    return { ok: false, reason: "WRONG_PURPOSE" };
  }
  if (
    typeof payload.exp !== "number" ||
    payload.exp * 1000 <= now.getTime()
  ) {
    return { ok: false, reason: "EXPIRED" };
  }
  if (
    !Number.isInteger(payload.businessId) ||
    payload.businessId <= 0 ||
    !Number.isInteger(payload.userId) ||
    payload.userId <= 0 ||
    typeof payload.contentHash !== "string" ||
    typeof payload.mappingHash !== "string" ||
    !Number.isInteger(payload.rowCount)
  ) {
    return { ok: false, reason: "MALFORMED" };
  }

  return {
    ok: true,
    facts: {
      businessId: payload.businessId,
      userId: payload.userId,
      domain: payload.domain,
      contentHash: payload.contentHash,
      mappingHash: payload.mappingHash,
      sheetName: payload.sheetName ?? null,
      rowCount: payload.rowCount,
    },
    expiresAt: new Date(payload.exp * 1000),
  };
}
