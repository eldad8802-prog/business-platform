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
  // M6 acquisition webhooks (Meta / Google / website server posts), after the trusted resolver named
  // the business. Fail-OPEN: a Redis blip must not drop a real lead (the provider would not retry).
  ACQUISITION_INTAKE: {
    failMode: "open",
    rules: [{ scope: "business", limit: 300, windowSeconds: 60 }],
  },
  // M6 website BROWSER posts (a browser cannot keep a secret): per IP and per business, so one
  // visitor cannot flood the leads of a business. Fail-OPEN for the same reason.
  ACQUISITION_WEB_PUBLIC: {
    failMode: "open",
    rules: [
      { scope: "ip", limit: 10, windowSeconds: 60 },
      { scope: "ip", limit: 60, windowSeconds: 60 * 60 },
      { scope: "business", limit: 120, windowSeconds: 60 * 60 },
    ],
  },
  // The accountant's download link (public; the secret travels in the body). Per IP: guessing is cut
  // off long before it could matter (the secret is 256 bits), and an accountant opening the link a few
  // times is never blocked. Fail-CLOSED: a Redis blip must not lift the limit on a public door.
  ACCOUNTANT_LINK_PUBLIC: {
    failMode: "closed",
    rules: [
      { scope: "ip", limit: 20, windowSeconds: 60 },
      { scope: "ip", limit: 120, windowSeconds: 60 * 60 },
    ],
  },
  // One file of the accountant's portal (view / download), after the link already checked out. Per IP, wider
  // than the page itself: an accountant opening every document of a month must not be cut off, while the
  // ceiling still bounds what one address can pull. Fail-CLOSED like the link.
  ACCOUNTANT_LINK_FILE: {
    failMode: "closed",
    rules: [
      { scope: "ip", limit: 90, windowSeconds: 60 },
      { scope: "ip", limit: 900, windowSeconds: 60 * 60 },
    ],
  },
  // The accountant portal's one-time code (G5 M5): requesting a code (an email to the delivery's recipient) and checking
  // one. Per address, on top of the per-delivery limits in lib/accountant/link-device.ts (3 codes / 15 min, 10 / day,
  // 5 attempts a code). Fail-CLOSED: both guard the inbox and the code.
  ACCOUNTANT_LINK_CODE: {
    failMode: "closed",
    rules: [
      { scope: "ip", limit: 6, windowSeconds: 15 * 60 },
      { scope: "ip", limit: 20, windowSeconds: 24 * 60 * 60 },
    ],
  },
  ACCOUNTANT_LINK_VERIFY: {
    failMode: "closed",
    rules: [
      { scope: "ip", limit: 20, windowSeconds: 15 * 60 },
      { scope: "ip", limit: 60, windowSeconds: 24 * 60 * 60 },
    ],
  },
  // Owner send approvals to an external recipient. Fail-CLOSED: sending is the consequential action.
  ACCOUNTANT_SEND: {
    failMode: "closed",
    rules: [
      { scope: "user", limit: 10, windowSeconds: 60 * 60 },
      { scope: "business", limit: 20, windowSeconds: 24 * 60 * 60 },
    ],
  },
  // Public booking (Milestone C, owner decision D11) — the platform's ceilings for the link a business shares. All
  // fail-CLOSED: a Redis outage must never lift the limit on a public door that writes into a business's calendar.
  // Submitting a request: per IP 5 a minute and 20 an hour; per business 60 an hour (values to calibrate in the pilot).
  PUBLIC_BOOKING_SUBMIT: {
    failMode: "closed",
    rules: [
      { scope: "ip", limit: 5, windowSeconds: 60 },
      { scope: "ip", limit: 20, windowSeconds: 60 * 60 },
    ],
  },
  // …and per business, checked once the link has resolved to its business (60 an hour).
  PUBLIC_BOOKING_SUBMIT_BUSINESS: {
    failMode: "closed",
    rules: [{ scope: "business", limit: 60, windowSeconds: 60 * 60 }],
  },
  // Reading the link's page and free times: generous for a person choosing a day, low enough to stop scraping.
  PUBLIC_BOOKING_READ: {
    failMode: "closed",
    rules: [
      { scope: "ip", limit: 60, windowSeconds: 60 },
      { scope: "ip", limit: 600, windowSeconds: 60 * 60 },
    ],
  },
  // A customer's manage link (state / cancel): a token guess is 256 bits; this caps probing all the same.
  PUBLIC_BOOKING_MANAGE: {
    failMode: "closed",
    rules: [
      { scope: "ip", limit: 20, windowSeconds: 60 },
      { scope: "ip", limit: 120, windowSeconds: 60 * 60 },
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
  // Documents batch import — analyze AND execute. It gets its own bucket rather
  // than sharing DATA_TRANSFER_IMPORT_EXECUTE because the two are not the same
  // unit of work: a tabular request costs one file parse and a run of database
  // writes, while one accepted request here costs up to 20 object-storage
  // writes and up to 20 OCR + extraction jobs.
  //
  // Sizing is therefore expressed in DOCUMENTS, not in requests. The daily
  // business ceiling of 25 accepted requests is 500 documents at the 20-file
  // maximum — the same daily document ceiling the single-upload path already
  // enforces through UPLOAD_ACCEPT, so the import centre cannot become a way
  // around it.
  //
  // Fail-CLOSED: a limiter outage must never become "ingest without limit" on
  // the most expensive write path in the product. A retry after a transient
  // failure resumes the SAME run and re-ingests nothing, so a tight limit costs
  // a legitimate owner nothing.
  DATA_TRANSFER_DOCUMENTS_IMPORT: {
    failMode: "closed",
    rules: [
      { scope: "user", limit: 6, windowSeconds: 60 },
      { scope: "user", limit: 30, windowSeconds: 60 * 60 },
      { scope: "business", limit: 10, windowSeconds: 60 },
      { scope: "business", limit: 25, windowSeconds: 24 * 60 * 60 },
    ],
  },
  // P3-C landing blueprint composition: every admitted request may cost one (or, with the single
  // structural repair, two) model calls. Owner-triggered from the internal preview only. Fail-CLOSED:
  // a limiter outage must never become "unbounded model spend".
  LANDING_COMPOSE: {
    failMode: "closed",
    rules: [
      { scope: "user", limit: 6, windowSeconds: 60 },
      { scope: "business", limit: 30, windowSeconds: 60 * 60 },
      { scope: "business", limit: 100, windowSeconds: 24 * 60 * 60 },
      { scope: "global", limit: 600, windowSeconds: 60 * 60 },
    ],
  },
};
