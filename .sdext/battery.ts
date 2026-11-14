/**
 * Service Desk 1d-A — work at an external supplier: the data service AS the real runtime role, on the P4 lab
 * (.sd3p4/lab.sh <db> then --deploy-only: 1.2a + 1.2b + M2 + 1.3-0 + P4 applied by migrate deploy). Synthetic only.
 *
 *   X  send: case → EXTERNAL with its event, the work (round, SENT, v1) with its event, one key and digest in both;
 *      replay; same key + other body; wrong status; inactive / foreign supplier; reason required; RMA token shape;
 *      a second send while out; a device already at a supplier; the reason never in a journal payload.
 *   W  while away: progress forward only (skips allowed), the supplier reference once, the expected date, three costs,
 *      the final cost once, the correction with previous value and reason (reason in its column, not the payload);
 *      stale version; replay; a send key reused for a work action.
 *   R  return: READY / REPAIRED with a cover; REPLACED out of scope; a result that contradicts the outcome; back to
 *      IN_REPAIR then a second round; the final cost after the return once, estimates after it refused; a cancel
 *      requested at the supplier completes on the return (READY / CANCELLED); parts still at the supplier block it.
 *   G  database guards as the runtime role: a work change without its event rolls back; the case cannot leave EXTERNAL
 *      while its work is out; the work journal is append-only.
 *   I  isolation: another business cannot list, send, act on or return a work.
 *   K  races: two sends at once (one wins); one send key five times (one work); two work actions at one version (one
 *      wins); a return racing a progress (both serialised, the journal consistent).
 *   L  closed to users: with FULL access every external-work route answers 422 ACTION_NOT_IN_SCOPE and writes nothing;
 *      401 with no session; 404 when the module is NONE; the case action route still refuses SEND_TO_EXTERNAL.
 *
 * env: OWNER_URL (lab owner), SUPER_URL (lab superuser — fixtures only), DATABASE_URL = DIRECT_URL (app_runtime_prod),
 *      TASK_REQUEST_HMAC_KEY / _ID, AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import { openCase, runCaseAction, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";
import {
  EXTERNAL_WORK_OPEN, listExternalWork, returnFromExternal, runExternalWorkAction, sendToExternal,
} from "../lib/services/service-desk/external-work.service";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
const sup = new PrismaClient({ datasourceUrl: process.env.SUPER_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const n = async (sql: string, ...a: unknown[]) => Number((await q(sql, ...a))[0]?.n);
const key = (at = new Date()) => uuidV7(at);
async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}${e.details && Object.keys(e.details).length ? ":" + JSON.stringify(e.details) : ""}`;
    return `ERR:${(e as Error).message.slice(0, 200)}`;
  }
}
const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdext-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdext-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  const staff = Number((await q(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאי', now()) RETURNING id`, b))[0].id);
  const supplier = Number((await q(`INSERT INTO "Supplier" ("businessId", name, "updatedAt") VALUES ($1, 'ספק מעבדה', now()) RETURNING id`, b))[0].id);
  const inactive = Number((await q(`INSERT INTO "Supplier" ("businessId", name, "isActive", "updatedAt") VALUES ($1, 'ספק לא פעיל', false, now()) RETURNING id`, b))[0].id);
  const device = Number((await q(`INSERT INTO "ServiceDevice" ("businessId", "customerId", category, "updatedAt") VALUES ($1, $2, 'AC', now()) RETURNING id`, b, cust))[0].id);
  return { b, u, cust, staff, supplier, inactive, device, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
const act = (z: Biz, id: number, action: Record<string, unknown>, v: number, k = key()) => runCaseAction(z.p, id, { action, expectedVersion: v }, { idempotencyKey: k });
/** A FIELD case in DIAGNOSING (on-site check-in needs no signature; the lab gives it an approved cover for repairs). */
async function diagnosing(z: Biz, device: number | null = null) {
  const o = await openCase(z.p, { kind: "FIELD", customerId: z.cust, problemDescription: "המזגן לא מקרר", ...(device ? { deviceId: device } : {}) }, { idempotencyKey: key() });
  const ci = await act(z, o.case.id, { type: "CHECK_IN" }, 1);
  const dg = await act(z, o.case.id, { type: "START_DIAGNOSIS" }, ci.case.version);
  await x(`UPDATE "ServiceCase" SET "coverageSource" = 'MANUFACTURER', "coverageDecision" = 'APPROVED' WHERE id = $1`, o.case.id); // lab: a cover
  return { id: o.case.id, v: dg.case.version };
}
const send = (z: Biz, caseId: number, v: number, extra: Record<string, unknown> = {}, k = key()) =>
  sendToExternal(z.p, caseId, { expectedVersion: v, supplierId: z.supplier, sendReason: "נדרש תיקון לוח אם אצל היבואן — דנה 050-1234567", requestedWork: "החלפת לוח", ...extra }, { idempotencyKey: k });
const wact = (z: Biz, workId: number, action: Record<string, unknown>, v: number, k = key()) => runExternalWorkAction(z.p, workId, { action, expectedVersion: v }, { idempotencyKey: k });
const ret = (z: Biz, workId: number, wv: number, cv: number, extra: Record<string, unknown> = {}, k = key()) =>
  returnFromExternal(z.p, workId, { expectedVersion: wv, caseExpectedVersion: cv, next: "READY", outcome: "REPAIRED", result: "REPAIRED", followUpRequired: false, ...extra }, { idempotencyKey: k });
const caseEvents = (id: number) => n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, id);
const workEvents = (workId: number) => n(`SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "workId" = $1`, workId);
const works = (caseId: number) => n(`SELECT count(*)::int AS n FROM "ServiceExternalWork" WHERE "caseId" = $1`, caseId);

async function main() {
  const A = await business("a"), B = await business("b");
  ok("setup: the external-work routes are open in code (EXTERNAL_WORK_OPEN = true — the unlock PR)", EXTERNAL_WORK_OPEN === true);

  console.log("X — send");
  const c1 = await diagnosing(A, A.device);
  const ks = key();
  const s1 = await send(A, c1.id, c1.v, { supplierReference: "RMA-1001", expectedBackOn: "2026-12-01" }, ks);
  const ev = (await q(`SELECT seq, "eventType"::text et, "idempotencyKey" k, payload::text p FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq DESC LIMIT 1`, c1.id))[0];
  const wev = (await q(`SELECT seq, kind::text k, "idempotencyKey" ik, payload::text p FROM "ServiceExternalWorkEvent" WHERE "workId" = $1`, s1.work.id))[0];
  ok("X1 send from DIAGNOSING → case EXTERNAL v+1 with external.sent; the work round 1 / SENT / v1 with its SENT event; one key in both",
    s1.case.status === "EXTERNAL" && s1.case.version === c1.v + 1 && Number(ev.seq) === c1.v + 1 && ev.et === "external.sent"
      && s1.work.round === 1 && s1.work.progressStage === "SENT" && s1.work.version === 1 && s1.work.deviceId === A.device
      && Number(wev.seq) === 1 && wev.k === "SENT" && wev.ik === ks && ev.k === ks && !s1.replayed);
  ok("X2 the send reason is in its column only — never in either journal payload",
    s1.work.sendReason?.includes("דנה") === true && !String(ev.p).includes("דנה") && !String(wev.p).includes("דנה") && !String(wev.p).includes("050"));
  const r1 = await send(A, c1.id, c1.v, { supplierReference: "RMA-1001", expectedBackOn: "2026-12-01" }, ks);
  ok("X3 the same key + same request → the stored result (replayed); still one work, one case event, one work event",
    r1.replayed && r1.work.id === s1.work.id && (await works(c1.id)) === 1 && (await workEvents(s1.work.id)) === 1 && (await caseEvents(c1.id)) === c1.v + 1);
  ok("X4 the same key + another request → IDEMPOTENCY_KEY_REUSED", (await code(() => send(A, c1.id, c1.v, { requestedWork: "אחר" }, ks))) === "IDEMPOTENCY_KEY_REUSED");
  ok("X5 a second send while the item is out → refused (the case is EXTERNAL); nothing written",
    (await code(() => send(A, c1.id, s1.case.version))).startsWith("REFUSED") && (await works(c1.id)) === 1);
  const open1 = await openCase(A.p, { kind: "FIELD", customerId: A.cust, problemDescription: "תקלה" }, { idempotencyKey: key() });
  ok("X6 a case still OPEN → refused, nothing written", (await code(() => send(A, open1.case.id, 1))).startsWith("REFUSED") && (await works(open1.case.id)) === 0);
  const c2 = await diagnosing(A);
  ok("X7 an inactive supplier → REFUSED SUPPLIER_INACTIVE; a supplier of another business → refused the same way (never revealed)",
    (await code(() => send(A, c2.id, c2.v, { supplierId: A.inactive }))).includes("SUPPLIER_INACTIVE")
      && (await code(() => send(A, c2.id, c2.v, { supplierId: B.supplier }))).includes("SUPPLIER_INACTIVE") && (await works(c2.id)) === 0);
  ok("X8 a blank reason → REASON_REQUIRED; an RMA with a space or an e-mail → SUPPLIER_REFERENCE_INVALID",
    (await code(() => send(A, c2.id, c2.v, { sendReason: "   " }))).includes("REASON_REQUIRED")
      && (await code(() => send(A, c2.id, c2.v, { supplierReference: "dana@x.co" }))).includes("SUPPLIER_REFERENCE_INVALID")
      && (await code(() => send(A, c2.id, c2.v, { supplierReference: "RMA 1" }))).includes("SUPPLIER_REFERENCE_INVALID"));
  const c3 = await diagnosing(A, A.device);
  ok("X9 the same device already at a supplier (another case) → refused, nothing written",
    /DEVICE_ALREADY_AT_SUPPLIER|NO_OPEN_WORK_FOR_DEVICE/.test(await code(() => send(A, c3.id, c3.v))) && (await works(c3.id)) === 0);
  ok("X10 a stale case version → VERSION_CONFLICT", (await code(() => send(A, c2.id, c2.v - 1))) === "VERSION_CONFLICT");

  console.log("W — while the item is away");
  const w = s1.work.id;
  const p1 = await wact(A, w, { type: "RECORD_PROGRESS", stage: "AWAITING_DIAGNOSIS" }, 1);
  ok("W1 progress forward (one stage skipped) → v2, PROGRESS event with skipped = 1", p1.work.progressStage === "AWAITING_DIAGNOSIS" && p1.work.version === 2
    && (await q(`SELECT payload->>'skipped' s FROM "ServiceExternalWorkEvent" WHERE "workId" = $1 AND seq = 2`, w))[0].s === "1");
  ok("W2 backward → PROGRESS_NOT_FORWARD; the same stage → PROGRESS_UNCHANGED; the supplier reference already set → refused",
    (await code(() => wact(A, w, { type: "RECORD_PROGRESS", stage: "SENT" }, 2))).includes("PROGRESS_NOT_FORWARD")
      && (await code(() => wact(A, w, { type: "RECORD_PROGRESS", stage: "AWAITING_DIAGNOSIS" }, 2))).includes("PROGRESS_UNCHANGED")
      && (await code(() => wact(A, w, { type: "RECORD_PROGRESS", stage: "ESTIMATE_RECEIVED", supplierReference: "RMA-2" }, 2))).includes("SUPPLIER_REFERENCE_ALREADY_SET"));
  const e1 = await wact(A, w, { type: "CHANGE_EXPECTED_BACK", expectedBackOn: "2026-12-10" }, 2);
  const est = await wact(A, w, { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: 45000 }, e1.work.version);
  const apr = await wact(A, w, { type: "RECORD_COST", kind: "APPROVED", amountAgorot: 40000 }, est.work.version);
  ok("W3 expected date, estimated and approved costs → one event each, the amounts on the events", e1.work.expectedBackOn === "2026-12-10"
    && apr.work.estimatedCostAgorot === 45000 && apr.work.approvedCostAgorot === 40000
    && (await n(`SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "workId" = $1 AND kind IN ('COST_ESTIMATED','COST_APPROVED') AND "amountAgorot" IS NOT NULL`, w)) === 2);
  ok("W4 a stale work version → VERSION_CONFLICT, nothing written", (await code(() => wact(A, w, { type: "RECORD_PROGRESS", stage: "REPAIR_DONE" }, 2))) === "VERSION_CONFLICT" && (await workEvents(w)) === apr.work.version);
  const kw = key();
  const pr = await wact(A, w, { type: "RECORD_PROGRESS", stage: "REPAIR_DONE" }, apr.work.version, kw);
  const pr2 = await wact(A, w, { type: "RECORD_PROGRESS", stage: "REPAIR_DONE" }, apr.work.version, kw);
  ok("W5 a work action replayed with its key → the stored result, one event", pr2.replayed && pr2.work.version === pr.work.version && (await workEvents(w)) === pr.work.version);
  ok("W6 the send's key reused for a work action → IDEMPOTENCY_KEY_REUSED", (await code(() => wact(A, w, { type: "RECORD_PROGRESS", stage: "READY_FOR_PICKUP" }, pr.work.version, ks))) === "IDEMPOTENCY_KEY_REUSED");
  ok("W7 a correction before any final cost → FINAL_COST_NOT_RECORDED", (await code(() => wact(A, w, { type: "CORRECT_FINAL_COST", amountAgorot: 1, reason: "טעות" }, pr.work.version))).includes("FINAL_COST_NOT_RECORDED"));

  console.log("R — return");
  ok("R1 an outcome REPLACED → ACTION_NOT_IN_SCOPE (the replacement device link is 1.3c)",
    (await code(() => ret(A, w, pr.work.version, s1.case.version, { outcome: "REPLACED", result: "REPLACED_BY_SUPPLIER" }))).startsWith("ACTION_NOT_IN_SCOPE"));
  ok("R2 a result NOT_REPAIRED with an outcome REPAIRED → RESULT_CONTRADICTS_OUTCOME", (await code(() => ret(A, w, pr.work.version, s1.case.version, { result: "NOT_REPAIRED" }))).includes("RESULT_CONTRADICTS_OUTCOME"));
  const rt = await ret(A, w, pr.work.version, s1.case.version, { finalCostAgorot: 41000, workPerformed: "הוחלף לוח" });
  ok("R3 return REPAIRED with a cover → case READY / REPAIRED with external.returned; the work RETURNED with its final cost and RETURNED event",
    rt.case.status === "READY" && rt.case.outcome === "REPAIRED" && rt.work.state === "RETURNED" && rt.work.returnResult === "REPAIRED" && rt.work.finalCostAgorot === 41000
      && (await q(`SELECT kind::text k, "amountAgorot" a FROM "ServiceExternalWorkEvent" WHERE "workId" = $1 ORDER BY seq DESC LIMIT 1`, w))[0].k === "RETURNED"
      && (await q(`SELECT "eventType"::text e FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq DESC LIMIT 1`, c1.id))[0].e === "external.returned");
  ok("R4 after the return: an estimate is refused; the final cost again is refused (correct it instead)",
    (await code(() => wact(A, w, { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: 1 }, rt.work.version))).includes("COST_NOT_ALLOWED_AFTER_RETURN")
      && (await code(() => wact(A, w, { type: "RECORD_COST", kind: "FINAL", amountAgorot: 1 }, rt.work.version))).includes("FINAL_COST_ALREADY_RECORDED"));
  const cor = await wact(A, w, { type: "CORRECT_FINAL_COST", amountAgorot: 39000, reason: "חשבונית מתוקנת מהספק — יוסי" }, rt.work.version);
  const corEv = (await q(`SELECT "previousAmountAgorot" p, "amountAgorot" a, reason r, payload::text pl FROM "ServiceExternalWorkEvent" WHERE "workId" = $1 ORDER BY seq DESC LIMIT 1`, w))[0];
  ok("R5 the final-cost correction keeps previous and new value; the reason in its column, not in the payload",
    cor.work.finalCostAgorot === 39000 && Number(corEv.p) === 41000 && Number(corEv.a) === 39000 && String(corEv.r).includes("יוסי") && !String(corEv.pl).includes("יוסי"));
  // a second round: back to IN_REPAIR, then out again
  const c4 = await diagnosing(A);
  const s4 = await send(A, c4.id, c4.v);
  const r4 = await ret(A, s4.work.id, 1, s4.case.version, { next: "IN_REPAIR", outcome: undefined, result: "RETURNED_UNWORKED" });
  const s4b = await send(A, c4.id, r4.case.version);
  ok("R6 back to IN_REPAIR (no outcome), then a second send → round 2 of the same case", r4.case.status === "IN_REPAIR" && s4b.work.round === 2 && (await works(c4.id)) === 2);
  // a cancel requested at the supplier completes on the return
  const c5 = await diagnosing(A);
  const s5 = await send(A, c5.id, c5.v);
  const cxCode = await code(() => act(A, c5.id, { type: "CANCEL", reason: "הלקוח ביטל" }, s5.case.version));
  const c5row = (await q(`SELECT status::text s, "cancellationRequested" r, version v FROM "ServiceCase" WHERE id = $1`, c5.id))[0];
  ok("R7 cancel while the item is at the supplier → requested only (status EXTERNAL, cancellationRequested)", cxCode === "OK" && c5row.s === "EXTERNAL" && c5row.r === true, cxCode);
  if (cxCode === "OK") {
    const r5 = await ret(A, s5.work.id, 1, Number(c5row.v), { outcome: undefined, result: "RETURNED_UNWORKED" });
    ok("R8 … the return completes it: READY / CANCELLED, the request cleared", r5.case.status === "READY" && r5.case.outcome === "CANCELLED"
      && (await q(`SELECT "cancellationRequested" r FROM "ServiceCase" WHERE id = $1`, c5.id))[0].r === false);
  } else ok("R8 … the return completes it (skipped: the cancel was refused)", false, cxCode);
  // parts still at the supplier block the return (fixture written as the superuser, triggers off — a lab-only shortcut)
  const c6 = await diagnosing(A);
  const s6 = await send(A, c6.id, c6.v);
  await sup.$executeRawUnsafe(`SET session_replication_role = replica`);
  await sup.$executeRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "costSource", "nameSnapshot", quantity, "externalWorkId", version, "lastEventKind", "updatedAt")
    VALUES ($1, $2, 'NON_STOCK', 'ISSUED', 'NONE', 'חלק לבדיקה', 1, $3, 2, 'SENT_WITH_EXTERNAL', now())`, A.b, c6.id, s6.work.id);
  await sup.$executeRawUnsafe(`SET session_replication_role = origin`);
  ok("R9 a part that went with the work and is still out → REFUSED PARTS_STILL_AT_SUPPLIER, nothing written",
    (await code(() => ret(A, s6.work.id, 1, s6.case.version))).includes("PARTS_STILL_AT_SUPPLIER") && (await workEvents(s6.work.id)) === 1);

  console.log("G — database guards (runtime role)");
  const gWork = s6.work.id;
  const silent = await runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(A.b));
    await tx.$executeRawUnsafe(`UPDATE "ServiceExternalWork" SET "progressStage" = 'RECEIVED_BY_SUPPLIER', version = 2, "lastEventKind" = 'PROGRESS' WHERE id = $1`, gWork);
  }).then(() => "COMMITTED", (e) => String((e as Error).message));
  ok("G1 a work change without its event → rolled back at commit (SERVICE_EXTERNAL_SILENT_CHANGE)", /SILENT_CHANGE|DZX03/.test(silent) && (await q(`SELECT version v FROM "ServiceExternalWork" WHERE id = $1`, gWork))[0].v === 1, silent.slice(0, 120));
  const leave = await runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(A.b));
    await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET status = 'IN_REPAIR', version = version + 1 WHERE id = $1`, c6.id);
  }).then(() => "COMMITTED", (e) => String((e as Error).message));
  ok("G2 the case cannot leave EXTERNAL while its work is out (SERVICE_CASE_LEFT_EXTERNAL)", /LEFT_EXTERNAL|DZX07|SILENT|NOT_OPENED|DZS/.test(leave), leave.slice(0, 120));
  const del = await runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(A.b));
    await tx.$executeRawUnsafe(`DELETE FROM "ServiceExternalWorkEvent" WHERE "workId" = $1`, gWork);
  }).then(() => "COMMITTED", (e) => String((e as Error).message));
  ok("G3 the work journal is append-only for the runtime role", del !== "COMMITTED" && (await workEvents(gWork)) === 1, del.slice(0, 120));

  console.log("I — isolation");
  ok("I1 another business cannot list A's case works, send on A's case, act on or return A's work (NOT_FOUND)",
    (await code(() => listExternalWork(B.b, c1.id))) === "NOT_FOUND"
      && (await code(() => sendToExternal(B.p, c2.id, { expectedVersion: c2.v, supplierId: B.supplier, sendReason: "x" }, { idempotencyKey: key() }))) === "NOT_FOUND"
      && (await code(() => wact(B, w, { type: "RECORD_PROGRESS", stage: "READY_FOR_PICKUP" }, cor.work.version))) === "NOT_FOUND"
      && (await code(() => ret(B, s6.work.id, 1, s6.case.version))) === "NOT_FOUND");
  const list = await listExternalWork(A.b, c4.id);
  ok("I2 A's list: newest round first, each work with its journal", list.works.length === 2 && list.works[0].round === 2 && list.works[1].events.length >= 2);

  console.log("K — races");
  const k1 = await diagnosing(A);
  const both = await Promise.all([code(() => send(A, k1.id, k1.v)), code(() => send(A, k1.id, k1.v))]);
  ok("K1 two sends of one case at once → exactly one work", both.filter((r) => r === "OK").length === 1 && (await works(k1.id)) === 1, JSON.stringify(both));
  const k2 = await diagnosing(A);
  const kk = key();
  const five = await Promise.all(Array.from({ length: 5 }, () => send(A, k2.id, k2.v, {}, kk).then((r) => r.work.id, (e) => `E:${(e as Error).message}`)));
  ok("K2 one send key five times at once → one work, every answer the same work", new Set(five).size === 1 && typeof five[0] === "number" && (await works(k2.id)) === 1, JSON.stringify(five));
  const k2w = five[0] as number;
  const two = await Promise.all([code(() => wact(A, k2w, { type: "RECORD_PROGRESS", stage: "RECEIVED_BY_SUPPLIER" }, 1)), code(() => wact(A, k2w, { type: "CHANGE_EXPECTED_BACK", expectedBackOn: "2027-01-01" }, 1))]);
  ok("K3 two work actions at one version → one wins, the other VERSION_CONFLICT; the journal has v1 + v2 only", two.filter((r) => r === "OK").length === 1 && two.includes("VERSION_CONFLICT") && (await workEvents(k2w)) === 2, JSON.stringify(two));
  const cv = Number((await q(`SELECT version v FROM "ServiceCase" WHERE id = $1`, k2.id))[0].v);
  const race = await Promise.all([code(() => ret(A, k2w, 2, cv)), code(() => wact(A, k2w, { type: "RECORD_PROGRESS", stage: "REPAIR_DONE" }, 2))]);
  const after = (await q(`SELECT version v, state::text s FROM "ServiceExternalWork" WHERE id = $1`, k2w))[0];
  ok("K4 a return racing a progress at the same work version → one wins; work version = journal length; case consistent",
    race.filter((r) => r === "OK").length === 1 && Number(after.v) === (await workEvents(k2w))
      && ((after.s === "RETURNED") === ((await q(`SELECT status::text s FROM "ServiceCase" WHERE id = $1`, k2.id))[0].s !== "EXTERNAL")), JSON.stringify(race));

  console.log("L — closed to users (owner rule)");
  const setOverride = async (b: number, state: "ENABLED" | null) => {
    await x(`DELETE FROM "BusinessFeatureAccess" WHERE "businessId" = $1 AND "featureKey" = 'service_desk'`, b);
    if (state) await x(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", state, reason, "updatedAt") VALUES ($1, 'service_desk', 'ENABLED', 'sdext lab', now())`, b);
  };
  const { signAuthToken } = await import("../lib/auth-token");
  const tokenA = signAuthToken(A.u);
  const routes = {
    caseWork: await import("../app/api/service-desk/cases/[id]/external-work/route"),
    actions: await import("../app/api/service-desk/external-work/[workId]/actions/route"),
    ret: await import("../app/api/service-desk/external-work/[workId]/return/route"),
    caseAction: await import("../app/api/service-desk/cases/[id]/actions/route"),
  };
  const http = (method: string, body: unknown, token: string | null) => new Request("https://lab.test/api/service-desk/x", {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "idempotency-key": key() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const c7 = await diagnosing(A);
  const snap = async () => JSON.stringify([await works(c7.id), await caseEvents(c7.id), await n(`SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "businessId" = $1`, A.b)]);
  const calls = async (token: string | null) => [
    await routes.caseWork.GET(http("GET", undefined, token), { params: Promise.resolve({ id: String(c7.id) }) }),
    await routes.caseWork.POST(http("POST", { expectedVersion: c7.v, supplierId: A.supplier, sendReason: "x" }, token), { params: Promise.resolve({ id: String(c7.id) }) }),
    await routes.actions.POST(http("POST", { action: { type: "RECORD_PROGRESS", stage: "REPAIR_DONE" }, expectedVersion: 1 }, token), { params: Promise.resolve({ workId: String(k2w) }) }),
    await routes.ret.POST(http("POST", { expectedVersion: 1, caseExpectedVersion: 1, next: "READY", result: "REPAIRED", followUpRequired: false }, token), { params: Promise.resolve({ workId: String(k2w) }) }),
  ];
  await setOverride(A.b, "ENABLED"); // FULL for A (lab only)
  const before = await snap();
  const full = await calls(tokenA);
  const bodies = await Promise.all(full.map((r) => r.json()));
  ok("L1 FULL access: the external-work routes reach the service (no ACTION_NOT_IN_SCOPE lock answer)", bodies.every((b) => !(b?.error === "ACTION_NOT_IN_SCOPE" && b?.details?.capability === "external_work")), JSON.stringify(full.map((r) => r.status)));
  {
    const b = JSON.parse(before) as [number, number, number]; const a = JSON.parse(await snap()) as [number, number, number];
    const newWorks = a[0] - b[0];
    ok("L2 … and every write through the open routes is journaled (a new external work comes with its case and work events)",
      newWorks <= 0 || (a[1] > b[1] && a[2] > b[2]), `works ${b[0]}→${a[0]}, case events ${b[1]}→${a[1]}, work events ${b[2]}→${a[2]}`);
  }
  const viaCase = await routes.caseAction.POST(http("POST", { action: { type: "SEND_TO_EXTERNAL", supplierId: A.supplier }, expectedVersion: c7.v }, tokenA), { params: Promise.resolve({ id: String(c7.id) }) });
  ok("L3 the generic case action route still refuses SEND_TO_EXTERNAL (ACTION_NOT_IN_SCOPE)", viaCase.status === 422 && (await viaCase.json()).error === "ACTION_NOT_IN_SCOPE");
  ok("L4 no session → 401", (await calls(null)).every((r) => r.status === 401));
  await setOverride(A.b, null);
  ok("L5 module NONE (not launched) → 404 before the lock", (await calls(tokenA)).every((r) => r.status === 404));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
}

main()
  .catch((e) => { failures.push(`crash: ${(e as Error).message}`); console.error(e); console.log(`\n${pass} passed, ${failures.length} failed`); })
  .finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); await sup.$disconnect(); process.exit(failures.length ? 1 : 0); });
