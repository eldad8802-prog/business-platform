/** Service Desk UI 1.3 — the case actions model. Pure: `npx tsx features/service-desk/case-actions-model.test.ts`. */
import { buildActionBody, caseActions, completionTypeForKind, needsDebtDecision } from "./case-actions-model";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) passed++; else { failed++; console.log(`  [FAIL] ${n}${d ? " — " + d : ""}`); } };
const intakeDone = { conditionNote: null, accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true };
const ids = (c: Parameters<typeof caseActions>[0]) => caseActions(c).map((a) => a.id).join(",");
const base = { id: 7, kind: "IN_SHOP", holdReason: null, intake: null } as const;

ok("A1 OPEN repair without intake → the intake screen (a link, not a write)", ids({ ...base, status: "OPEN" }) === "intake,cancel"
  && caseActions({ ...base, status: "OPEN" })[0].target.endpoint === "link");
ok("A2 OPEN repair with the intake recorded → confirm check-in (intakeConfirmed)", (() => { const a = caseActions({ ...base, status: "OPEN", intake: intakeDone })[0];
  return a.id === "check-in" && a.target.endpoint === "action" && (a.target as { action: Record<string, unknown> }).action.intakeConfirmed === true; })());
ok("A3 OPEN field call → start the visit, no intake", ids({ ...base, kind: "FIELD", status: "OPEN" }) === "start-visit,cancel");
ok("A4 the main path offers exactly one primary per status", (["OPEN", "CHECKED_IN", "DIAGNOSING", "QUOTE_PENDING", "IN_REPAIR", "QA", "READY", "WORK_DONE", "DELIVERED"] as const)
  .every((s) => caseActions({ ...base, status: s, intake: intakeDone }).filter((a) => a.tone === "primary").length === 1));
ok("A5 closed / cancelled cases offer nothing", caseActions({ ...base, status: "CLOSED" }).length === 0 && caseActions({ ...base, status: "CANCELLED" }).length === 0);
ok("A6 hold: set when free, clear when held", ids({ ...base, status: "IN_REPAIR" }).includes("hold-parts") && ids({ ...base, status: "IN_REPAIR", holdReason: "PARTS" }).includes("clear-hold")
  && !ids({ ...base, status: "IN_REPAIR", holdReason: "PARTS" }).includes("hold-parts"));
ok("A7 a quote answer goes to the quote decision endpoint", caseActions({ ...base, status: "QUOTE_PENDING" }).every((a) => a.target.endpoint === "quote" && a.input.kind === "quoteMethod"));
ok("A8 cancel needs a reason once the item is here, not before", (() => {
  const before = caseActions({ ...base, status: "OPEN" }).find((a) => a.id === "cancel")!.input;
  const after = caseActions({ ...base, status: "IN_REPAIR" }).find((a) => a.id === "cancel")!.input;
  return before.kind === "reason" && !before.required && after.kind === "reason" && after.required; })());
ok("A9 no cancel / hold buttons where the machine has no such step (QA, READY, DELIVERED)", ["QA", "READY", "DELIVERED"].every((s) => !ids({ ...base, status: s as never }).includes("cancel")));

const deliver = caseActions({ ...base, status: "READY" })[0];
ok("B1 DELIVER body: owner-confirmed handover, optional receiver name", JSON.stringify(buildActionBody(deliver, base, { receiver: "  דנה " })) === JSON.stringify({ type: "DELIVER", receipt: { handoverConfirmed: true, receivedByName: "דנה" } })
  && JSON.stringify(buildActionBody(deliver, base, {})) === JSON.stringify({ type: "DELIVER", receipt: { handoverConfirmed: true, receivedByName: null } }));
ok("B2 DELIVER with an open balance carries the owner's reason", (buildActionBody(deliver, base, { debtReason: "הלקוח ישלם מחר" }) as { debtOverride?: { reason: string } }).debtOverride?.reason === "הלקוח ישלם מחר");
const complete = caseActions({ ...base, kind: "FIELD", status: "WORK_DONE" })[0];
ok("B3 COMPLETE body: the owner confirms where the work was done", JSON.stringify(buildActionBody(complete, { kind: "FIELD" }, {})) === JSON.stringify({ type: "COMPLETE", completion: { completionType: "OWNER_CONFIRMED_ON_SITE", ownerConfirmed: true } }));
ok("B4 completion types by kind", completionTypeForKind("REMOTE") === "OWNER_CONFIRMED_REMOTE" && completionTypeForKind("IN_SHOP") === "OWNER_CONFIRMED_AT_BUSINESS");
const cancel = caseActions({ ...base, status: "IN_REPAIR" }).find((a) => a.id === "cancel")!;
ok("B5 CANCEL body carries the trimmed reason only when given", JSON.stringify(buildActionBody(cancel, base, { reason: " הלקוח ויתר " })) === JSON.stringify({ type: "CANCEL", reason: "הלקוח ויתר" })
  && JSON.stringify(buildActionBody(cancel, base, { reason: "  " })) === JSON.stringify({ type: "CANCEL" }));
ok("B6 an open-balance refusal asks for the owner's decision", needsDebtDecision(["OPEN_BALANCE_NEEDS_OWNER_DECISION"]) && !needsDebtDecision(["QA_INCOMPLETE"]));

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
