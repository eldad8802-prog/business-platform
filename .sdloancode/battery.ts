/**
 * Service Desk loans — through the REAL services (loans.service lendLoaner / runLoanAction / listCaseLoans / listLoans,
 * service-case.service runCaseAction) AS the runtime role, on the handover-record chain + migration 20261201090000
 * (.sd3p4/lab.sh <db>, --deploy-only, .sdm1/chain.sh <db>, .sdhov/chain.sh <db>, .sdloan/chain.sh <db>). Synthetic only.
 *
 *   N  a normal loan and its return; the journal; the views (case list, business list, overdue)
 *   X  statuses: an approved exception on an OPEN case (approver = the session user); refused statuses
 *   D  double loan (sequential and concurrent, two connections)
 *   R  double return (sequential and concurrent); a return after the case was delivered / closed / cancelled
 *   C  close an unreturned loan (approved, reason)
 *   V  DELIVER: with a loan OUT detected from REAL data (no override → OPEN_LOANER; with → the #1128 loaner columns);
 *      without a loan → no loaner exception; CLOSE refused while a loan is OUT
 *   K  CANCEL / ABANDON with a loan OUT: refused without the approval; with it the loan stays OUT and its journal records
 *      CANCEL_OPEN_LOANER / ABANDON_OPEN_LOANER bound to the case event; a replay writes nothing new
 *   I  idempotency: the same key replays (one loan / one return), another body with it is refused
 *   F  forged identities in a body never stored; another business's principal reaches nothing; a mis-built principal is
 *      refused by the database and writes nothing; a failed server check writes nothing
 *   U  deleting the acting user keeps the loan and its journal (users NULL); the next user returns it
 *
 * env: OWNER_URL (lab owner — fixtures), DATABASE_URL = DIRECT_URL (app_runtime_prod), TASK_REQUEST_HMAC_KEY / _ID,
 *      AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import { openCase, recordIntake, recordQa, runCaseAction, type OpenCaseInput, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";
import { recordCharge } from "../lib/services/service-desk/case-charge.service";
import { lendLoaner, listCaseLoans, listLoans, runLoanAction } from "../lib/services/service-desk/loans.service";
import { QA_TEMPLATE_BY_ID } from "../lib/services/service-desk/qa-templates";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const key = () => uuidV7(new Date());
async function own(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}
async function tryIt<T>(f: () => Promise<T>): Promise<string> {
  try { await f(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}:${JSON.stringify(e.details)}`;
    return `THROW:${(e as Error).message.replace(/\s+/g, " ").slice(-240)}`;
  }
}
const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdloan-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdloan-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await own(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  await own(b, `INSERT INTO "ServiceSettings" ("businessId", version, "updatedAt", "serviceProfileKey") VALUES ($1, 1, now(), 'general') RETURNING "businessId"`, b);
  const item = Number((await own(b, `INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'מכשיר חלופי', 'UNIT', 2, now()) RETURNING id`, b))[0].id);
  return { b, u, cust, item, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
const open = async (z: Biz, input: Partial<OpenCaseInput> = {}) =>
  (await openCase(z.p, { customerId: z.cust, problemDescription: "תקלה סינתטית", track: "T1", subject: { displayName: "טלפון סינתטי" }, ...input } as OpenCaseInput, { idempotencyKey: key() })).case;
const version = async (z: Biz, id: number) => Number((await own(z.b, `SELECT version FROM "ServiceCase" WHERE id = $1`, id))[0].version);
const caseRow = async (z: Biz, id: number) => (await own(z.b, `SELECT status::text s, outcome::text o FROM "ServiceCase" WHERE id = $1`, id))[0];
async function act(z: Biz, id: number, action: Record<string, unknown>, k = key(), p = z.p): Promise<string> {
  const v = await version(z, id);
  return tryIt(() => runCaseAction(p, id, { action, expectedVersion: v }, { idempotencyKey: k }));
}
async function walk(z: Biz, id: number, actions: Record<string, unknown>[]): Promise<string> {
  for (const a of actions) { const r = await act(z, id, a); if (r !== "OK") return `${String(a.type)}: ${r}`; }
  return "OK";
}
/** T1 to IN_REPAIR: confirmed intake, check-in, diagnosis, repair. */
async function inRepair(z: Biz): Promise<number> {
  const c = await open(z);
  await recordIntake(z.p, c.id, { conditionNote: "שריטה", accessoriesNote: "ללא", conditionRecorded: true, accessoriesRecorded: true, expectedVersion: await version(z, c.id) }, { idempotencyKey: key() });
  const w = await walk(z, c.id, [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }]);
  if (w !== "OK") throw new Error(`T1 path: ${w}`);
  return c.id;
}
async function toReady(z: Biz, id: number): Promise<void> {
  const w = await walk(z, id, [{ type: "FINISH_REPAIR" }]);
  if (w !== "OK") throw new Error(`FINISH_REPAIR: ${w}`);
  await recordQa(z.p, id, { results: Object.fromEntries(QA_TEMPLATE_BY_ID["IN_SHOP.v1"].items.map((i) => [i.key, "PASS"])), expectedVersion: await version(z, id) }, { idempotencyKey: key() });
  const p = await walk(z, id, [{ type: "PASS_QA", outcome: "REPAIRED" }]);
  if (p !== "OK") throw new Error(`PASS_QA: ${p}`);
  await recordCharge(z.p, id, { mode: "NO_CHARGE", reason: "באחריות", expectedVersion: await version(z, id) }, { idempotencyKey: key() });
}
const LEND = { itemName: "טלפון חלופי", conditionAtLend: "GOOD", expectedReturnOn: "2026-12-20", lendNote: "שריטה בגב" };
async function lend(z: Biz, caseId: number, body: Record<string, unknown> = {}, k = key(), p = z.p) {
  let loan: { id: number; version: number } | null = null;
  const r = await tryIt(async () => { loan = (await lendLoaner(p, caseId, { ...LEND, ...body }, { idempotencyKey: k })).loan; });
  return { r, loan: loan as { id: number; version: number } | null };
}
const loanAct = async (z: Biz, caseId: number, loanId: number, action: Record<string, unknown>, k = key(), p = z.p, v?: number) => {
  const cur = v ?? Number((await own(z.b, `SELECT version FROM "ServiceLoan" WHERE id = $1`, loanId))[0]?.version ?? 1);
  return tryIt(() => runLoanAction(p, caseId, loanId, { action, expectedVersion: cur }, { idempotencyKey: k }));
};
const loanRow = async (z: Biz, id: number) => (await own(z.b, `SELECT state::text s, version v, "lentByUserId" lb, "lendApprovedByUserId" la, "lendExceptionReason" lr,
  "returnedByUserId" rb, "conditionAtReturn"::text cr, "closeApprovedByUserId" ca, "closeNote" cn, "closeReason"::text crs FROM "ServiceLoan" WHERE id = $1`, id))[0];
const evs = async (z: Biz, id: number) => own(z.b, `SELECT seq, kind::text k, "approvalKind"::text a, "approvedByUserId" ab, reason, "caseSeq" cs, "actorUserId" u FROM "ServiceLoanEvent" WHERE "loanId" = $1 ORDER BY seq`, id);
const DELIVER = { type: "DELIVER", receipt: { handoverConfirmed: true, receivedByName: "דנה" } };
const FORGED = { approverUserId: 0, approvedByUserId: 0, actorUserId: 0, lentByUserId: 0, lendApprovedByUserId: 0, returnedByUserId: 0, businessId: 0 };

async function main() {
  const A = await business("a");
  const B = await business("b");
  const A2 = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdloan-a2-${t}@lab.invalid`, A.b))[0].id);
  const forged = Object.fromEntries(Object.keys(FORGED).map((k) => [k, k === "businessId" ? B.b : A2]));

  console.log("N — a normal loan and its return");
  let caseN = 0, loanN = 0;
  {
    caseN = await inRepair(A);
    const l = await lend(A, caseN, { itemIdentifier: "IMEI 3567-8901", inventoryItemId: A.item });
    loanN = l.loan?.id ?? 0;
    const row = await loanRow(A, loanN);
    ok("N1 lent while IN_REPAIR → OUT, version 1, lent by the session user, no exception", l.r === "OK" && row?.s === "OUT" && Number(row?.v) === 1 && Number(row?.lb) === A.u && row?.la === null, l.r);
    ok("N2 the inventory item is referenced READ-ONLY: its quantity and movements are unchanged",
      Number((await own(A.b, `SELECT "currentQuantity" q FROM "InventoryItem" WHERE id = $1`, A.item))[0].q) === 2
      && Number((await own(A.b, `SELECT count(*)::int n FROM "InventoryMovement" WHERE "itemId" = $1`, A.item))[0].n) === 0);
    const list = await listCaseLoans(A.b, caseN);
    ok("N3 the case's loans: one, with the inventory name, its LENT event, identifier as typed", list.loans.length === 1 && list.loans[0].inventoryItemName === "מכשיר חלופי"
      && list.loans[0].itemIdentifier === "IMEI 3567-8901" && list.loans[0].events.map((e) => e.kind).join() === "LENT");
    const all = await listLoans(A.b);
    ok("N4 the business list (default OUT) holds it, with its case number", all.loans.some((x) => x.id === loanN && x.caseNumber !== null));
    const r = await loanAct(A, caseN, loanN, { type: "RETURN", conditionAtReturn: "WORN", returnNote: "שחיקה קלה" });
    const after = await loanRow(A, loanN);
    ok("N5 the return → RETURNED, version 2, received by the session user, condition WORN", r === "OK" && after?.s === "RETURNED" && Number(after?.v) === 2 && Number(after?.rb) === A.u && after?.cr === "WORN", r);
    ok("N6 the journal: LENT (1), RETURNED (2), each by the session user", JSON.stringify((await evs(A, loanN)).map((e) => [e.k, Number(e.u)])) === JSON.stringify([["LENT", A.u], ["RETURNED", A.u]]));
    ok("N7 the business list no longer shows it OUT; state=RETURNED does", !(await listLoans(A.b)).loans.some((x) => x.id === loanN) && (await listLoans(A.b, { state: "RETURNED" })).loans.some((x) => x.id === loanN));
    const c2 = await inRepair(A);
    const od = await lend(A, c2, { expectedReturnOn: "2026-01-01" });
    ok("N8 overdue: a loan OUT past its expected date is flagged and listed by overdue=true", od.r === "OK" && (await listLoans(A.b, { overdue: "true" })).loans.some((x) => x.id === od.loan?.id && x.overdue));
    ok("N9 the expected date changes while OUT (and the overdue flag follows)", (await loanAct(A, c2, od.loan!.id, { type: "CHANGE_EXPECTED_RETURN", expectedReturnOn: "2099-01-01" })) === "OK"
      && !(await listLoans(A.b, { overdue: "true" })).loans.some((x) => x.id === od.loan?.id));
  }

  console.log("X — statuses");
  {
    const c = await open(A);
    const r1 = await lend(A, c.id);
    ok("X1 an OPEN case without an exception reason → REFUSED EXCEPTION_REASON_REQUIRED, nothing written", r1.r.includes("EXCEPTION_REASON_REQUIRED")
      && Number((await own(A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "caseId" = $1`, c.id))[0].n) === 0, r1.r);
    const r2 = await lend(A, c.id, { exceptionReason: "הלקוח צריך מכשיר עד שיביא את שלו", ...forged });
    const row = await loanRow(A, r2.loan?.id ?? 0);
    const e = (await evs(A, r2.loan?.id ?? 0))[0];
    ok("X2 with the reason (+ forged approver fields) → lent; LEND_OUTSIDE_WORK approved by the SESSION user, never the named one",
      r2.r === "OK" && Number(row?.la) === A.u && Number(row?.lb) === A.u && row?.lr === "הלקוח צריך מכשיר עד שיביא את שלו" && e?.a === "LEND_OUTSIDE_WORK" && Number(e?.ab) === A.u, `${r2.r} ${JSON.stringify(row)}`);
    const w = await inRepair(A);
    ok("X3 a work status with an exception reason → REFUSED NO_EXCEPTION_NEEDED", (await lend(A, w, { exceptionReason: "מיותר" })).r.includes("NO_EXCEPTION_NEEDED"));
    const d = await inRepair(A);
    await toReady(A, d);
    await act(A, d, DELIVER);
    ok("X4 a DELIVERED case → REFUSED CASE_STATUS_NOT_ALLOWED", (await lend(A, d, { exceptionReason: "x" })).r.includes("CASE_STATUS_NOT_ALLOWED"));
  }

  console.log("D — double loan");
  {
    const c1 = await inRepair(A), c2 = await inRepair(A);
    const a = await lend(A, c1, { itemIdentifier: "SN-0001" });
    ok("D1 the same item (another spelling) on another case while OUT → REFUSED LOAN_ITEM_ALREADY_OUT", a.r === "OK" && (await lend(A, c2, { itemIdentifier: "sn 0001" })).r.includes("LOAN_ITEM_ALREADY_OUT"));
    const both = await Promise.all([lend(A, c1, { itemIdentifier: "RACE-77" }), lend(A, c2, { itemIdentifier: "race77" })]);
    ok("D2 two concurrent loans of one item (two connections) → exactly one; the other LOAN_ITEM_ALREADY_OUT", both.filter((x) => x.r === "OK").length === 1
      && both.some((x) => x.r.includes("LOAN_ITEM_ALREADY_OUT"))
      && Number((await own(A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "businessId" = $1 AND "itemIdentifierNormalized" = 'RACE77'`, A.b))[0].n) === 1, both.map((x) => x.r).join(" | "));
  }

  console.log("R — double return; returns after the case moved on");
  {
    const c = await inRepair(A);
    const l = (await lend(A, c, { itemIdentifier: "RET-2" })).loan!;
    const k = key();
    const r1 = await loanAct(A, c, l.id, { type: "RETURN", conditionAtReturn: "GOOD" }, k, A.p, 1);
    const r1b = await loanAct(A, c, l.id, { type: "RETURN", conditionAtReturn: "GOOD" }, k, A.p, 1);
    const r2 = await loanAct(A, c, l.id, { type: "RETURN", conditionAtReturn: "DAMAGED" }, key(), A.p, 2);
    ok("R1 the same return replayed with its key → answered from the first, one RETURNED event", r1 === "OK" && r1b === "OK" && (await evs(A, l.id)).length === 2);
    ok("R2 a second return → REFUSED LOAN_NOT_OUT; the recorded condition unchanged", r2.includes("LOAN_NOT_OUT") && (await loanRow(A, l.id))?.cr === "GOOD", r2);
    const c3 = await inRepair(A);
    const l3 = (await lend(A, c3)).loan!;
    const two = await Promise.all([1, 2].map(() => loanAct(A, c3, l3.id, { type: "RETURN", conditionAtReturn: "GOOD" }, key(), A.p, 1)));
    ok("R3 two concurrent returns (different keys) → exactly one; version 2", two.filter((x) => x === "OK").length === 1 && Number((await loanRow(A, l3.id))?.v) === 2, two.join(" | "));
    const c4 = await inRepair(A);
    await toReady(A, c4);
    const l4 = (await lend(A, c4, { exceptionReason: "עד שיאסוף" })).loan!;
    const dv = await act(A, c4, { ...DELIVER, loanerOverride: { reason: "יחזיר מחר" } });
    const rr = await loanAct(A, c4, l4.id, { type: "RETURN", conditionAtReturn: "GOOD" });
    const cl = await act(A, c4, { type: "CLOSE" });
    ok("R4 delivered with the loaner out (approved) → the return after the handover is accepted → then CLOSE", dv === "OK" && rr === "OK" && cl === "OK" && (await caseRow(A, c4)).s === "CLOSED", `${dv} | ${rr} | ${cl}`);
  }

  console.log("C — close an unreturned loan");
  {
    const c = await inRepair(A);
    const l = (await lend(A, c)).loan!;
    ok("C1 without a reason → REFUSED REASON_REQUIRED", (await loanAct(A, c, l.id, { type: "CLOSE_UNRETURNED", closeReason: "LOST", reason: " " })).includes("REASON_REQUIRED"));
    const r = await loanAct(A, c, l.id, { type: "CLOSE_UNRETURNED", closeReason: "KEPT_BY_CUSTOMER", reason: "הלקוח רכש את המכשיר", ...forged });
    const row = await loanRow(A, l.id), e = (await evs(A, l.id))[1];
    ok("C2 KEPT_BY_CUSTOMER with a reason → CLOSED; approver = the session user (LOAN_CLOSE_UNRETURNED)", r === "OK" && row?.s === "CLOSED" && row?.crs === "KEPT_BY_CUSTOMER"
      && Number(row?.ca) === A.u && row?.cn === "הלקוח רכש את המכשיר" && e?.a === "LOAN_CLOSE_UNRETURNED" && Number(e?.ab) === A.u, `${r} ${JSON.stringify(row)}`);
    ok("C3 a return after the close → REFUSED LOAN_NOT_OUT", (await loanAct(A, c, l.id, { type: "RETURN", conditionAtReturn: "GOOD" })).includes("LOAN_NOT_OUT"));
  }

  console.log("V — DELIVER and CLOSE, from real data");
  {
    const c = await inRepair(A);
    await toReady(A, c);
    const l = (await lend(A, c, { exceptionReason: "עד שיאסוף", itemIdentifier: "DLV-1" })).loan!;
    const r1 = await act(A, c, DELIVER);
    ok("V1 DELIVER with a loan OUT and no override → REFUSED OPEN_LOANER (the hard-coded 'false' is gone), nothing written",
      r1.includes("OPEN_LOANER") && (await caseRow(A, c)).s === "READY" && (await own(A.b, `SELECT count(*)::int n FROM "ServiceHandover" WHERE "caseId" = $1`, c))[0].n === 0, r1);
    const r2 = await act(A, c, { ...DELIVER, loanerOverride: { reason: "יחזיר ביום שני", ...forged }, ...forged });
    const h = (await own(A.b, `SELECT "loanerOverrideReason" r, "loanerApprovedByUserId" a, "loanerApprovedAt" IS NOT NULL t, "actorUserId" u FROM "ServiceHandover" WHERE "caseId" = $1`, c))[0];
    ok("V2 with the override (+ forged fields) → DELIVERED; the handover records reason, approver = actor = the session user, approval time",
      r2 === "OK" && (await caseRow(A, c)).s === "DELIVERED" && h?.r === "יחזיר ביום שני" && Number(h?.a) === A.u && Number(h?.u) === A.u && h?.t === true, `${r2} ${JSON.stringify(h)}`);
    ok("V3 the loan is still OUT after the handover", (await loanRow(A, l.id))?.s === "OUT");
    ok("V4 CLOSE while it is out → REFUSED OPEN_LOANER", (await act(A, c, { type: "CLOSE" })).includes("OPEN_LOANER"));
    const n = await inRepair(A);
    await toReady(A, n);
    const r3 = await act(A, n, { ...DELIVER, loanerOverride: { reason: "אין חלופי" } });
    const hn = (await own(A.b, `SELECT "loanerOverrideReason" r, "loanerApprovedByUserId" a FROM "ServiceHandover" WHERE "caseId" = $1`, n))[0];
    ok("V5 DELIVER of a case with no loan: delivered, no loaner exception stored (an override is ignored)", r3 === "OK" && hn?.r === null && hn?.a === null, `${r3} ${JSON.stringify(hn)}`);
  }

  console.log("K — CANCEL / ABANDON with a loan OUT");
  {
    const c = await inRepair(A);
    const l = (await lend(A, c, { itemIdentifier: "CNL-1" })).loan!;
    const r1 = await act(A, c, { type: "CANCEL", reason: "הלקוח ביטל" });
    ok("K1 CANCEL with a loan OUT, no override → REFUSED OPEN_LOANER, the case unchanged", r1.includes("OPEN_LOANER") && (await caseRow(A, c)).s === "IN_REPAIR", r1);
    const k = key();
    const r2 = await act(A, c, { type: "CANCEL", reason: "הלקוח ביטל", loanerOverride: { reason: "יחזיר את החלופי בשבוע הבא", ...forged } }, k);
    const cr = await caseRow(A, c);
    const e = await evs(A, l.id);
    const cv = await version(A, c);
    ok("K2 with the override → the held item goes to READY (CANCELLED); the loan stays OUT", r2 === "OK" && cr.s === "READY" && cr.o === "CANCELLED" && (await loanRow(A, l.id))?.s === "OUT", `${r2} ${JSON.stringify(cr)}`);
    ok("K3 the loan's journal: CASE_EXIT_APPROVED / CANCEL_OPEN_LOANER, bound to the cancel's seq, approver = the session user, the reason",
      e.length === 2 && e[1].k === "CASE_EXIT_APPROVED" && e[1].a === "CANCEL_OPEN_LOANER" && Number(e[1].cs) === cv && Number(e[1].ab) === A.u && e[1].reason === "יחזיר את החלופי בשבוע הבא", JSON.stringify(e));
    const replay = await tryIt(() => runCaseAction(A.p, c, { action: { type: "CANCEL", reason: "הלקוח ביטל", loanerOverride: { reason: "יחזיר את החלופי בשבוע הבא", ...forged } }, expectedVersion: cv - 1 }, { idempotencyKey: k }));
    ok("K4 the cancel replayed with its key → answered, no second approval event", replay === "OK" && (await evs(A, l.id)).length === 2, replay);
    ok("K5 a loan is refused on the cancelled case (CASE_CANCELLING)", (await lend(A, c, { exceptionReason: "x" })).r.includes("CASE_CANCELLING"));
    await recordCharge(A.p, c, { mode: "NO_CHARGE", reason: "בוטל — ללא חיוב", expectedVersion: await version(A, c) }, { idempotencyKey: key() });
    const dv = await act(A, c, { ...DELIVER, loanerOverride: { reason: "עדיין אצלו" } });
    ok("K6 the cancelled held item is still handed back (with the loaner exception); the loan stays OUT; returned later",
      dv === "OK" && (await loanRow(A, l.id))?.s === "OUT" && (await loanAct(A, c, l.id, { type: "RETURN", conditionAtReturn: "GOOD" })) === "OK", dv);
    const o = await open(A);
    const lo = (await lend(A, o.id, { exceptionReason: "לפני הקבלה" })).loan!;
    const r3 = await act(A, o.id, { type: "CANCEL", loanerOverride: { reason: "הלקוח שומר עד שיחזיר" } });
    ok("K7 an OPEN case cancelled with the override → CANCELLED (terminal); the loan OUT; a return after the cancel is accepted",
      r3 === "OK" && (await caseRow(A, o.id)).s === "CANCELLED" && (await loanRow(A, lo.id))?.s === "OUT"
      && (await loanAct(A, o.id, lo.id, { type: "RETURN", conditionAtReturn: "DAMAGED", returnNote: "חזר שבור" })) === "OK", r3);
    // ABANDON needs a documented pickup reminder; the lab records one the way the reminder flow will (owner, case row)
    const ab = await inRepair(A);
    await toReady(A, ab);
    const la = (await lend(A, ab, { exceptionReason: "עד שיאסוף" })).loan!;
    const rem = await tryIt(() => owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(A.b));
      await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET "pickupRemindersSent" = 1, "lastPickupReminderAt" = now() WHERE id = $1`, ab);
    }));
    if (rem === "OK") {
      const r4 = await act(A, ab, { type: "ABANDON", reason: "לא נאסף" });
      const r5 = await act(A, ab, { type: "ABANDON", reason: "לא נאסף", loanerOverride: { reason: "הלקוח לא עונה" } });
      const ea = await evs(A, la.id);
      ok("K8 ABANDON with a loan OUT: refused without, accepted with the override → ABANDON_OPEN_LOANER on the loan; the loan OUT",
        r4.includes("OPEN_LOANER") && r5 === "OK" && (await caseRow(A, ab)).s === "ABANDONED" && ea[1]?.a === "ABANDON_OPEN_LOANER" && (await loanRow(A, la.id))?.s === "OUT", `${r4} | ${r5}`);
    } else ok("K8 (lab) a pickup reminder could not be recorded", false, rem);
  }

  console.log("I — idempotency");
  {
    const c = await inRepair(A);
    const k = key();
    const a = await lend(A, c, { itemIdentifier: "IDEM-1" }, k);
    const b = await lend(A, c, { itemIdentifier: "IDEM-1" }, k);
    const other = await lend(A, c, { itemIdentifier: "IDEM-2" }, k);
    ok("I1 the same key and body → replayed (the same loan), one row", a.r === "OK" && b.r === "OK" && a.loan?.id === b.loan?.id
      && Number((await own(A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "caseId" = $1`, c))[0].n) === 1);
    ok("I2 the same key with another body → IDEMPOTENCY_KEY_REUSED", other.r.startsWith("IDEMPOTENCY_KEY_REUSED"), other.r);
    const c2 = await inRepair(A);
    const both = await Promise.all([1, 2].map(() => lend(A, c2, { itemIdentifier: "IDEM-3" }, k + "")));
    ok("I3 the key of another case's loan → IDEMPOTENCY_KEY_REUSED (never answered with another case's loan)", both.every((x) => x.r.startsWith("IDEMPOTENCY_KEY_REUSED")), both.map((x) => x.r).join(" | "));
    const k2 = key();
    const conc = await Promise.all([1, 2].map(() => lend(A, c2, { itemIdentifier: "IDEM-4" }, k2)));
    ok("I4 two concurrent requests with the SAME key → both answered, one loan", conc.every((x) => x.r === "OK") && conc[0].loan?.id === conc[1].loan?.id
      && Number((await own(A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "businessId" = $1 AND "itemIdentifierNormalized" = 'IDEM4'`, A.b))[0].n) === 1, conc.map((x) => x.r).join(" | "));
  }

  console.log("F — forged identities, isolation, failures");
  {
    const c = await inRepair(A);
    const r1 = await lend(A, c, {}, key(), B.p);
    ok("F1 a principal of ANOTHER business on A's case → NOT_FOUND, nothing written", r1.r.startsWith("NOT_FOUND") && Number((await own(A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "caseId" = $1`, c))[0].n) === 0, r1.r);
    ok("F2 B cannot list A's case loans; B's business list holds none of A's", (await tryIt(() => listCaseLoans(B.b, c))).startsWith("NOT_FOUND") && (await listLoans(B.b, { state: "ALL" })).loans.length === 0);
    const r2 = await lend(A, c, {}, key(), { businessId: A.b, userId: B.u });
    ok("F3 a mis-built principal (a user of another business) → refused by the database, nothing written", r2.r.startsWith("REFUSED") && Number((await own(A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "caseId" = $1`, c))[0].n) === 0, r2.r);
    const r3 = await lend(A, c, { inventoryItemId: B.item });
    ok("F4 another business's inventory item → SERVER_CHECK_FAILED, nothing written (the failed command rolls back whole)", r3.r.includes("INVENTORY_ITEM_BELONGS_TO_BUSINESS")
      && Number((await own(A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "caseId" = $1`, c))[0].n) === 0, r3.r);
    const l = (await lend(A, c)).loan!;
    ok("F5 a loan of A acted on through another case id → NOT_FOUND", (await loanAct(A, await inRepair(A), l.id, { type: "RETURN", conditionAtReturn: "GOOD" })).startsWith("NOT_FOUND"));
    ok("F6 B returning A's loan → NOT_FOUND", (await loanAct(A, c, l.id, { type: "RETURN", conditionAtReturn: "GOOD" }, key(), B.p)).startsWith("NOT_FOUND"));
    const r4 = await loanAct(A, c, l.id, { type: "RETURN", conditionAtReturn: "GOOD" }, key(), { businessId: A.b, userId: A2 });
    ok("F7 another user of the same business returning in their OWN session is recorded as the receiver", r4 === "OK" && Number((await loanRow(A, l.id))?.rb) === A2, r4);
  }

  console.log("U — deleting the acting user");
  {
    const U = await business("u");
    const U2 = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdloan-u2-${t}@lab.invalid`, U.b))[0].id);
    const o = await open(U);
    const l = (await lend(U, o.id, { exceptionReason: "חריג" })).loan!;
    const del = await tryIt(() => q(`DELETE FROM "User" WHERE id = $1`, U.u));
    const row = await loanRow(U, l.id);
    ok("U1 deleting the lender (also the approver) → the loan and its journal remain, the users NULL", del === "OK" && row?.s === "OUT" && row?.lb === null && row?.la === null
      && (await evs(U, l.id)).every((e) => e.u === null && e.ab === null), `${del} ${JSON.stringify(row)}`);
    const r = await loanAct(U, o.id, l.id, { type: "RETURN", conditionAtReturn: "GOOD" }, key(), { businessId: U.b, userId: U2 });
    ok("U2 the next user returns it", r === "OK" && Number((await loanRow(U, l.id))?.rb) === U2, r);
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED: " + failures.join("; ")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => owner.$disconnect());
