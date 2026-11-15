/**
 * Service Desk — ACTOR and APPROVER, one server-side place. SERVER-ONLY. (Migration 20261130090000.)
 *
 *   Actor     the authenticated user who performed the action (the session principal; journal / record actorUserId).
 *   Approver  the authorized user who approved a sensitive exception (open debt at a handover or a completion, the loaner
 *             still out at a handover). Stored in its own column, next to the actor — never assumed to be the same column.
 *
 * Rules:
 *   1. The approver is NEVER taken from the request. The HTTP edge refuses any identity-shaped field in a JSON body
 *      (assertNoClientIdentity → 400 IDENTITY_NOT_ACCEPTED); the service builds every action from named fields only.
 *   2. resolveApproval(principal, kind) is the only way to obtain an ApprovalGrant (module-private brand: a plain object —
 *      e.g. parsed from JSON — is never a grant). Today it grants only to the authenticated session user, and only when
 *      that user holds the authority the kind requires (APPROVAL_POLICY). Owner decision ש5: no staff accounts — every
 *      authenticated user of a business is its owner, so the authority is BUSINESS_OWNER.
 *   3. Until an independent approver verification exists (an approval performed in the approver's OWN authenticated
 *      session), approver === actor. Enforced here (approverFor), and in the database at INSERT
 *      (SERVICE_APPROVER_NOT_ACTOR in service_handover_record_guard / service_completion_guard), so not even a bug in
 *      this layer can attribute an approval to another user. The business of the approver is checked by the database
 *      trigger service_user_same_business (and the FK refuses a user that does not exist).
 *   4. Who / when / what / why: approver column + approval time (transaction time) + the amount / exception on the same
 *      immutable row + the reason column; the case journal event of the same transaction records the actor.
 *
 * Extension (staff accounts, other permissions) without rewriting callers: give the principal a role, map it in
 * authorityOf, tighten APPROVAL_POLICY; a second-session approval flow adds a grant basis (e.g. "APPROVER_SESSION",
 * backed by its own stored approval row) and relaxes the two database guards in a migration — the columns already hold
 * two identities.
 */
import { SERVICE_APPROVAL_KINDS, type ServiceApprovalKind } from "./contracts";
import { ServiceDeskError } from "./service-desk-errors";

export type ServiceApprovalPrincipal = { readonly businessId: number; readonly userId: number };

/** Who may approve. Today the only authority there is (owner decision ש5); staff roles extend this union. */
export type ServiceAuthority = "BUSINESS_OWNER";

export const APPROVAL_POLICY: Readonly<Record<ServiceApprovalKind, { authority: ServiceAuthority; table: string; approver: string; at: string; reason: string }>> = {
  HANDOVER_OPEN_DEBT: { authority: "BUSINESS_OWNER", table: "ServiceHandover", approver: "debtApprovedByUserId", at: "debtApprovedAt", reason: "debtOverrideReason" },
  HANDOVER_OPEN_LOANER: { authority: "BUSINESS_OWNER", table: "ServiceHandover", approver: "loanerApprovedByUserId", at: "loanerApprovedAt", reason: "loanerOverrideReason" },
  COMPLETION_OPEN_DEBT: { authority: "BUSINESS_OWNER", table: "ServiceCompletion", approver: "debtApprovedByUserId", at: "debtApprovedAt", reason: "debtOverrideReason" },
  // migration 20261201090000 (loans): the case exit with a loan OUT is recorded on each OUT loan's journal (the loan stays OUT);
  // the lending exception and the close of an unreturned loan on the loan row (+ its event). The database refuses an approver
  // other than the actor on each (SERVICE_APPROVER_NOT_ACTOR).
  CANCEL_OPEN_LOANER: { authority: "BUSINESS_OWNER", table: "ServiceLoanEvent", approver: "approvedByUserId", at: "occurredAt", reason: "reason" },
  ABANDON_OPEN_LOANER: { authority: "BUSINESS_OWNER", table: "ServiceLoanEvent", approver: "approvedByUserId", at: "occurredAt", reason: "reason" },
  LEND_OUTSIDE_WORK: { authority: "BUSINESS_OWNER", table: "ServiceLoan", approver: "lendApprovedByUserId", at: "lendApprovedAt", reason: "lendExceptionReason" },
  LOAN_CLOSE_UNRETURNED: { authority: "BUSINESS_OWNER", table: "ServiceLoan", approver: "closeApprovedByUserId", at: "closeApprovedAt", reason: "closeNote" },
};

const GRANT: unique symbol = Symbol("ServiceApprovalGrant");
/** Every grant resolveApproval issued — identity, not shape: a copy (spread, JSON, structuredClone) is never in it. */
const ISSUED = new WeakSet<object>();

/** A server-resolved approval. Only resolveApproval makes one; frozen. */
export interface ApprovalGrant {
  readonly kind: ServiceApprovalKind;
  readonly businessId: number;
  readonly actorUserId: number;
  readonly approverUserId: number;
  /** SAME_SESSION: the authenticated user who acts approves in the same request (the only basis today). */
  readonly basis: "SAME_SESSION";
  readonly [GRANT]: true;
}

const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/** The authority the principal holds. Owner decision ש5: every authenticated user of a business is its owner. */
export function authorityOf(p: ServiceApprovalPrincipal): ServiceAuthority | null {
  return isPositiveInt(p.businessId) && isPositiveInt(p.userId) ? "BUSINESS_OWNER" : null;
}

export function resolveApproval(p: ServiceApprovalPrincipal, kind: ServiceApprovalKind): ApprovalGrant {
  if (!(SERVICE_APPROVAL_KINDS as readonly string[]).includes(kind)) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "APPROVAL_KIND" });
  const held = authorityOf(p);
  if (held === null || held !== APPROVAL_POLICY[kind].authority) throw new ServiceDeskError("APPROVAL_NOT_AUTHORIZED", { approval: kind });
  const grant: ApprovalGrant = Object.freeze({ kind, businessId: p.businessId, actorUserId: p.userId, approverUserId: p.userId, basis: "SAME_SESSION" as const, [GRANT]: true as const });
  ISSUED.add(grant);
  return grant;
}

/** Every approval a decision needs, resolved for this principal (fails before anything is written). */
export function resolveApprovals(p: ServiceApprovalPrincipal, needs: readonly ServiceApprovalKind[]): readonly ApprovalGrant[] {
  return needs.map((k) => resolveApproval(p, k));
}

export function isApprovalGrant(g: unknown): g is ApprovalGrant {
  return typeof g === "object" && g !== null && ISSUED.has(g);
}

/**
 * The approver to store for `kind`, or null when the decision needs no such approval. Fail closed: a needed approval
 * without a genuine grant, a grant of another business / actor, or (today) an approver other than the actor refuses.
 */
export function approverFor(
  grants: readonly ApprovalGrant[] | undefined,
  needs: readonly ServiceApprovalKind[],
  kind: ServiceApprovalKind,
  actor: { businessId: number; userId: number },
): number | null {
  if (!needs.includes(kind)) return null;
  const g = (grants ?? []).find((x) => isApprovalGrant(x) && x.kind === kind);
  // the grant is this actor's, in this business; SAME_SESSION means its approver is its actor (until a second-session basis exists)
  if (!g || g.businessId !== actor.businessId || g.actorUserId !== actor.userId || (g.basis === "SAME_SESSION" && g.approverUserId !== g.actorUserId)) {
    throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "APPROVAL_GRANTED", approval: kind });
  }
  return g.approverUserId;
}

// ── The request never names a user ──────────────────────────────────────────────────────────────────────────

/**
 * A JSON body field that would name an identity: who acts, who approved, which user / business. None of the Service
 * Desk routes takes one — identities come from the session only — so any such key, at any depth, is refused (never
 * silently ignored: a forged identity is visible as a 400). Legitimate ids (customerId, staffMemberId, billingDocumentId,
 * supplierId …) and the customer-side free-text names (receivedByName, confirmedByName) do not match.
 */
const IDENTITY_EXACT = new Set(["userId", "userIds", "user", "businessId", "principal", "session", "onBehalfOf", "impersonate"]);
/** camelCase identity prefixes: the next character is upper case or the key ends (snake_case data keys such as QA item keys never match). */
const IDENTITY_PREFIX = /^(approver|approvedBy|approval[A-Z][a-z]*By|actor|decidedBy|sentBy|returnedBy|linkedBy|unlinkedBy|createdBy|presentedBy|confirmedByUser)([A-Z]|$)/;
const IDENTITY_SNAKE = new Set(["user_id", "business_id", "actor_id", "actor_user_id", "approver_id", "approver_user_id", "approved_by", "approved_by_user_id"]);

export function isIdentityField(key: string): boolean {
  return IDENTITY_EXACT.has(key) || /UserIds?$/.test(key) || IDENTITY_PREFIX.test(key) || IDENTITY_SNAKE.has(key.toLowerCase());
}

export function assertNoClientIdentity(value: unknown, path = "body", depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoClientIdentity(v, `${path}[${i}]`, depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isIdentityField(k)) throw new ServiceDeskError("IDENTITY_NOT_ACCEPTED", { field: `${path}.${k}` });
    assertNoClientIdentity(v, `${path}.${k}`, depth + 1);
  }
}

// ── Inventory: every sensitive Service Desk action, and whether it stores an approver ───────────────────────

export type SensitiveActionClass =
  /** an exception to a protective rule — stored with actor AND approver (APPROVAL_POLICY) */
  | "APPROVER_STORED"
  /** the owner's own decision with a reason — the actor (session user) is recorded; no second identity exists to store */
  | "ACTOR_DECIDES"
  /** the CUSTOMER decides; the owner records it — the actor is the recorder, the customer's answer is the decision */
  | "CUSTOMER_DECIDES_OWNER_RECORDS";

export const SENSITIVE_ACTIONS: Readonly<Record<string, { class: SensitiveActionClass; recordedIn: string; approval?: ServiceApprovalKind }>> = {
  "case:DELIVER with an open debt": { class: "APPROVER_STORED", recordedIn: "ServiceHandover (v2) + case event", approval: "HANDOVER_OPEN_DEBT" },
  "case:DELIVER with the loaner out": { class: "APPROVER_STORED", recordedIn: "ServiceHandover (v2) + case event", approval: "HANDOVER_OPEN_LOANER" },
  "case:COMPLETE with an open debt": { class: "APPROVER_STORED", recordedIn: "ServiceCompletion + case event", approval: "COMPLETION_OPEN_DEBT" },
  "case:DELIVER / COMPLETE (no exception)": { class: "ACTOR_DECIDES", recordedIn: "ServiceHandover / ServiceCompletion.actorUserId + case event" },
  "case:CANCEL / ABANDON (reason)": { class: "ACTOR_DECIDES", recordedIn: "ServiceCase.cancelReason / abandonReason + case event actorUserId" },
  "case:CANCEL with a loan out": { class: "APPROVER_STORED", recordedIn: "ServiceLoanEvent CASE_EXIT_APPROVED (per OUT loan, bound to the case event) + case event", approval: "CANCEL_OPEN_LOANER" },
  "case:ABANDON with a loan out": { class: "APPROVER_STORED", recordedIn: "ServiceLoanEvent CASE_EXIT_APPROVED (per OUT loan, bound to the case event) + case event", approval: "ABANDON_OPEN_LOANER" },
  "loan:LEND outside the work statuses (OPEN / SCHEDULED / READY)": { class: "APPROVER_STORED", recordedIn: "ServiceLoan.lendApprovedByUserId / lendApprovedAt / lendExceptionReason + LENT event", approval: "LEND_OUTSIDE_WORK" },
  "loan:CLOSE_UNRETURNED (lost / kept / written off)": { class: "APPROVER_STORED", recordedIn: "ServiceLoan.closeApprovedByUserId / closeApprovedAt / closeNote + CLOSED event", approval: "LOAN_CLOSE_UNRETURNED" },
  "loan:LEND / RETURN / CHANGE_EXPECTED_RETURN": { class: "ACTOR_DECIDES", recordedIn: "ServiceLoan.lentByUserId / returnedByUserId + loan event actorUserId" },
  "case:CHANGE_DETAILS (reason)": { class: "ACTOR_DECIDES", recordedIn: "ServiceCaseDetailChange.actorUserId + case event" },
  "case:CLOSE": { class: "ACTOR_DECIDES", recordedIn: "case event actorUserId" },
  "case:after-sale resolution (incl. CREDIT)": { class: "ACTOR_DECIDES", recordedIn: "case event actorUserId; the credit note itself is a Billing document" },
  "quote:APPROVE / REJECT": { class: "CUSTOMER_DECIDES_OWNER_RECORDS", recordedIn: "ServiceQuote.decidedByUserId + approvalMethod + case event" },
  "charge:RECORD_CHARGE (correction / NO_CHARGE, reason)": { class: "ACTOR_DECIDES", recordedIn: "ServiceCaseCharge.actorUserId + reason" },
  "billing:UNLINK (reason)": { class: "ACTOR_DECIDES", recordedIn: "ServiceCaseBillingLink.unlinkedByUserId + unlinkReason" },
  "part:WRITE_OFF (reason)": { class: "ACTOR_DECIDES", recordedIn: "ServicePartEvent.actorUserId + reason" },
  "part:CORRECT_COST (reason)": { class: "ACTOR_DECIDES", recordedIn: "ServicePartEvent.actorUserId + reason" },
  "external:CORRECT_FINAL_COST (reason)": { class: "ACTOR_DECIDES", recordedIn: "ServiceExternalWorkEvent.actorUserId + reason" },
  "settings:update": { class: "ACTOR_DECIDES", recordedIn: "ServiceSettingsEvent.actorUserId" },
};
