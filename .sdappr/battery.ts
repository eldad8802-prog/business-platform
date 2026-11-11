/**
 * Service Desk — actor and approver through the REAL service (runCaseAction, recordCharge, recordIntake, recordQa) AS the
 * runtime role, on the M1 chain + migration 20261130090000 (.sd3p4/lab.sh <db>, --deploy-only, .sdm1/chain.sh <db>,
 * .sdhov/chain.sh <db>). Synthetic only.
 *
 *   D  DELIVER writes the version-2 handover: the judged balance, the overpayment apart, a debt's reason + approver +
 *      approval time, the actor; UNKNOWN blocks and writes nothing
 *   K  COMPLETE stores the approver the same way
 *   F  forged identities: approverId / approvedByUserId / actorUserId / debtApprovedByUserId inside the action body are
 *      never stored (the service builds the action from named fields; the HTTP edge refuses them — approvals.test.ts);
 *      a principal of another business cannot act on the case; a principal naming a user of another business is refused
 *      by the database and writes nothing
 *   R  repeated / concurrent: the same Idempotency-Key replays (one record), reused with another body is refused; two
 *      connections delivering at once → one handover
 *
 * env: OWNER_URL (lab owner — fixtures), DATABASE_URL = DIRECT_URL (app_runtime_prod), TASK_REQUEST_HMAC_KEY / _ID,
 *      AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import { openCase, recordIntake, recordQa, runCaseAction, type OpenCaseInput, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";
import { recordCharge } from "../lib/services/service-desk/case-charge.service";
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
async function tryIt(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}:${JSON.stringify(e.details)}`;
    return `THROW:${(e as Error).message.replace(/\s+/g, " ").slice(-240)}`;
  }
}
const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdappr-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdappr-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await own(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  await own(b, `INSERT INTO "ServiceSettings" ("businessId", version, "updatedAt", "serviceProfileKey") VALUES ($1, 1, now(), 'general') RETURNING "businessId"`, b);
  return { b, u, cust, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
const open = async (z: Biz, input: Partial<OpenCaseInput>) =>
  (await openCase(z.p, { customerId: z.cust, problemDescription: "תקלה סינתטית", ...input }, { idempotencyKey: key() })).case;
const version = async (z: Biz, id: number) => Number((await own(z.b, `SELECT version FROM "ServiceCase" WHERE id = $1`, id))[0].version);
const status = async (z: Biz, id: number) => String((await own(z.b, `SELECT status::text s FROM "ServiceCase" WHERE id = $1`, id))[0].s);
async function act(z: Biz, id: number, action: Record<string, unknown>, k = key(), deps = {}, p = z.p): Promise<string> {
  const v = await version(z, id);
  return tryIt(() => runCaseAction(p, id, { action, expectedVersion: v }, { idempotencyKey: k }, deps));
}
async function walk(z: Biz, id: number, actions: Record<string, unknown>[]): Promise<string> {
  for (const a of actions) { const r = await act(z, id, a); if (r !== "OK") return `${String(a.type)}: ${r}`; }
  return "OK";
}
/** T1 (repair at the business) to READY: confirmed intake, QA, PASS. */
async function ready(z: Biz): Promise<number> {
  const c = await open(z, { track: "T1", subject: { displayName: "טלפון סינתטי" } });
  let v = await version(z, c.id);
  await recordIntake(z.p, c.id, { conditionNote: "שריטה", accessoriesNote: "ללא", conditionRecorded: true, accessoriesRecorded: true, expectedVersion: v }, { idempotencyKey: key() });
  const w = await walk(z, c.id, [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR" }]);
  if (w !== "OK") throw new Error(`T1 path: ${w}`);
  v = await version(z, c.id);
  await recordQa(z.p, c.id, { results: Object.fromEntries(QA_TEMPLATE_BY_ID["IN_SHOP.v1"].items.map((i) => [i.key, "PASS"])), expectedVersion: v }, { idempotencyKey: key() });
  const p = await walk(z, c.id, [{ type: "PASS_QA", outcome: "REPAIRED" }]);
  if (p !== "OK") throw new Error(`PASS_QA: ${p}`);
  return c.id;
}
const charge = async (z: Biz, id: number, body: { mode: string; amountAgorot?: number; reason?: string }) =>
  tryIt(async () => recordCharge(z.p, id, { ...body, expectedVersion: await version(z, id) }, { idempotencyKey: key() }));
const handover = async (z: Biz, id: number) => (await own(z.b, `SELECT "recordVersion" v, "openBalanceAgorot" o, "overpaidAgorot" p, "debtOverrideReason" r,
    "debtApprovedByUserId" a, "debtApprovedAt" IS NOT NULL t, "loanerApprovedByUserId" la, "actorUserId" u FROM "ServiceHandover" WHERE "caseId" = $1`, id));
const DELIVER = { type: "DELIVER", receipt: { handoverConfirmed: true, receivedByName: "דנה" } };
const FORGED = { approverId: 0, approverUserId: 0, approvedByUserId: 0, debtApprovedByUserId: 0, actorUserId: 0 };

async function main() {
  const A = await business("a");
  const B = await business("b");
  const A2 = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdappr-a2-${t}@lab.invalid`, A.b))[0].id);
  const forged = Object.fromEntries(Object.keys(FORGED).map((k) => [k, A2]));

  console.log("D — DELIVER writes the version-2 record");
  {
    const id = await ready(A);
    ok("D0 a charge of 120 ₪ with no document → an open debt of 12000", (await charge(A, id, { mode: "CHARGEABLE", amountAgorot: 12_000 })) === "OK");
    ok("D1 without the owner's decision → refused, nothing written", (await act(A, id, DELIVER)).includes("OPEN_BALANCE_NEEDS_OWNER_DECISION") && (await handover(A, id)).length === 0);
    const r = await act(A, id, { ...DELIVER, ...forged, debtOverride: { reason: "ישלם בהעברה", ...forged } });
    const h = (await handover(A, id))[0];
    ok("D2 with the decision (+ forged approver / actor fields in the body) → DELIVERED", r === "OK" && (await status(A, id)) === "DELIVERED", r);
    ok("D3 the record: version 2, debt 12000, overpaid 0, the reason, approval time", Number(h?.v) === 2 && Number(h?.o) === 12_000 && Number(h?.p) === 0 && h?.r === "ישלם בהעברה" && h?.t === true, JSON.stringify(h));
    ok("D4 actor AND approver = the session user — never the user the body named", Number(h?.u) === A.u && Number(h?.a) === A.u && Number(h?.a) !== A2, JSON.stringify(h));
    const ev = (await own(A.b, `SELECT "actorUserId" u, payload FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq DESC LIMIT 1`, id))[0];
    ok("D5 the journal event of the same transaction: the actor, the debt token, no reason text", Number(ev.u) === A.u && (ev.payload as Record<string, unknown>).debtOverride === true
      && !JSON.stringify(ev.payload).includes("ישלם"));
  }
  {
    const id = await ready(A);
    await charge(A, id, { mode: "NO_CHARGE", reason: "באחריות" });
    const r = await act(A, id, DELIVER);
    const h = (await handover(A, id))[0];
    ok("D6 settled → version 2, 0 / 0, no reason, no approver, no approval time", r === "OK" && Number(h?.v) === 2 && Number(h?.o) === 0 && Number(h?.p) === 0 && h?.r === null && h?.a === null && h?.t === false, `${r} ${JSON.stringify(h)}`);
  }
  {
    const id = await ready(A);
    const over = async () => ({ state: "SETTLED", openBalanceAgorot: 0, overpaidAgorot: 700 }) as const;
    const r = await act(A, id, DELIVER, key(), { settlement: over });
    const h = (await handover(A, id))[0];
    ok("D7 overpaid → the overpayment (700) stored apart; debt 0; no approval", r === "OK" && Number(h?.p) === 700 && Number(h?.o) === 0 && h?.a === null, `${r} ${JSON.stringify(h)}`);
  }
  {
    const id = await ready(A);
    const unknown = async () => ({ state: "UNKNOWN", openBalanceAgorot: null, reason: "CONFLICT" }) as const;
    const r = await act(A, id, { ...DELIVER, debtOverride: { reason: "x" } }, key(), { settlement: unknown });
    ok("D8 UNKNOWN balance → BALANCE_UNKNOWN even with a debt reason; no record; still READY", r.includes("BALANCE_UNKNOWN") && (await handover(A, id)).length === 0 && (await status(A, id)) === "READY", r);
  }

  console.log("K — COMPLETE stores the approver the same way");
  {
    const c = await open(A, { track: "T3", siteAddress: "רחוב סינתטי 1" });
    await walk(A, c.id, [{ type: "CHECK_IN" }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR", outcome: "REPAIRED" }]);
    await charge(A, c.id, { mode: "CHARGEABLE", amountAgorot: 9_000 });
    const r = await act(A, c.id, { type: "COMPLETE", completion: { completionType: "OWNER_CONFIRMED_ON_SITE", ownerConfirmed: true, ...forged },
      debtOverride: { reason: "סוף חודש", ...forged }, ...forged });
    const k = (await own(A.b, `SELECT "debtApprovedByUserId" a, "actorUserId" u, "openBalanceAgorot" o FROM "ServiceCompletion" WHERE "caseId" = $1`, c.id))[0];
    ok("K1 COMPLETE with a debt (+ forged fields): approver = actor = the session user", r === "OK" && Number(k?.a) === A.u && Number(k?.u) === A.u && Number(k?.o) === 9_000, `${r} ${JSON.stringify(k)}`);
  }

  console.log("F — forged identities");
  {
    const id = await ready(A);
    await charge(A, id, { mode: "CHARGEABLE", amountAgorot: 5_000 });
    const before = await version(A, id);
    const r1 = await act(A, id, { ...DELIVER, debtOverride: { reason: "x" } }, key(), {}, B.p);
    ok("F1 a principal of ANOTHER business → NOT_FOUND, nothing written", r1.startsWith("NOT_FOUND") && (await version(A, id)) === before && (await handover(A, id)).length === 0, r1);
    const r2 = await act(A, id, { ...DELIVER, debtOverride: { reason: "x" } }, key(), {}, { businessId: A.b, userId: B.u });
    ok("F2 a principal naming a user of another business (a mis-built session) → refused by the database, nothing written",
      r2.startsWith("REFUSED") && (await version(A, id)) === before && (await handover(A, id)).length === 0, r2);
    const r3 = await act(A, id, { ...DELIVER, debtOverride: { reason: "x" } }, key(), {}, { businessId: A.b, userId: A2 });
    const h = (await handover(A, id))[0];
    ok("F3 another user of the same business acting in their OWN session is recorded as actor AND approver (no attribution to the owner)",
      r3 === "OK" && Number(h?.u) === A2 && Number(h?.a) === A2, `${r3} ${JSON.stringify(h)}`);
  }

  console.log("R — repeated and concurrent");
  {
    const id = await ready(A);
    await charge(A, id, { mode: "CHARGEABLE", amountAgorot: 3_000 });
    const k = key();
    const v = await version(A, id);
    const body = { action: { ...DELIVER, debtOverride: { reason: "ישלם" } }, expectedVersion: v };
    const first = await tryIt(() => runCaseAction(A.p, id, body, { idempotencyKey: k }));
    const again = await tryIt(() => runCaseAction(A.p, id, body, { idempotencyKey: k }));
    const other = await tryIt(() => runCaseAction(A.p, id, { action: { ...DELIVER, debtOverride: { reason: "אחר" } }, expectedVersion: v }, { idempotencyKey: k }));
    ok("R1 the same key and body → replayed, one handover", first === "OK" && again === "OK" && (await handover(A, id)).length === 1);
    ok("R2 the same key with another body → IDEMPOTENCY_KEY_REUSED", other.startsWith("IDEMPOTENCY_KEY_REUSED"), other);
  }
  {
    const id = await ready(A);
    await charge(A, id, { mode: "NO_CHARGE", reason: "באחריות" });
    const v = await version(A, id);
    const both = await Promise.all([1, 2].map(() => tryIt(() => runCaseAction(A.p, id, { action: DELIVER, expectedVersion: v }, { idempotencyKey: key() }))));
    ok("R3 two concurrent DELIVERs (different keys) → exactly one wins; one handover", both.filter((x) => x === "OK").length === 1 && (await handover(A, id)).length === 1, both.join(" | "));
  }
  {
    const id = await ready(A);
    await charge(A, id, { mode: "NO_CHARGE", reason: "באחריות" });
    const v = await version(A, id);
    const k = key();
    const both = await Promise.all([1, 2].map(() => tryIt(() => runCaseAction(A.p, id, { action: DELIVER, expectedVersion: v }, { idempotencyKey: k }))));
    ok("R4 two concurrent DELIVERs with the SAME key → both answered OK (one replayed); one handover", both.every((x) => x === "OK") && (await handover(A, id)).length === 1, both.join(" | "));
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED: " + failures.join("; ")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => owner.$disconnect());
