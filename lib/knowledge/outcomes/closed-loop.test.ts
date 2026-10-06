/**
 * Closed Loop · durable evidence + owner view — PURE, deterministic, no database, no model. Run:
 *   npx tsx lib/knowledge/outcomes/closed-loop.test.ts
 *
 * The WHY is captured from domain rows and reconstructable (fingerprint), carries no money and no names; the
 * owner's words are deterministic, hand ACCEPT to the real domain flow, and never claim a cause. Synthetic
 * TEST data only.
 */
import {
  EVIDENCE_REF_CAP,
  EVIDENCE_VERSION,
  evidenceFingerprint,
  overdueInstallmentEvidence,
  parseEvidence,
  reviewBacklogEvidence,
  type InstallmentRow,
  type OverdueInstallmentFacts,
  type ReviewBacklogFacts,
} from "./evidence";
import { buildOwnerView, CAUSAL_PHRASES, handoffFor, type OwnerRecommendationView } from "./owner-view";
import type { OwnerRecommendationRow } from "./outcome-store";
import { planRecommendations } from "./recommend";
import type { RecommendationCandidate, StoredDecision, StoredRecommendation } from "./outcome.contract";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const DAY = 86_400_000;
const T0 = new Date("2026-06-10T09:00:00.000Z");
const at = (d: number) => new Date(T0.getTime() + d * DAY);

/* ── evidence: installment ── */
const inst: InstallmentRow = {
  id: 41, commitmentId: 7, sequence: 2, dueAt: at(-12), status: "SCHEDULED", scheduledAmount: "1200.00",
  allocations: [
    { allocatedAmount: "300.00", reversedAt: null, payment: { status: "RECORDED", voidedAt: null } },
    { allocatedAmount: "900.00", reversedAt: at(-3), payment: { status: "RECORDED", voidedAt: null } }, // reversed
    { allocatedAmount: "900.00", reversedAt: null, payment: { status: "VOIDED", voidedAt: at(-2) } }, // voided
  ],
};
const e1 = overdueInstallmentEvidence(inst, "HIGH", T0);
const f1 = e1.facts as OverdueInstallmentFacts;
ok("installment evidence: kind, version, refs to installment + commitment",
  e1.kind === "OVERDUE_INSTALLMENT" && e1.evidenceVersion === EVIDENCE_VERSION &&
  JSON.stringify(e1.evidenceRefs) === JSON.stringify([{ store: "Installment", id: 41 }, { store: "Commitment", id: 7 }]));
ok("installment evidence: due date and days overdue as of capture", f1.dueAt === at(-12).toISOString() && f1.daysOverdue === 12);
ok("installment evidence: only LIVE allocations count (reversed and voided ones do not) → PARTIAL", f1.coverage === "PARTIAL");
ok("installment evidence: no live allocation → NONE",
  (overdueInstallmentEvidence({ ...inst, allocations: [] }, null, T0).facts as OverdueInstallmentFacts).coverage === "NONE");
ok("installment evidence: NO money is stored (M9 never writes amounts)",
  !/amount|1200|300|900|currency/i.test(JSON.stringify(e1.facts)));
ok("installment evidence: deterministic", overdueInstallmentEvidence(inst, "HIGH", T0).factFingerprint === e1.factFingerprint);
ok("installment evidence: a different fact is a different fingerprint",
  overdueInstallmentEvidence(inst, "HIGH", at(1)).factFingerprint !== e1.factFingerprint);
ok("fingerprint ignores key order (canonical)",
  evidenceFingerprint("OVERDUE_INSTALLMENT", { ...f1 }, e1.evidenceRefs) ===
  evidenceFingerprint("OVERDUE_INSTALLMENT", Object.fromEntries(Object.entries(f1).reverse()) as OverdueInstallmentFacts, e1.evidenceRefs));

/* ── evidence: backlog ── */
const docs = Array.from({ length: 60 }, (_, i) => ({ id: 1000 + i, createdAt: at(-1 - (i % 9)), source: i % 3 === 0 ? "email" : i % 3 === 1 ? "whatsapp" : "x-raw-provider-value" }));
const e2 = reviewBacklogEvidence(docs, 3, T0);
const f2 = e2.facts as ReviewBacklogFacts;
ok("backlog evidence: exact count, refs capped", f2.pendingCount === 60 && e2.evidenceRefs.length === EVIDENCE_REF_CAP && f2.referencedCount === EVIDENCE_REF_CAP);
ok("backlog evidence: oldest / newest waiting days", f2.oldestWaitingDays === 9 && f2.newestWaitingDays === 1);
ok("backlog evidence: channels are fixed codes; an unknown raw value becomes OTHER, never itself",
  f2.bySource.email === 20 && f2.bySource.whatsapp === 20 && f2.bySource.other === 20 && !JSON.stringify(f2).includes("x-raw"));
ok("backlog evidence: refs are documents, in id order", e2.evidenceRefs.every((r, i) => r.store === "Document" && r.id === 1000 + i));
let threw = false;
try { reviewBacklogEvidence([], 3, T0); } catch { threw = true; }
ok("backlog evidence: refuses an empty backlog (no recommendation without its WHY)", threw);

/* ── reading it back ── */
const stored = { evidenceVersion: e1.evidenceVersion, kind: e1.kind, facts: JSON.parse(JSON.stringify(e1.facts)), evidenceRefs: JSON.parse(JSON.stringify(e1.evidenceRefs)), factFingerprint: e1.factFingerprint, capturedAt: e1.capturedAt, capturedAfterIssue: false };
ok("parse: a stored row round-trips and is intact (reconstructable)", parseEvidence(stored)?.intact === true);
ok("parse: tampered facts are detected", parseEvidence({ ...stored, facts: { ...stored.facts, daysOverdue: 1 } })?.intact === false);
ok("parse: an unknown version is no evidence", parseEvidence({ ...stored, evidenceVersion: "rec-evidence.v0" }) === null);
ok("parse: an unknown kind is no evidence", parseEvidence({ ...stored, kind: "FREE_TEXT" }) === null);

/* ── owner view ── */
function row(over: Partial<OwnerRecommendationRow> & Pick<OwnerRecommendationRow, "type">): OwnerRecommendationRow {
  const pay = over.type === "SETTLE_OVERDUE_INSTALLMENT";
  const ev = pay ? e1 : e2;
  return {
    id: 501, version: 1, status: "ACTIVE", issuedAt: T0, validUntil: at(14), outcomeWindowEnd: at(pay ? 30 : 14), closedAt: null, closedReason: null,
    targets: pay ? [41] : docs.map((d) => d.id), severity: pay ? "HIGH" : null,
    evidence: { ...ev, capturedAfterIssue: false, intact: true },
    decision: null, actions: [], observations: [], assessment: null,
    context: { commitment: pay ? { id: 7, title: "שכירות" } : null, documents: pay ? [] : docs.slice(0, 5).map((d) => ({ id: d.id, createdAt: d.createdAt, originalFilename: `f${d.id}.pdf`, status: "needs_review" })) },
    ...over,
  };
}
const words = (v: OwnerRecommendationView) => [v.what, v.summary, ...v.why, ...v.evidence.lines, v.evidence.capturedNote, v.status, ...v.after, ...v.options.map((o) => o.label)].join("\n");
const accept = { decision: "ACCEPT" as const, reasonCode: null, deferUntil: null, decidedAt: at(1), targets: null };

const scenarios: [string, OwnerRecommendationRow, Date][] = [
  ["payables waiting", row({ type: "SETTLE_OVERDUE_INSTALLMENT" }), at(1)],
  ["payables accepted, nothing yet", row({ type: "SETTLE_OVERDUE_INSTALLMENT", decision: accept }), at(2)],
  ["payables accepted, paid + settled", row({
    type: "SETTLE_OVERDUE_INSTALLMENT", decision: accept,
    actions: [{ eventType: "PERFORMED", targetId: 41, occurredAt: at(3) }],
    observations: [{ kind: "INSTALLMENT_SETTLED", targetId: 41, valueInt: 15, observedAt: at(3) }],
    assessment: { actionState: "COMPLETED", outcomeState: "OBSERVED", direction: "SETTLED", attribution: "OBSERVED_SEQUENCE", uncertainty: "SEQUENCE_NOT_CAUSE", windowEnd: at(30) },
  }), at(4)],
  ["payables paid then reversed", row({
    type: "SETTLE_OVERDUE_INSTALLMENT", decision: accept,
    actions: [{ eventType: "PERFORMED", targetId: 41, occurredAt: at(3) }, { eventType: "REVERSED", targetId: 41, occurredAt: at(5) }],
    observations: [{ kind: "INSTALLMENT_SETTLED", targetId: 41, valueInt: 15, observedAt: at(3) }, { kind: "INSTALLMENT_SETTLEMENT_REVERSED", targetId: 41, valueInt: null, observedAt: at(5) }],
  }), at(6)],
  ["payables rejected", row({ type: "SETTLE_OVERDUE_INSTALLMENT", decision: { ...accept, decision: "REJECT", reasonCode: "ALREADY_HANDLED" } }), at(2)],
  ["payables not now", row({ type: "SETTLE_OVERDUE_INSTALLMENT", decision: { ...accept, decision: "NOT_NOW", deferUntil: at(8) } }), at(2)],
  ["payables paid before the advice", row({ type: "SETTLE_OVERDUE_INSTALLMENT", status: "RESOLVED", closedAt: at(1),
    assessment: { actionState: "PRECEDED_RECOMMENDATION", outcomeState: "NOT_OBSERVED", direction: "NOT_MEASURABLE", attribution: "NOT_ASSESSABLE", uncertainty: "ACTION_PRECEDED_RECOMMENDATION", windowEnd: at(30) } }), at(2)],
  ["documents waiting", row({ type: "REVIEW_PENDING_DOCUMENTS" }), at(1)],
  ["documents modified + reviewed + window end", row({
    type: "REVIEW_PENDING_DOCUMENTS", status: "EXPIRED", closedAt: at(14), decision: { ...accept, decision: "MODIFY", targets: [1000, 1001] },
    actions: [{ eventType: "PERFORMED", targetId: 1000, occurredAt: at(2) }, { eventType: "PERFORMED", targetId: 1001, occurredAt: at(2) }, { eventType: "WITHDRAWN", targetId: 1002, occurredAt: at(3) }],
    observations: [{ kind: "REVIEW_BACKLOG_AT_ISSUE", targetId: null, valueInt: 60, observedAt: T0 }, { kind: "REVIEW_BACKLOG_AT_WINDOW_END", targetId: null, valueInt: 41, observedAt: at(14) }],
    assessment: { actionState: "PARTIALLY_COMPLETED", outcomeState: "OBSERVED", direction: "DECREASED", attribution: "OBSERVED_SEQUENCE", uncertainty: "SEQUENCE_NOT_CAUSE", windowEnd: at(14) },
  }), at(15)],
  ["documents expired unanswered", row({ type: "REVIEW_PENDING_DOCUMENTS", status: "EXPIRED", closedAt: at(14) }), at(15)],
  ["late capture is labelled", row({ type: "SETTLE_OVERDUE_INSTALLMENT", evidence: { ...e1, capturedAfterIssue: true, intact: true } }), at(1)],
];
const views = new Map(scenarios.map(([name, r, now]) => [name, buildOwnerView(r, now)]));

for (const [name, v] of views) {
  const w = words(v);
  const hit = CAUSAL_PHRASES.filter((p) => w.includes(p));
  ok(`CAUSAL SAFETY: no cause / credit wording — ${name}`, hit.length === 0, hit);
  ok(`no money on the surface — ${name}`, !/₪|ש"ח|1200|1,200/.test(w));
  ok(`deterministic — ${name}`, JSON.stringify(buildOwnerView(scenarios.find((s) => s[0] === name)![1], scenarios.find((s) => s[0] === name)![2])) === JSON.stringify(v));
}

const w = (name: string) => views.get(name)!;
ok("WHAT: the installment, by sequence and the owner's own commitment title", w("payables waiting").what === "לרשום את תשלום 2 של „שכירות”");
ok("WHY: from the evidence (days overdue at capture), not from today", w("payables waiting").why[0].includes("לפני 12 ימים"));
ok("WHY: partial coverage is said", w("payables waiting").why.some((l) => l.includes("חלק ממנו")));
ok("stage: waiting + decidable + four options", w("payables waiting").stage === "waiting" && w("payables waiting").decidable &&
  w("payables waiting").options.map((o) => o.decision).join() === "ACCEPT,NOT_NOW,REJECT");
ok("HANDOFF: ACCEPT goes to the real payment form for that installment", w("payables waiting").options[0].href === "/payables/7?pay=41");
ok("accepted, nothing in the ledger yet → in progress, no completion claimed",
  w("payables accepted, nothing yet").stage === "in_progress" && !words(w("payables accepted, nothing yet")).includes("נרשם ("));
ok("AFTER: the exact sequence-safe sentence once the ledger shows the payment",
  w("payables accepted, paid + settled").after.some((l) => l.startsWith("לאחר ההמלצה והפעולה, התשלום נרשם")));
ok("AFTER: OBSERVED_SEQUENCE is stated as time order only", w("payables accepted, paid + settled").after.includes("כל זה מתאר את סדר הדברים בזמן בלבד."));
ok("completed → closed / טופל", w("payables accepted, paid + settled").stage === "closed" && w("payables accepted, paid + settled").status === "טופל");
ok("reversal is shown, never hidden", w("payables paid then reversed").after.some((l) => l.includes("שוב פתוח")));
ok("REJECT: reason label and the suppression rule, in the owner's words",
  w("payables rejected").after[0].includes("כבר טיפלתי בזה") && w("payables rejected").after[0].includes("אלא אם המצב ישתנה"));
ok("NOT_NOW: the date it may come back", w("payables not now").after[0].includes("ביקשת לחזור לזה אחרי"));
ok("an act before the advice is said as such, no sequence claimed",
  w("payables paid before the advice").after.includes("הפעולה נרשמה עוד לפני שההמלצה נוצרה.") && !words(w("payables paid before the advice")).includes("לאחר ההמלצה והפעולה"));
ok("documents: count + oldest, MODIFY offered, selectable subset",
  w("documents waiting").what === "לעבור על 60 מסמכים שמחכים לבדיקה" && w("documents waiting").options.some((o) => o.decision === "MODIFY") && w("documents waiting").selectable.length === 5);
ok("documents: ACCEPT goes to the review of the first waiting document", w("documents waiting").options[0].href === "/documents/review/1000");
ok("documents: after — reviewed of total, window end vs issue, withdrawn",
  w("documents modified + reviewed + window end").after.some((l) => l === "לאחר ההמלצה, נבדקו 2 מתוך 60 מסמכים.") &&
  w("documents modified + reviewed + window end").after.some((l) => l.includes("41 מסמכים") && l.includes("לעומת 60")) &&
  w("documents modified + reviewed + window end").after.some((l) => l.includes("יצאו מתור הבדיקה")));
ok("MODIFY handoff: the first document of the owner's subset",
  handoffFor({ type: "REVIEW_PENDING_DOCUMENTS", evidence: { ...e2, capturedAfterIssue: false, intact: true }, targets: [1000, 1001, 1002] }, [1002, 1001]) === "/documents/review/1001");
ok("expired unanswered → closed, not decidable", w("documents expired unanswered").stage === "closed" && !w("documents expired unanswered").decidable);
ok("a late capture is labelled as such", w("late capture is labelled").evidence.capturedNote.includes("אחרי שההמלצה נוצרה"));
ok("a capture at issue says so", w("payables waiting").evidence.capturedNote.includes("ברגע שההמלצה נוצרה"));

/* ── the next plan consumes the owner's answer (existing semantics, unchanged) ── */
const cand: RecommendationCandidate = {
  type: "SETTLE_OVERDUE_INSTALLMENT", recommendationKey: "SETTLE_OVERDUE_INSTALLMENT:installment:41", subject: { type: "installment", id: 41 },
  targets: [41], supportingSlots: ["s1"], severity: "HIGH", evidenceFingerprint: "e",
};
const rec = (over: Partial<StoredRecommendation> = {}): StoredRecommendation => ({
  id: 501, recommendationKey: cand.recommendationKey, version: 1, type: cand.type, subjectType: "installment", subjectId: 41, targets: [41],
  severity: "HIGH", evidenceFingerprint: "e", issuedAt: T0, validUntil: at(14), outcomeWindowEnd: at(30), status: "ACTIVE", closedAt: null, ...over,
});
const dec = (decision: StoredDecision["decision"], extra: Partial<StoredDecision> = {}): StoredDecision =>
  ({ id: 9, recommendationId: 501, recommendationVersion: 1, decision, modification: null, deferUntil: null, decidedAt: at(1), supersedesDecisionId: null, ...extra });
const plan = (decisions: StoredDecision[], asOf: Date, candidate = cand, stored = [rec()]) =>
  planRecommendations({ asOf, candidates: [candidate], stored, decisions, brain: null });

ok("NEXT PLAN · REJECT → suppressed after expiry", plan([dec("REJECT")], at(15)).suppressed[0]?.reason === "SUPPRESSED_REJECTED");
ok("NEXT PLAN · NOT_NOW → suppressed until the deferral passes", plan([dec("NOT_NOW", { deferUntil: at(20) })], at(15)).suppressed[0]?.reason === "SUPPRESSED_NOT_NOW");
ok("NEXT PLAN · NOT_NOW → reissued once the deferral passed", plan([dec("NOT_NOW", { deferUntil: at(20) })], at(21)).issue[0]?.reason === "RECURRED");
ok("NEXT PLAN · ACCEPT in progress → no duplicate nag", plan([dec("ACCEPT")], at(15)).suppressed[0]?.reason === "SUPPRESSED_ACCEPTED_IN_PROGRESS");
ok("NEXT PLAN · material change → reissued even after REJECT",
  plan([dec("REJECT")], at(15), { ...cand, severity: "CRITICAL" }).issue[0]?.reason === "MATERIAL_CHANGE");
ok("NEXT PLAN · no answer → the same version is not re-raised while ACTIVE", plan([], at(5)).suppressed[0]?.reason === "DEDUPED_ACTIVE");

if (failed > 0) { console.error(`\nClosed loop: ${failed} FAILED`); process.exit(1); }
console.log("\nClosed loop: evidence durable + reconstructable, owner words deterministic and sequence-only. ✔");
