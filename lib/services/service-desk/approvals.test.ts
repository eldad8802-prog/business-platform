/**
 * Service Desk — actor and approver (migration 20261130090000), pure. Run:
 *   node node_modules/tsx/dist/cli.mjs lib/services/service-desk/approvals.test.ts
 *
 *   C  the core names every exception that needs an approval (DELIVER open debt / loaner out, COMPLETE open debt) and
 *      the handover record it judged (debt and overpayment apart, never both, UNKNOWN never recorded)
 *   G  resolveApproval: granted only to the session principal holding the owner authority; frozen, branded grants —
 *      a plain / JSON object, another business's or another actor's grant is never accepted (approverFor fails closed)
 *   B  the HTTP edge refuses identity fields in a body at any depth (approverId, approvedBy, actorUserId …) and keeps the
 *      legitimate ones (customerId, staffMemberId, receivedByName, confirmedByName, snake_case QA item keys)
 *   I  the inventory classifies every approval kind and stores each one's approver column
 */
import { evaluateTransition } from "./service-case.core";
import { APPROVAL_POLICY, SENSITIVE_ACTIONS, approverFor, assertNoClientIdentity, isApprovalGrant, isIdentityField, resolveApproval, resolveApprovals, type ApprovalGrant } from "./approvals";
import { SERVICE_APPROVAL_KINDS, type ServiceCaseActor, type ServiceCaseContext, type ServiceTransitionDecision } from "./contracts";
import { ServiceDeskError } from "./service-desk-errors";
import { jsonBody, serviceDeskRoute } from "./service-desk-http";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failures += 1;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const code = (f: () => unknown): string => {
  try { f(); return "OK"; } catch (e) { return e instanceof ServiceDeskError ? `${e.code}:${JSON.stringify(e.details)}` : `THROW:${(e as Error).message}`; }
};

const OWNER: ServiceCaseActor = { kind: "OWNER", userId: 70 };
function ctx(o: Partial<ServiceCaseContext> = {}): ServiceCaseContext {
  return {
    kind: "IN_SHOP", status: "READY", holdReason: null, outcome: "REPAIRED", version: 3, staffMemberId: 5, siteId: null, coverage: null,
    currentQuote: null, intake: { conditionRecorded: true, accessoriesRecorded: true, customerSigned: true }, qaChecklistCompleted: true,
    openPartReservations: 0, openLoaner: false, pickupRemindersSent: 0, cancellationRequested: false, settlement: { known: true, openBalanceAgorot: 0 },
    ...o,
  };
}
const T3: NonNullable<ServiceCaseContext["track"]> = {
  track: "T3", workType: "REPAIR", location: "AT_CUSTOMER", itemAtBusiness: false,
  requirements: { intakeConfirmation: "NONE", workApproval: "BY_D15", qa: { mode: "OPTIONAL", template: "FIELD.v1" }, completion: "OWNER_CONFIRMATION", handoverByOwner: false },
  afterSaleResolution: null, siteAddressSet: true, moneyCommitment: false, creditDocumentLinked: false,
};
const deliver = { type: "DELIVER" as const, receipt: { handoverConfirmed: true } };
type Ok = Extract<ServiceTransitionDecision, { ok: true }>;
const okd = (d: ServiceTransitionDecision): Ok | null => (d.ok ? d : null);

console.log("C — the core names the approvals and the handover record");
{
  const d = okd(evaluateTransition(ctx(), deliver, OWNER));
  check("C1 DELIVER, settled: no approval, record 0 / 0", !!d && d.approvals.length === 0 && d.handover?.openBalanceAgorot === 0 && d.handover.overpaidAgorot === 0 && !d.handover.debtApproved && !d.handover.loanerApproved);
  const debt = okd(evaluateTransition(ctx({ settlement: { known: true, openBalanceAgorot: 12_000 } }), { ...deliver, debtOverride: { reason: " ישלם מחר " } }, OWNER));
  check("C2 DELIVER, open debt + reason: HANDOVER_OPEN_DEBT, reason trimmed, record states the debt",
    !!debt && debt.approvals.join() === "HANDOVER_OPEN_DEBT" && debt.texts.debtOverrideReason === "ישלם מחר" && debt.handover?.openBalanceAgorot === 12_000 && debt.handover.debtApproved);
  const noReason = evaluateTransition(ctx({ settlement: { known: true, openBalanceAgorot: 12_000 } }), deliver, OWNER);
  check("C3 DELIVER, open debt, no decision → refused (no approval can stand in for it)", !noReason.ok && noReason.violations.some((v) => v.code === "OPEN_BALANCE_NEEDS_OWNER_DECISION"));
  const over = okd(evaluateTransition(ctx({ settlement: { known: true, openBalanceAgorot: 0, overpaidAgorot: 700 } }), deliver, OWNER));
  check("C4 DELIVER, overpaid: stated apart (700), debt 0, no approval — never a silent zero", !!over && over.handover?.overpaidAgorot === 700 && over.handover.openBalanceAgorot === 0 && over.approvals.length === 0 && over.event.payload.overpaidAgorot === 700);
  const both = evaluateTransition(ctx({ settlement: { known: true, openBalanceAgorot: 100, overpaidAgorot: 700 } }), { ...deliver, debtOverride: { reason: "x" } }, OWNER);
  check("C5 DELIVER, debt AND overpayment → refused as malformed", !both.ok);
  const unknown = evaluateTransition(ctx({ settlement: { known: false } }), { ...deliver, debtOverride: { reason: "x" } }, OWNER);
  check("C6 DELIVER, UNKNOWN balance → BALANCE_UNKNOWN even with a debt reason", !unknown.ok && unknown.violations.some((v) => v.code === "BALANCE_UNKNOWN"));
  const loaner = okd(evaluateTransition(ctx({ openLoaner: true }), { ...deliver, loanerOverride: { reason: "יחזיר מחר" } }, OWNER));
  check("C7 DELIVER, loaner out + reason: HANDOVER_OPEN_LOANER", !!loaner && loaner.approvals.join() === "HANDOVER_OPEN_LOANER" && loaner.handover?.loanerApproved === true);
  const two = okd(evaluateTransition(ctx({ openLoaner: true, settlement: { known: true, openBalanceAgorot: 5 } }), { ...deliver, debtOverride: { reason: "a" }, loanerOverride: { reason: "b" } }, OWNER));
  check("C8 DELIVER, both exceptions: two approvals, one per exception", !!two && [...two.approvals].sort().join() === "HANDOVER_OPEN_DEBT,HANDOVER_OPEN_LOANER");
  const loanerNo = evaluateTransition(ctx({ openLoaner: true }), deliver, OWNER);
  check("C9 DELIVER, loaner out, no decision → OPEN_LOANER", !loanerNo.ok && loanerNo.violations.some((v) => v.code === "OPEN_LOANER"));
  const wc = { kind: "FIELD" as const, status: "WORK_DONE" as const, outcome: "REPAIRED" as const, track: T3 };
  const complete = { type: "COMPLETE" as const, completion: { completionType: "OWNER_CONFIRMED_ON_SITE" as const, ownerConfirmed: true } };
  const cd = okd(evaluateTransition(ctx({ ...wc, settlement: { known: true, openBalanceAgorot: 9_000 } }), { ...complete, debtOverride: { reason: "סוף חודש" } }, OWNER));
  check("C10 COMPLETE, open debt + reason: COMPLETION_OPEN_DEBT", !!cd && cd.approvals.join() === "COMPLETION_OPEN_DEBT" && cd.completion?.debtApproved === true);
  const cz = okd(evaluateTransition(ctx({ ...wc }), complete, OWNER));
  check("C11 COMPLETE, settled: no approval", !!cz && cz.approvals.length === 0);
  const other = okd(evaluateTransition(ctx({ status: "IN_REPAIR", outcome: null }), { type: "FINISH_REPAIR" }, OWNER));
  check("C12 any other action: approvals [] and no handover record", !!other && other.approvals.length === 0 && other.handover === undefined);
}

console.log("G — grants: server-resolved, branded, never from the request");
{
  const p = { businessId: 7, userId: 70 };
  const g = resolveApproval(p, "HANDOVER_OPEN_DEBT");
  check("G1 the grant names the session user as actor AND approver, basis SAME_SESSION, frozen", g.actorUserId === 70 && g.approverUserId === 70 && g.businessId === 7 && g.basis === "SAME_SESSION" && Object.isFrozen(g) && isApprovalGrant(g));
  check("G2 approverFor returns the approver for a needed kind", approverFor([g], ["HANDOVER_OPEN_DEBT"], "HANDOVER_OPEN_DEBT", p) === 70);
  check("G3 approverFor: a kind that is not needed → null (no approver stored without the exception)", approverFor([g], [], "HANDOVER_OPEN_DEBT", p) === null);
  check("G4 a needed approval without any grant → SERVER_CHECK_FAILED", code(() => approverFor([], ["HANDOVER_OPEN_DEBT"], "HANDOVER_OPEN_DEBT", p)).startsWith("SERVER_CHECK_FAILED"));
  const forged = { kind: "HANDOVER_OPEN_DEBT", businessId: 7, actorUserId: 70, approverUserId: 99, basis: "SAME_SESSION" } as unknown as ApprovalGrant;
  check("G5 a forged plain object naming another approver → refused", code(() => approverFor([forged], ["HANDOVER_OPEN_DEBT"], "HANDOVER_OPEN_DEBT", p)).startsWith("SERVER_CHECK_FAILED"));
  const fromJson = JSON.parse(JSON.stringify(g)) as ApprovalGrant;
  check("G6 a grant round-tripped through JSON (as a request would carry it) is not a grant", !isApprovalGrant(fromJson) && code(() => approverFor([fromJson], ["HANDOVER_OPEN_DEBT"], "HANDOVER_OPEN_DEBT", p)).startsWith("SERVER_CHECK_FAILED"));
  const spread = Object.freeze({ ...g, approverUserId: 99 }) as ApprovalGrant;
  check("G7 a real grant copied with another approver → refused (approver must be the actor)", code(() => approverFor([spread], ["HANDOVER_OPEN_DEBT"], "HANDOVER_OPEN_DEBT", p)).startsWith("SERVER_CHECK_FAILED"));
  const otherBiz = resolveApproval({ businessId: 8, userId: 70 }, "HANDOVER_OPEN_DEBT");
  check("G8 a grant of another business → refused", code(() => approverFor([otherBiz], ["HANDOVER_OPEN_DEBT"], "HANDOVER_OPEN_DEBT", p)).startsWith("SERVER_CHECK_FAILED"));
  const otherActor = resolveApproval({ businessId: 7, userId: 71 }, "HANDOVER_OPEN_DEBT");
  check("G9 a grant resolved for another user of the same business → refused for this actor", code(() => approverFor([otherActor], ["HANDOVER_OPEN_DEBT"], "HANDOVER_OPEN_DEBT", p)).startsWith("SERVER_CHECK_FAILED"));
  const wrongKind = resolveApproval(p, "HANDOVER_OPEN_LOANER");
  check("G10 a grant of another kind does not cover the debt", code(() => approverFor([wrongKind], ["HANDOVER_OPEN_DEBT"], "HANDOVER_OPEN_DEBT", p)).startsWith("SERVER_CHECK_FAILED"));
  check("G11 no authority (no session user) → APPROVAL_NOT_AUTHORIZED", code(() => resolveApproval({ businessId: 7, userId: 0 }, "HANDOVER_OPEN_DEBT")).startsWith("APPROVAL_NOT_AUTHORIZED"));
  check("G12 an unknown kind → refused", code(() => resolveApproval(p, "WRITE_OFF" as never)).startsWith("SERVER_CHECK_FAILED"));
  check("G13 resolveApprovals resolves every need, in order", resolveApprovals(p, ["HANDOVER_OPEN_DEBT", "HANDOVER_OPEN_LOANER"]).map((x) => x.kind).join() === "HANDOVER_OPEN_DEBT,HANDOVER_OPEN_LOANER");
  const same = Object.freeze({ ...g }) as ApprovalGrant;
  check("G15 a frozen copy of a REAL grant (the symbol brand copied by the spread) is still not a grant", !isApprovalGrant(same) && code(() => approverFor([same], ["HANDOVER_OPEN_DEBT"], "HANDOVER_OPEN_DEBT", p)).startsWith("SERVER_CHECK_FAILED"));
  check("G14 a grant cannot be mutated", code(() => { (g as { approverUserId: number }).approverUserId = 99; }) !== "OK" || g.approverUserId === 70);
}

console.log("B — the request never names an identity");
{
  for (const k of ["approverId", "approverUserId", "approvedBy", "approvedByUserId", "debtApprovedByUserId", "loanerApprovedByUserId", "actorUserId", "actor",
    "userId", "businessId", "decidedByUserId", "sentByUserId", "createdByUserId", "approver_id", "approved_by", "user_id", "onBehalfOf"]) {
    check(`B1 identity field refused: ${k}`, isIdentityField(k));
  }
  for (const k of ["customerId", "staffMemberId", "defaultStaffMemberId", "billingDocumentId", "supplierId", "deviceId", "appointmentId",
    "receivedByName", "confirmedByName", "reason", "debtOverride", "loanerOverride", "actor_check", "replaced_parts_handled", "health_check_recorded", "expectedVersion"]) {
    check(`B2 legitimate field kept: ${k}`, !isIdentityField(k));
  }
  const body = { expectedVersion: 3, action: { type: "DELIVER", receipt: { handoverConfirmed: true }, debtOverride: { reason: "x", approvedByUserId: 99 } } };
  check("B3 nested (action.debtOverride.approvedByUserId) → IDENTITY_NOT_ACCEPTED naming the path",
    code(() => assertNoClientIdentity(body)) === `IDENTITY_NOT_ACCEPTED:${JSON.stringify({ field: "body.action.debtOverride.approvedByUserId" })}`);
  check("B4 inside an array → refused", code(() => assertNoClientIdentity({ results: [{ key: "a", approverId: 1 }] })).startsWith("IDENTITY_NOT_ACCEPTED"));
  check("B5 a clean DELIVER body passes", code(() => assertNoClientIdentity({ expectedVersion: 3, action: { type: "DELIVER", receipt: { handoverConfirmed: true, receivedByName: "דנה" }, debtOverride: { reason: "x" } } })) === "OK");
  check("B6 a QA results map with snake_case keys passes", code(() => assertNoClientIdentity({ results: { actor_check: true, replaced_parts_handled: false } })) === "OK");
}

async function http() {
  console.log("B — the HTTP edge (serviceDeskRoute + jsonBody, session injected)");
  const post = (body: unknown) => new Request("http://lab.invalid/api/service-desk/cases/1/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const deps = { user: async () => ({ id: 70, businessId: 7 }), mode: async () => "FULL" as const };
  let seen: { businessId: number; userId: number } | null = null;
  const handler = async ({ principal }: { principal: { businessId: number; userId: number } }) => { await jsonBody(reqNow); seen = principal; return new Response("{}"); };
  let reqNow = post({ action: { type: "DELIVER", receipt: { handoverConfirmed: true }, debtOverride: { reason: "x" }, approverUserId: 99 }, expectedVersion: 3 });
  let res = await serviceDeskRoute(reqNow, "write", handler, deps);
  const j = (await res.json()) as { error?: string; details?: { field?: string } };
  check("B7 POST with action.approverUserId → 400 IDENTITY_NOT_ACCEPTED, the handler never ran", res.status === 400 && j.error === "IDENTITY_NOT_ACCEPTED" && j.details?.field === "body.action.approverUserId" && seen === null);
  reqNow = post({ action: { type: "COMPLETE" }, expectedVersion: 3, actorUserId: 99, businessId: 8 });
  res = await serviceDeskRoute(reqNow, "write", handler, deps);
  check("B8 POST with top-level actorUserId / businessId → 400, nothing done", res.status === 400 && seen === null);
  reqNow = post({ action: { type: "CLOSE" }, expectedVersion: 3 });
  res = await serviceDeskRoute(reqNow, "write", handler, deps);
  check("B9 a clean body: the principal is the session's (business 7, user 70)", res.status === 200 && seen !== null && (seen as { userId: number }).userId === 70 && (seen as { businessId: number }).businessId === 7);
}

console.log("I — inventory");
{
  check("I1 every approval kind has a policy with the owner authority and its own approver column",
    // (the loan journal — 20261201090000 — names its approver "approvedByUserId" and the approval time is the event's "occurredAt")
    SERVICE_APPROVAL_KINDS.every((k) => APPROVAL_POLICY[k].authority === "BUSINESS_OWNER" && /(^a|A)pprovedByUserId$/.test(APPROVAL_POLICY[k].approver)
      && (/ApprovedAt$/.test(APPROVAL_POLICY[k].at) || (APPROVAL_POLICY[k].table === "ServiceLoanEvent" && APPROVAL_POLICY[k].at === "occurredAt"))));
  check("I1b the four loan approvals (20261201090000) are recorded on the loan or its journal",
    (["CANCEL_OPEN_LOANER", "ABANDON_OPEN_LOANER", "LEND_OUTSIDE_WORK", "LOAN_CLOSE_UNRETURNED"] as const).every((k) => /^ServiceLoan(Event)?$/.test(APPROVAL_POLICY[k].table)));
  const stored = Object.values(SENSITIVE_ACTIONS).filter((a) => a.class === "APPROVER_STORED").map((a) => a.approval).sort();
  check("I2 the inventory's APPROVER_STORED entries are exactly the approval kinds", stored.join() === [...SERVICE_APPROVAL_KINDS].sort().join());
  check("I3 the inventory names quote approval as the customer's decision, recorded by the owner", SENSITIVE_ACTIONS["quote:APPROVE / REJECT"]?.class === "CUSTOMER_DECIDES_OWNER_RECORDS");
}

http().then(() => {
  console.log(`\n${total - failures} passed, ${failures} failed, ${total} checks`);
  if (failures > 0) process.exit(1);
}).catch((e) => { console.error(e); process.exit(1); });
