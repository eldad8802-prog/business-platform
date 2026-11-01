/**
 * TEMPORARY, PREVIEW-ONLY, ONE-SHOT: issue ONE pre-seeded synthetic DRAFT tax
 * invoice of lab business 9 and let the existing post-commit flow send ONE
 * SANDBOX Approval (allocation-number request) through the Kamatera egress
 * (#36423501).
 *
 * The real product path runs unchanged (issueBillingDocument → submission READY
 * → executeAuthorityApproval → one POST, no retry, 401/timeout = uncertain),
 * inside runWithAuthorityApprovalAllowance(): the only scope in which the
 * OAuth-only egress block admits a POST to the SANDBOX Approval endpoint, once.
 * InvoiceDecision, validation and token refresh stay refused.
 *
 * SAFETY (every fuse before any write and any network I/O)
 *   - Access limits: ticket hash + run window pinned at push. NOT a
 *     deployment-wide single-use guarantee; the single attempt rests on the
 *     controlled operator (one request, no retry).
 *   - Preview + egress branch, SANDBOX runtime, gateway origin, and the
 *     resolved Approval URL must equal the exact SANDBOX endpoint.
 *   - Target pinned: document id (filled at push), business 9, TAX_INVOICE,
 *     DRAFT, ILS, subtotal ≥ the ITA threshold, VAT > 0, line descriptions
 *     ≤ 30 chars, customer with a digits-only tax id of an eligible type,
 *     complete issuer identity with a digits-only tax id, issuer kind
 *     AUTHORIZED_DEALER or LTD_COMPANY (never an exempt dealer).
 *   - Connection 2 CONNECTED with an access token valid ≥ 10 more minutes — a
 *     refresh would be refused inside this scope, so it is required up front —
 *     and authorized (OAuth) inside the pinned window: only a token from the
 *     new invoices_scope OAuth of this run is accepted.
 *   - Prior submissions: business 9 must hold exactly the run-1 submission
 *     (id 1 on document 1, SUBMITTED, uncertain authentication) and nothing
 *     else; document 1 can never be the target. Run 1 stays resend-blocked.
 *   - Preflight mode (x-oneshot-mode: preflight): runs every fuse and reports
 *     the resolved endpoint; never issues, never consumes the instance latch.
 *   - Output: classes, statuses, internal codes, flags and the allocation
 *     number — never a token, secret or raw provider body.
 *
 * THROWAWAY: removed by a revert in the coordinated cleanup order.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  AUTHORITY_EGRESS_APPROVAL_HOST,
  AUTHORITY_EGRESS_APPROVAL_PATH,
  isAuthorityEgressError,
  resolveAuthorityEgressConfig,
  runWithAuthorityApprovalAllowance,
  type ApprovalAllowance,
} from "@/lib/services/billing/authority/billing-authority-egress";
import {
  buildAuthorityApiBaseUrl,
  resolveAuthorityEnvConfig,
} from "@/lib/services/billing/authority/billing-authority-env.service";
import { buildInvoiceApprovalUrl } from "@/lib/services/billing/authority/billing-authority-approval-client.config";
import { APPROVAL_API_VERSION } from "@/lib/services/billing/authority/billing-authority-approval-config.provider";
import { getAuthorityAllocationThresholdIls } from "@/lib/services/billing/authority/billing-authority-threshold";
import { issueBillingDocument } from "@/lib/services/billing/billing-issue.service";
import { isBillingIdentityComplete } from "@/lib/billing/business-identity";
import { prisma } from "@/lib/prisma";

export const APPROVAL_ONESHOT_BRANCH = "feat/ita-authority-egress";
export const APPROVAL_ONESHOT_GATEWAY_ORIGIN = "https://91.223.106.183";
export const APPROVAL_ONESHOT_URL = `https://${AUTHORITY_EGRESS_APPROVAL_HOST}${AUTHORITY_EGRESS_APPROVAL_PATH}`;
export const APPROVAL_ONESHOT_BUSINESS_ID = 9;
export const APPROVAL_ONESHOT_ACTOR_USER_ID = 2;
export const APPROVAL_ONESHOT_CONNECTION_ID = 2;
/** Run 1 (2026-11-01 10:11Z, HTTP 401): the only submission allowed to exist. Never re-sent. */
export const APPROVAL_ONESHOT_PRIOR_SUBMISSIONS: readonly PriorSubmission[] = [
  { id: 1, billingDocumentId: 1, status: "SUBMITTED", errorCode: "AUTHORITY_OUTCOME_UNCERTAIN_AUTHENTICATION" },
];
const BLOCKED_DOCUMENT_IDS = [1];
const MIN_TOKEN_VALIDITY_MS = 10 * 60_000;
const ELIGIBLE_CUSTOMER_TAX_ID_TYPES = ["AUTHORIZED_DEALER", "LTD_COMPANY"];
const ELIGIBLE_ISSUER_KINDS = ["AUTHORIZED_DEALER", "LTD_COMPANY"];
/** Pinned at push. Placeholders refuse every call. */
export const APPROVAL_ONESHOT_DOCUMENT_ID = "2";
export const APPROVAL_ONESHOT_TICKET_SHA256 = "b54820259d88c594fafccfcdf81fdd1d45e76bf6cebb8ea04291a303f71fe277";
export const APPROVAL_ONESHOT_NOT_BEFORE = "2026-11-01T18:02:30.234Z";
export const APPROVAL_ONESHOT_NOT_AFTER = "2026-11-01T19:32:30.234Z";

export type ApprovalOneshotOutcome =
  | "APPROVED"
  | "REJECTED"
  | "HELD"
  | "NOT_SENT"
  | "UNCERTAIN"
  | "NOT_EXECUTED" // issued, submission still READY (e.g. token unavailable) — no POST
  | "NO_SUBMISSION" // issued but no READY submission was created
  | "ISSUE_FAILED"
  | "PREFLIGHT_OK"
  | "REFUSED_BY_FUSE";

export type DocumentSnapshot = {
  id: number;
  businessId: number;
  documentType: string;
  status: string;
  currency: string;
  subtotalAmount: number;
  vatAmount: number;
  customerId: number | null;
  lineDescriptions: string[];
};
export type CustomerSnapshot = { taxId: string | null; taxIdType: string | null };
export type ProfileSnapshot = Record<string, string | null> | null;
export type ConnectionSnapshot = { id: number; status: string; accessTokenPresent: boolean; accessTokenExpiresAt: Date | null; oauthAuthorizedAt: Date | null } | null;
export type PriorSubmission = { id: number; billingDocumentId: number; status: string; errorCode: string | null };
export type SubmissionSnapshot = { status: string; errorCode: string | null; retryCount: number; allocationNumber: string | null } | null;

export type ApprovalOneshotDeps = {
  env?: Readonly<Record<string, string | undefined>>;
  ticket?: string | null;
  mode?: "preflight" | "run";
  now?: () => number;
  /** Test seams only. */
  pinned?: { documentId: string; ticketSha256: string; notBefore: string; notAfter: string };
  gatewayOrigin?: string;
  resolveApprovalUrl?: () => string;
  loadDocument?: (id: number) => Promise<DocumentSnapshot | null>;
  loadCustomer?: (id: number) => Promise<CustomerSnapshot | null>;
  loadProfile?: () => Promise<ProfileSnapshot>;
  loadConnection?: () => Promise<ConnectionSnapshot>;
  listSubmissions?: () => Promise<PriorSubmission[]>;
  loadSubmission?: (documentId: number) => Promise<SubmissionSnapshot>;
  issue?: (input: { businessId: number; actorUserId: number; billingDocumentId: number }) => Promise<{ authority: { status: string; errorCode?: string } }>;
};

export type ApprovalOneshotResult = {
  outcome: ApprovalOneshotOutcome;
  fuse: string | null;
  approvalUrl: string | null;
  documentId: number | null;
  tokenValidForMinutes: number | null;
  approvalRequestAdmitted: boolean | null;
  issueAuthorityStatus: string | null;
  issueErrorCode: string | null;
  submission: { status: string; errorCode: string | null; retryCount: number } | null;
  allocationNumber: string | null;
  documentStatusAfter: string | null;
  elapsedMs: number;
};

let used = false;
export function resetApprovalOneshotForTests(): void {
  used = false;
}

const digitsOnly = (v: string | null | undefined) => typeof v === "string" && /^\d{5,12}$/.test(v.trim());

function ticketMatches(ticket: string | null | undefined, expectedHex: string): boolean {
  if (typeof ticket !== "string" || !/^[0-9a-f]{64}$/.test(ticket) || !/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  return timingSafeEqual(createHash("sha256").update(ticket).digest(), Buffer.from(expectedHex, "hex"));
}

const num = (v: unknown) => Number(v);
const defaults = {
  resolveApprovalUrl: () =>
    buildInvoiceApprovalUrl({ apiBaseUrl: buildAuthorityApiBaseUrl(resolveAuthorityEnvConfig("SANDBOX")), apiVersion: APPROVAL_API_VERSION }),
  loadDocument: async (id: number): Promise<DocumentSnapshot | null> => {
    const d = await prisma.billingDocument.findFirst({
      where: { id, businessId: APPROVAL_ONESHOT_BUSINESS_ID },
      select: { id: true, businessId: true, documentType: true, status: true, currency: true, subtotalAmount: true, vatAmount: true, customerId: true, lines: { select: { description: true } } },
    });
    return d
      ? { id: d.id, businessId: d.businessId, documentType: d.documentType, status: d.status, currency: d.currency, subtotalAmount: num(d.subtotalAmount), vatAmount: num(d.vatAmount), customerId: d.customerId, lineDescriptions: d.lines.map((l) => l.description) }
      : null;
  },
  loadCustomer: async (id: number): Promise<CustomerSnapshot | null> =>
    prisma.customer.findFirst({ where: { id, businessId: APPROVAL_ONESHOT_BUSINESS_ID }, select: { taxId: true, taxIdType: true } }) as Promise<CustomerSnapshot | null>,
  loadProfile: async (): Promise<ProfileSnapshot> =>
    prisma.businessProfile.findUnique({
      where: { businessId: APPROVAL_ONESHOT_BUSINESS_ID },
      select: { billingLegalName: true, billingBusinessKind: true, billingTaxId: true, billingAddress: true, billingPhone: true, billingEmail: true },
    }),
  loadConnection: async (): Promise<ConnectionSnapshot> => {
    const c = await prisma.billingAuthorityConnection.findUnique({
      where: { businessId_environment: { businessId: APPROVAL_ONESHOT_BUSINESS_ID, environment: "SANDBOX" } },
      select: { id: true, status: true, accessTokenEncrypted: true, accessTokenExpiresAt: true, oauthAuthorizedAt: true },
    });
    return c ? { id: c.id, status: c.status, accessTokenPresent: !!c.accessTokenEncrypted, accessTokenExpiresAt: c.accessTokenExpiresAt, oauthAuthorizedAt: c.oauthAuthorizedAt } : null;
  },
  listSubmissions: () =>
    prisma.billingAuthoritySubmission.findMany({
      where: { businessId: APPROVAL_ONESHOT_BUSINESS_ID },
      select: { id: true, billingDocumentId: true, status: true, errorCode: true },
      orderBy: { id: "asc" },
    }),
  loadSubmission: async (documentId: number): Promise<SubmissionSnapshot> => {
    const s = await prisma.billingAuthoritySubmission.findFirst({
      where: { businessId: APPROVAL_ONESHOT_BUSINESS_ID, billingDocumentId: documentId },
      select: { status: true, errorCode: true, retryCount: true, allocationNumber: true },
    });
    return s ? { status: s.status, errorCode: s.errorCode, retryCount: s.retryCount, allocationNumber: s.allocationNumber } : null;
  },
  issue: (input: { businessId: number; actorUserId: number; billingDocumentId: number }) => issueBillingDocument(input),
};

export async function runSandboxApprovalOneshot(deps: ApprovalOneshotDeps = {}): Promise<ApprovalOneshotResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const d = { ...defaults, ...Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined)) } as typeof defaults & ApprovalOneshotDeps;
  const pinned = deps.pinned ?? { documentId: APPROVAL_ONESHOT_DOCUMENT_ID, ticketSha256: APPROVAL_ONESHOT_TICKET_SHA256, notBefore: APPROVAL_ONESHOT_NOT_BEFORE, notAfter: APPROVAL_ONESHOT_NOT_AFTER };
  const result: ApprovalOneshotResult = {
    outcome: "REFUSED_BY_FUSE", fuse: null, approvalUrl: null, documentId: null, tokenValidForMinutes: null,
    approvalRequestAdmitted: null, issueAuthorityStatus: null, issueErrorCode: null, submission: null,
    allocationNumber: null, documentStatusAfter: null, elapsedMs: 0,
  };
  const refuse = (fuse: string) => ({ ...result, fuse, elapsedMs: now() - startedAt });

  // ── configuration fuses (no I/O) ──
  if (used) return refuse("ALREADY_RAN_ON_INSTANCE");
  const notBefore = Date.parse(pinned.notBefore);
  const notAfter = Date.parse(pinned.notAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notAfter <= notBefore) return refuse("WINDOW_NOT_SET");
  if (now() < notBefore || now() > notAfter) return refuse("OUTSIDE_WINDOW");
  if (!ticketMatches(deps.ticket, pinned.ticketSha256)) return refuse("TICKET_INVALID");
  const documentId = /^\d{1,9}$/.test(pinned.documentId) ? Number(pinned.documentId) : NaN;
  if (!Number.isInteger(documentId) || documentId <= 0) return refuse("DOCUMENT_NOT_PINNED");
  if (BLOCKED_DOCUMENT_IDS.includes(documentId)) return refuse("DOCUMENT_BLOCKED");
  result.documentId = documentId;
  if (env.VERCEL_ENV !== "preview") return refuse("NOT_PREVIEW");
  if (env.VERCEL_GIT_COMMIT_REF !== APPROVAL_ONESHOT_BRANCH) return refuse("WRONG_BRANCH");
  if (env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT?.trim().toUpperCase() !== "SANDBOX") return refuse("NOT_SANDBOX");
  try {
    if (resolveAuthorityEgressConfig(env, "SANDBOX").proxyUrl !== (deps.gatewayOrigin ?? APPROVAL_ONESHOT_GATEWAY_ORIGIN)) return refuse("GATEWAY_MISMATCH");
  } catch (error) {
    return refuse(`EGRESS_CONFIG:${isAuthorityEgressError(error) ? error.code : "INVALID"}`);
  }
  try {
    result.approvalUrl = d.resolveApprovalUrl();
  } catch {
    return refuse("APPROVAL_URL_UNRESOLVED");
  }
  if (result.approvalUrl !== APPROVAL_ONESHOT_URL) return refuse("APPROVAL_URL_UNEXPECTED");

  // ── data fuses (reads only) ──
  const doc = await d.loadDocument(documentId);
  if (!doc) return refuse("DOCUMENT_NOT_FOUND");
  if (doc.businessId !== APPROVAL_ONESHOT_BUSINESS_ID) return refuse("DOCUMENT_WRONG_BUSINESS");
  if (doc.documentType !== "TAX_INVOICE") return refuse(`DOCUMENT_TYPE:${doc.documentType}`);
  if (doc.status !== "DRAFT") return refuse(`DOCUMENT_STATUS:${doc.status}`);
  if (doc.currency !== "ILS") return refuse("DOCUMENT_CURRENCY");
  if (!(doc.vatAmount > 0)) return refuse("DOCUMENT_NO_VAT");
  if (!(doc.subtotalAmount >= getAuthorityAllocationThresholdIls(new Date(now())))) return refuse("DOCUMENT_BELOW_THRESHOLD");
  if (doc.lineDescriptions.length === 0 || doc.lineDescriptions.some((t) => !t || t.length > 30)) return refuse("DOCUMENT_LINES");
  if (!doc.customerId) return refuse("DOCUMENT_NO_CUSTOMER");
  const customer = await d.loadCustomer(doc.customerId);
  if (!customer || !digitsOnly(customer.taxId) || !ELIGIBLE_CUSTOMER_TAX_ID_TYPES.includes(customer.taxIdType ?? "")) return refuse("CUSTOMER_TAX_ID");
  const profile = await d.loadProfile();
  if (!profile || !isBillingIdentityComplete(profile as never) || !digitsOnly(profile.billingTaxId)) return refuse("ISSUER_IDENTITY");
  // The app's identity gate checks completeness only; a TAX_INVOICE test must
  // never come from an exempt dealer (or any non-VAT-registered kind).
  if (!ELIGIBLE_ISSUER_KINDS.includes(profile.billingBusinessKind ?? "")) return refuse("ISSUER_KIND");
  const connection = await d.loadConnection();
  if (!connection || connection.id !== APPROVAL_ONESHOT_CONNECTION_ID) return refuse("CONNECTION_MISMATCH");
  if (connection.status !== "CONNECTED" && connection.status !== "VALIDATED") return refuse(`CONNECTION_STATUS:${connection.status}`);
  if (!connection.accessTokenPresent || !connection.accessTokenExpiresAt) return refuse("NO_ACCESS_TOKEN");
  result.tokenValidForMinutes = Math.floor((connection.accessTokenExpiresAt.getTime() - now()) / 60_000);
  if (connection.accessTokenExpiresAt.getTime() - now() < MIN_TOKEN_VALIDITY_MS) return refuse("ACCESS_TOKEN_EXPIRES_SOON_REFRESH_NEEDED");
  if (!connection.oauthAuthorizedAt || connection.oauthAuthorizedAt.getTime() < notBefore) return refuse("OAUTH_NOT_IN_WINDOW");
  const prior = await d.listSubmissions();
  const sameAsPinned =
    prior.length === APPROVAL_ONESHOT_PRIOR_SUBMISSIONS.length &&
    prior.every((s, i) => {
      const e = APPROVAL_ONESHOT_PRIOR_SUBMISSIONS[i];
      return s.id === e.id && s.billingDocumentId === e.billingDocumentId && s.status === e.status && s.errorCode === e.errorCode;
    });
  if (!sameAsPinned) return refuse("PRIOR_SUBMISSIONS_MISMATCH");

  if (deps.mode === "preflight") return { ...result, outcome: "PREFLIGHT_OK", elapsedMs: now() - startedAt };

  // ── the single issuance + Approval ──
  used = true;
  const scope: ApprovalAllowance = { approvalUsed: false };
  try {
    const issued = await runWithAuthorityApprovalAllowance(
      () => d.issue({ businessId: APPROVAL_ONESHOT_BUSINESS_ID, actorUserId: APPROVAL_ONESHOT_ACTOR_USER_ID, billingDocumentId: documentId }),
      scope
    );
    result.issueAuthorityStatus = issued.authority.status;
    result.issueErrorCode = issued.authority.errorCode ?? null;
  } catch {
    result.outcome = "ISSUE_FAILED";
  }
  result.approvalRequestAdmitted = scope.approvalUsed;

  const after = await d.loadSubmission(documentId).catch(() => null);
  const docAfter = await d.loadDocument(documentId).catch(() => null);
  result.documentStatusAfter = docAfter?.status ?? null;
  if (after) {
    result.submission = { status: after.status, errorCode: after.errorCode, retryCount: after.retryCount };
    result.allocationNumber = after.allocationNumber;
  }
  if (result.outcome !== "ISSUE_FAILED") {
    const s = after?.status ?? null;
    result.outcome =
      s === "APPROVED" ? "APPROVED"
      : s === "REJECTED" ? "REJECTED"
      : s === "HELD" ? "HELD"
      : s === "FAILED" && (after?.errorCode ?? "").startsWith("AUTHORITY_NOT_SENT_") ? "NOT_SENT"
      : s === "READY" && !scope.approvalUsed ? "NOT_EXECUTED"
      : s === null ? "NO_SUBMISSION"
      : "UNCERTAIN"; // SUBMITTED / uncertain marker / anything unexpected
  } else if (scope.approvalUsed) {
    result.outcome = "UNCERTAIN"; // the POST passed the block, then something threw
  }
  return { ...result, elapsedMs: now() - startedAt };
}
