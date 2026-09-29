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

  // ── Authentication (security closure, workstream B) ────────────────────────
  //
  // Every auth bucket is fail-CLOSED and requires all of its identifiers. "The
  // limiter is down" must never become "unlimited password guessing", and a
  // rule that is skipped because an identifier was not passed is not a rule.
  //
  // The numbers are conservative defaults and an OWNER POLICY DECISION: tune
  // here, never in the routes. The per-account rules stop a distributed guess
  // against one owner; they are looser than the per-(account, IP) rule so that
  // spraying one victim from many addresses cannot lock them out as cheaply.

  // Before the body is parsed: pure per-address flood control (10/min is the
  // value the login route enforced before this change).
  AUTH_LOGIN_IP: {
    failMode: "closed",
    requireAllIdentifiers: true,
    rules: [
      { scope: "ip", limit: 10, windowSeconds: 60 },
      { scope: "ip", limit: 100, windowSeconds: 60 * 60 },
    ],
  },
  // After the address is known. Keyed by the NORMALIZED email whether or not an
  // account exists, so throttling itself is not an enumeration oracle.
  AUTH_LOGIN_ACCOUNT: {
    failMode: "closed",
    requireAllIdentifiers: true,
    rules: [
      { scope: "account_ip", limit: 5, windowSeconds: 60 },
      { scope: "account", limit: 20, windowSeconds: 15 * 60 },
      { scope: "account", limit: 100, windowSeconds: 24 * 60 * 60 },
    ],
  },
  // Changing a password proves the current one — so it is a guessing surface.
  AUTH_PASSWORD_CHANGE: {
    failMode: "closed",
    requireAllIdentifiers: true,
    rules: [
      { scope: "user", limit: 5, windowSeconds: 15 * 60 },
      { scope: "ip", limit: 20, windowSeconds: 60 * 60 },
    ],
  },
  // Step-up re-proves the password before a destructive action.
  AUTH_STEP_UP: {
    failMode: "closed",
    requireAllIdentifiers: true,
    rules: [
      { scope: "user", limit: 5, windowSeconds: 5 * 60 },
      { scope: "ip", limit: 30, windowSeconds: 60 * 60 },
    ],
  },
  // Reset requests send mail to an inbox: tight per account, and per address so
  // one client cannot fan out across many accounts.
  AUTH_PASSWORD_RESET_REQUEST: {
    failMode: "closed",
    requireAllIdentifiers: true,
    rules: [
      { scope: "account", limit: 3, windowSeconds: 60 * 60 },
      { scope: "ip", limit: 10, windowSeconds: 60 * 60 },
    ],
  },
  AUTH_PASSWORD_RESET_CONFIRM: {
    failMode: "closed",
    requireAllIdentifiers: true,
    rules: [{ scope: "ip", limit: 10, windowSeconds: 60 * 60 }],
  },
  // Admin MFA enrollment requires an out-of-band bootstrap code; this caps
  // guessing it with a stolen admin bearer.
  ADMIN_MFA_ENROLL: {
    failMode: "closed",
    requireAllIdentifiers: true,
    rules: [
      { scope: "user", limit: 5, windowSeconds: 60 * 60 },
      { scope: "ip", limit: 20, windowSeconds: 60 * 60 },
    ],
  },
};
