/**
 * The attestation of a completed historical preview.
 *
 * Built on the SAME envelope the tabular preview token uses — one HMAC
 * construction, one constant-time comparison, one derivation from
 * `AUTH_TOKEN_SECRET`. What differs is the key label, which is what makes the
 * two kinds mutually unusable: a tabular preview token cannot be presented as a
 * historical one, and the reason is the key rather than a field somebody
 * remembered to check.
 *
 * # What it binds, and why each one is there
 *
 *   businessId, userId   whose decisions these are
 *   domain               historical-documents, and only that
 *   contentHash          the exact bytes analyzed
 *   sheetName            which worksheet of them
 *   mappingHash          which columns meant what
 *   dateFormat           how textual dates were read — this decides which
 *                        month a document falls in, so a token minted under
 *                        one reading must not authorise the other
 *   analysisHash         the whole file-side analysis identity
 *   rowCount             how many rows the owner was shown
 *   decisionsHash        what they chose
 *   evidenceFingerprint  what the DATABASE said at the time
 *
 * The last one is the difference from the tabular token. A historical preview's
 * conclusions depend on records that already exist, and a record inserted
 * between preview and execution would change what confirming means without
 * changing a byte of the file. Binding the read-set fingerprint is what lets
 * Execute notice.
 *
 * # What it must never contain
 *
 * The envelope is signed, not encrypted: anyone holding a token can read it.
 * So no customer name, no tax id, no amount, no document number, no row. Only
 * hashes, counts and identifiers — every actual value is re-derived from the
 * re-submitted file at execution time.
 */

import {
  signEnvelope,
  verifyEnvelope,
  type EnvelopeSpec,
} from "@/lib/data-transfer/import/preview/signed-envelope";
import { IMPORT_PREVIEW_TTL_SECONDS } from "@/lib/data-transfer/import/import-config";
import type { DateFormatContract } from "@/lib/data-transfer/historical/historical-date";

const SPEC: EnvelopeSpec = {
  keyLabel: "dubiz-data-transfer-historical-preview-v1",
  purpose: "data-transfer-historical-preview",
  version: 1,
  ttlSeconds: IMPORT_PREVIEW_TTL_SECONDS,
};

export type HistoricalPreviewFacts = {
  businessId: number;
  userId: number;
  /** Always the historical domain. Checked, not assumed. */
  domain: "historical-documents";
  contentHash: string;
  sheetName: string | null;
  mappingHash: string;
  dateFormat: DateFormatContract;
  analysisHash: string;
  rowCount: number;
  decisionsHash: string;
  /** SHA-256 of the historical records the analysis matched. */
  evidenceFingerprint: string;
};

export function issueHistoricalPreviewToken(
  facts: HistoricalPreviewFacts,
  now: Date = new Date()
): string {
  return signEnvelope(SPEC, facts, now);
}

export type HistoricalPreviewTokenResult =
  | { ok: true; facts: HistoricalPreviewFacts; expiresAt: Date }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "WRONG_PURPOSE" };

export function verifyHistoricalPreviewToken(
  token: unknown,
  now: Date = new Date()
): HistoricalPreviewTokenResult {
  const envelope = verifyEnvelope<HistoricalPreviewFacts>(SPEC, token, now);
  if (!envelope.ok) return { ok: false, reason: envelope.reason };

  const payload = envelope.facts;
  // The envelope proved these facts are ours and unaltered. Whether they are
  // the SHAPE this token promises is a separate question, asked here.
  if (
    !Number.isInteger(payload.businessId) ||
    payload.businessId <= 0 ||
    !Number.isInteger(payload.userId) ||
    payload.userId <= 0 ||
    payload.domain !== "historical-documents" ||
    typeof payload.contentHash !== "string" ||
    typeof payload.mappingHash !== "string" ||
    typeof payload.analysisHash !== "string" ||
    typeof payload.decisionsHash !== "string" ||
    typeof payload.evidenceFingerprint !== "string" ||
    !Number.isInteger(payload.rowCount)
  ) {
    return { ok: false, reason: "MALFORMED" };
  }

  return {
    ok: true,
    facts: {
      businessId: payload.businessId,
      userId: payload.userId,
      domain: "historical-documents",
      contentHash: payload.contentHash,
      sheetName: payload.sheetName ?? null,
      mappingHash: payload.mappingHash,
      dateFormat: payload.dateFormat ?? null,
      analysisHash: payload.analysisHash,
      rowCount: payload.rowCount,
      decisionsHash: payload.decisionsHash,
      evidenceFingerprint: payload.evidenceFingerprint,
    },
    expiresAt: envelope.expiresAt,
  };
}
