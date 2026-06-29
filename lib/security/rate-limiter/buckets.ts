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
};
