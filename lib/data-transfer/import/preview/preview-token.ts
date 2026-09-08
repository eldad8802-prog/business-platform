/**
 * Preview attestation — a signed, stateless envelope.
 *
 * After an owner reviews a mapping and a preview, this token records WHAT was
 * analyzed and WHAT THEY DECIDED: which business, which user, which domain,
 * which exact file bytes, which exact mapping, which sheet, how many rows, and
 * a digest of the per-row actions. Execute demands it and re-derives every one
 * of those facts from the re-submitted file before it writes anything.
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
 * # Replay, and where it is actually stopped
 *
 * A stateless signed token is REPLAYABLE while it is valid, and this module
 * does not try to stop that. For preview it does not matter: replaying a
 * read-only derivation re-reads. For execution it matters completely, and the
 * defence is not in the token — it is the ImportRun row, unique on
 * (businessId, contentHash, mappingHash, decisionsHash), plus a per-row marker
 * written in the same transaction as each business record. A replayed token
 * therefore lands on an existing run and re-executes nothing.
 *
 * Consuming the token instead would have been strictly worse: it would make a
 * lost response indistinguishable from a completed import, which is precisely
 * the case the ledger resolves.
 */

import { createHash } from "node:crypto";
import {
  SignedEnvelopeConfigError,
  signEnvelope,
  verifyEnvelope,
  type EnvelopeSpec,
} from "@/lib/data-transfer/import/preview/signed-envelope";
import { IMPORT_PREVIEW_TTL_SECONDS } from "@/lib/data-transfer/import/import-config";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";

/**
 * This envelope's identity. The key label is unchanged from the original
 * implementation, so tokens minted before the extraction still verify.
 */
const SPEC: EnvelopeSpec = {
  keyLabel: "dubiz-data-transfer-import-preview-v1",
  purpose: "data-transfer-import-preview",
  version: 1,
  ttlSeconds: IMPORT_PREVIEW_TTL_SECONDS,
};

/** Kept as the name callers already catch; the envelope raises it. */
export const PreviewTokenConfigError = SignedEnvelopeConfigError;

export type PreviewTokenFacts = {
  businessId: number;
  userId: number;
  domain: DataTransferDomainId;
  /** SHA-256 of the exact uploaded bytes. */
  contentHash: string;
  /** SHA-256 of the canonicalized finalized mapping. */
  mappingHash: string;
  /**
   * SHA-256 of the canonicalized per-row decisions the owner confirmed.
   *
   * Part of the run identity, so changing one row's action is a DIFFERENT run
   * rather than a replay of the previous one.
   */
  decisionsHash: string;
  /** Worksheet the data was read from; null for CSV. */
  sheetName: string | null;
  /** Data rows considered (header excluded). */
  rowCount: number;
};

/** SHA-256 hex — used for both the file bytes and the canonical mapping. */
export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Mint an attestation for a completed preview. */
export function issuePreviewToken(
  facts: PreviewTokenFacts,
  now: Date = new Date()
): string {
  return signEnvelope(SPEC, facts, now);
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
  const envelope = verifyEnvelope<PreviewTokenFacts>(SPEC, token, now);
  if (!envelope.ok) return { ok: false, reason: envelope.reason };

  const payload = envelope.facts;
  // The envelope proved the facts are ours and unaltered. It says nothing
  // about whether they are the SHAPE this token promises, so that is checked
  // here rather than assumed.
  if (
    !Number.isInteger(payload.businessId) ||
    payload.businessId <= 0 ||
    !Number.isInteger(payload.userId) ||
    payload.userId <= 0 ||
    typeof payload.contentHash !== "string" ||
    typeof payload.mappingHash !== "string" ||
    typeof payload.decisionsHash !== "string" ||
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
      decisionsHash: payload.decisionsHash,
      sheetName: payload.sheetName ?? null,
      rowCount: payload.rowCount,
    },
    expiresAt: envelope.expiresAt,
  };
}
