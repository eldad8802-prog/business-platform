/** Service Desk UI 1.3 — the case actions model. Pure: `npx tsx features/service-desk/case-actions-model.test.ts`. */
import { buildActionBody, caseActions, completionTypeForKind, needsDebtDecision } from "./case-actions-model";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) passed++; else { failed++; console.log(`  [FAIL] ${n}${d ? " — " + d : ""}`); } };
const intakeDone = { conditionNote: null, accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true };
const ids = (c: Parameters<typeof caseActions>[0]) => caseActions(c).map((a) => a.id).join(",");
const base = { id: 7, kind: "IN_SHOP", holdReason: null, intake: null } as const;

ok("A1 OPEN repair without intake → the intake screen (a link, not a write)", ids({ ...base, status: "OPEN" }) === "intake,cancel"
  && caseActions({ ...base, status: "OPEN" })[0].target.endpoint === "link");
ok("A2 OPEN repair with the intake recorded → «confirm» leads to the intake screen, the one place it is confirmed", (() => { const a = caseActions({ ...base, status: "OPEN", intake: intakeDone })[0];
  return a.id === "intake" && a.label === "לאשר את הקליטה" && a.target.endpoint === "link" && (a.target as { href: string }).href.endsWith("/intake"); })());
ok("A3 OPEN field call → start the visit, no intake", ids({ ...base, kind: "FIELD", status: "OPEN" }) === "start-visit,cancel");
ok("A4 the main path offers exactly one primary per status", (["OPEN", "CHECKED_IN", "DIAGNOSING", "QUOTE_PENDING", "IN_REPAIR", "QA", "READY", "WORK_DONE"] as const)
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

ok("A6b on hold, back to work is the primary action and finishing stays offered", (() => { const a = caseActions({ ...base, status: "IN_REPAIR", holdReason: "PARTS" }); return a[0].id === "clear-hold" && a[0].tone === "primary" && a.some((x) => x.id === "finish" && x.tone === "secondary"); })());
ok("A7 finishing follows the QA mode: REQUIRED → to QA without an outcome; OPTIONAL → both; OFF → finished with the outcome", (() => {
  const body = (m?: "REQUIRED" | "OPTIONAL" | "OFF") => caseActions({ ...base, status: "IN_REPAIR" }, { qaMode: m }).filter((x) => x.id.startsWith("finish")).map((x) => JSON.stringify(x.target));
  const req = body("REQUIRED"), opt = body("OPTIONAL"), off = body("OFF"), none = body();
  return req.length === 1 && !req[0].includes("outcome") && opt.length === 2 && opt[0].includes("\"qa\":true") && opt[1].includes("REPAIRED")
    && off.length === 1 && off[0].includes("REPAIRED") && none[0] === off[0]; })());

// ── Pilot review 2026-11-21 ──
ok("R1 DELIVERED offers nothing: CLOSE is the system's step (the owner's button only produced a refusal)", caseActions({ ...base, status: "DELIVERED" }).length === 0);
ok("R2 QA with a blocker: passed is shown with its reason, not active; back to work becomes the primary", (() => {
  // Owner decision 2026-11-24: nothing announces a failure before a check is marked; the main action follows the checklist.
  const inc = caseActions({ ...base, status: "QA" }, { qaMode: "REQUIRED", qaState: "incomplete" });
  const ready = caseActions({ ...base, status: "QA" }, { qaMode: "REQUIRED", qaState: "ready" });
  const failed = caseActions({ ...base, status: "QA" }, { qaMode: "REQUIRED", qaState: "failed" });
  return inc.length === 1 && inc[0].id === "qa-mark" && inc[0].target.endpoint === "scroll" && !inc.some((d) => /לא עבר/.test(d.label))
    && ready[0].id === "qa-pass" && ready[0].tone === "primary" && ready[0].target.endpoint === "qa" && (ready[0].target as { then: string }).then === "PASS"
    && failed.length === 1 && failed[0].id === "qa-fail" && (failed[0].target as { then: string }).then === "FAIL"; })());
ok("R3 QA without a blocker: passed is the primary and active", (() => {
  const pass = caseActions({ ...base, status: "QA" }, { qaMode: "REQUIRED", qaBlocker: null }).find((d) => d.id === "qa-pass");
  return pass?.tone === "primary" && pass.blockedReason === undefined; })());
ok("R4 READY with an unknown balance: the handover is shown with the reason, never sent", caseActions({ ...base, status: "READY" }, { handoverBlocker: "y" })[0].blockedReason === "y"
  && caseActions({ ...base, status: "READY" })[0].blockedReason === undefined);
ok("R6 READY / WORK_DONE with no charge decided: the main action sets the charge (no locked handover)",
  (() => { const r = caseActions({ ...base, status: "READY" }, { chargeUndecided: true, handoverBlocker: "y" });
    const w = caseActions({ ...base, kind: "FIELD", status: "WORK_DONE" }, { chargeUndecided: true, handoverBlocker: "y" });
    return r.length === 1 && r[0].id === "set-charge" && r[0].target.endpoint === "charge" && !r[0].blockedReason && w[0].id === "set-charge"; })());
ok("R5 WORK_DONE completion follows the same balance rule", caseActions({ ...base, kind: "FIELD", status: "WORK_DONE" }, { handoverBlocker: "y" })[0].blockedReason === "y");

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
