/**
 * Central bucket configuration — the single source of truth for Documents
 * rate limits. Thresholds here are the P1-approved values (proposed, pending
 * production log confirmation of which threshold trips first). Tune limits here
 * WITHOUT touching limiter logic.
 *
 * Fail mode is hybrid by design:
 * - UPLOAD_ACCEPT / DOCUMENT_PROCESSING -> fail-closed (controlled 503 on a
 *   Redis blip). We never silently fall back to in-memory for writes.
 * - DOCUMENTS_API (reads) -> fail-open (do not break document viewing on a
 *   transient Redis blip), but the degradation is logged + recorded.
 */

import type { BucketConfig, BucketName } from "./types";

export const BUCKETS: Record<BucketName, BucketConfig> = {
  // Fast acceptance gate for the upload request. Keyed by user AND business.
  UPLOAD_ACCEPT: {
    failMode: "closed",
    rules: [
      { scope: "user", limit: 30, windowSeconds: 60 },
      { scope: "user", limit: 300, windowSeconds: 60 * 60 },
      { scope: "business", limit: 120, windowSeconds: 60 },
      { scope: "business", limit: 2000, windowSeconds: 24 * 60 * 60 },
    ],
  },
  // Admission control for the OCR / extraction work. In P1 this is checked
  // inline right before the OCR call; in P2 it relocates verbatim to the
  // background worker's dequeue step (same bucket, same semantics).
  DOCUMENT_PROCESSING: {
    failMode: "closed",
    rules: [
      { scope: "business", limit: 60, windowSeconds: 60 },
      { scope: "global", limit: 600, windowSeconds: 60 },
    ],
  },
  // Regular Documents read API (inbox / list). Keyed by user.
  DOCUMENTS_API: {
    failMode: "open",
    rules: [{ scope: "user", limit: 120, windowSeconds: 60 }],
  },
  // Inbound WhatsApp media intake. The webhook is public and (by the Bot-MVP-1
  // design) accepts media from non-allowlisted senders in a conversation, so
  // this caps OCR/cost abuse per business. Fail-OPEN: a Redis blip must not drop
  // legitimate inbound documents (Meta does not retry a 200 response).
  WHATSAPP_INTAKE: {
    failMode: "open",
    rules: [{ scope: "business", limit: 120, windowSeconds: 60 }],
  },
  // CRM attachment uploads (customer card, later supplier). A write path, so
  // fail-CLOSED on a backend blip. Conservative — attachments are heavier and
  // rarer than a chat message; keyed by user AND business.
  CRM_ATTACHMENT_UPLOAD: {
    failMode: "closed",
    rules: [
      { scope: "user", limit: 20, windowSeconds: 60 },
      { scope: "user", limit: 100, windowSeconds: 60 * 60 },
      { scope: "business", limit: 60, windowSeconds: 60 },
      { scope: "business", limit: 500, windowSeconds: 24 * 60 * 60 },
    ],
  },
  // Bulk import execution. The heaviest write path in the product: one accepted
  // request can create up to 10,000 records. Deliberately the tightest bucket
  // here, because a real owner imports a file a handful of times, not a hundred
  // — and fail-CLOSED, since "the limiter is down" must never become "write
  // without limit".
  //
  // A retry after a transient failure resumes the SAME run and re-executes
  // nothing, so a low limit costs a legitimate owner nothing.
  DATA_TRANSFER_IMPORT_EXECUTE: {
    failMode: "closed",
    rules: [
      { scope: "user", limit: 5, windowSeconds: 60 },
      { scope: "user", limit: 40, windowSeconds: 60 * 60 },
      { scope: "business", limit: 10, windowSeconds: 60 },
      { scope: "business", limit: 100, windowSeconds: 24 * 60 * 60 },
    ],
  },
};
