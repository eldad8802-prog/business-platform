/**
 * Service Desk handover record (migration 20261130090000, DRAFT) — the database rules AS the real runtime role, on the M1
 * lab with the migration applied (.sd3p4/lab.sh <db>, --deploy-only, .sdm1/chain.sh <db>, .sdhov/chain.sh <db>).
 * Synthetic only.
 *
 *   H  the version-2 record: a KNOWN balance always stated (UNKNOWN unrepresentable), never negative, never debt AND
 *      overpayment; a debt only with reason + approver + approval time; the loaner exception the same; no approval
 *      fields without the exception; legacy shape refused for new rows; actor required; never born erased; business
 *      being deleted refused
 *   P  forged approver: another user of the same business, a user of another business, a deleted / non-existent user,
 *      an actor of another business — all refused by the database itself (approver = actor until an independent
 *      approver verification exists); the same rule on ServiceCompletion
 *   M  immutability: amounts, approvers, recordVersion, reasons never change; no DELETE / TRUNCATE; the erasure marker
 *      cannot be borrowed to change anything but the approvers to NULL; the runtime cannot UPDATE at all
 *   U  a deleted user only nulls the actor / approver; amounts and approval time stay
 *   C  concurrency: two connections deliver the same case at once → exactly one record
 *   I  isolation (RLS)   ·   L  legacy rows: readable, unchanged, cannot be upgraded or re-labelled
 *   E  erasure: refused unless deleting; clears approvers (this function) and the rest (foundation), either order; keeps
 *      amounts / times / version; re-run safe; another business untouched
 *
 * env: OWNER_URL (lab owner — fixtures), DIRECT_URL (app_runtime_prod).
 */
import { PrismaClient } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
const runtime2 = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Stmt = [string, ...unknown[]];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const err = (e: unknown) => (e as Error).message.replace(/\s+/g, " ").trim();
async function inTx(client: PrismaClient, b: number | null, stmts: Stmt[], setup: string[] = []): Promise<string> {
  try {
    await client.$transaction(async (tx) => {
      if (b !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
      for (const s of setup) await tx.$executeRawUnsafe(s);
      for (const [sql, ...a] of stmts) await tx.$executeRawUnsafe(sql, ...a);
    });
    return "OK";
  } catch (e) { return `ERR:${err(e).slice(-400)}`; }
}
const rt = (b: number, ...s: Stmt[]) => inTx(runtime, b, s);
const asOwner = (b: number, ...s: Stmt[]) => inTx(owner, b, s);
async function own(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}
async function rtRows(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}

const t = Date.now();
let caseNo = 1;
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `hov-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `hov-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await own(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  return { b, u, cust };
}
type Biz = Awaited<ReturnType<typeof business>>;
const user = async (z: Biz, tag: string) => Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `hov-${tag}-${t}-${caseNo++}@lab.invalid`, z.b))[0].id);
/** A case opened the way the foundation requires (the case and its case.opened event in one transaction). */
const kase = async (z: Biz) => owner.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(z.b));
  const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription")
    VALUES ($1, $2, 'IN_SHOP', $3, 'תקלה סינתטית') RETURNING id`, z.b, 10_000 + caseNo++, z.cust)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "toStatus", "cancellationRequestedBefore",
      "cancellationRequestedAfter", actor, "actorUserId", "idempotencyKey") VALUES ($1, $2, 1, 'case.opened', 'OPEN', 'OPEN', false, false, 'OWNER_USER', $3, $4)`,
    z.b, id, z.u, `hov-${t}-${id}`);
  return id;
});

type H = Partial<{ v: number | null; open: number; over: number | null; reason: string | null; approver: number | null; at: boolean;
  loanerReason: string | null; loanerApprover: number | null; loanerAt: boolean; actor: number | null; erased: boolean; name: string | null }>;
/** One handover INSERT; every field can be left out or falsified. recordVersion omitted when v === null (legacy writer). */
function handover(z: Biz, caseId: number, h: H = {}): Stmt {
  const cols = ["businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot", "overpaidAgorot", "debtOverrideReason",
    "debtApprovedByUserId", "debtApprovedAt", "loanerOverrideReason", "loanerApprovedByUserId", "loanerApprovedAt", "actorUserId", "erasedAt"];
  const vals: unknown[] = [z.b, caseId, h.name === undefined ? "דנה" : h.name, false, h.open ?? 0, h.over === undefined ? 0 : h.over, h.reason ?? null,
    h.approver ?? null, h.at ? new Date() : null, h.loanerReason ?? null, h.loanerApprover ?? null, h.loanerAt ? new Date() : null,
    h.actor === undefined ? z.u : h.actor, h.erased ? new Date() : null];
  if (h.v !== null) { cols.push("recordVersion"); vals.push(h.v ?? 2); }
  const casts = ["int", "int", "text", "boolean", "int", "int", "text", "int", "timestamp", "text", "int", "timestamp", "int", "timestamp", "smallint"];
  return [`INSERT INTO "ServiceHandover" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals.map((_, i) => `$${i + 1}::${casts[i]}`).join(", ")})`, ...vals];
}
const debtOk = (z: Biz, extra: H = {}): H => ({ open: 12_000, over: 0, reason: "ישלם מחר", approver: z.u, at: true, ...extra });

async function main() {
  const A = await business("a");
  const B = await business("b");
  const A2 = await user(A, "a2"); // another user of the SAME business (no staff accounts exist; a second user row is enough to prove attribution)

  console.log("H — the version-2 record");
  let r: string;
  r = await rt(A.b, handover(A, await kase(A)));
  ok("H1 settled (0 / 0), no exception → accepted", r === "OK", r);
  r = await rt(A.b, handover(A, await kase(A), { v: null }));
  ok("H2 the legacy writer (no recordVersion) → refused SERVICE_HANDOVER_RECORD_V2", r.includes("SERVICE_HANDOVER_RECORD_V2"), r);
  r = await rt(A.b, handover(A, await kase(A), { v: 1 }));
  ok("H3 recordVersion 1 stated explicitly → refused", r.includes("SERVICE_HANDOVER_RECORD_V2"), r);
  r = await rt(A.b, handover(A, await kase(A), { v: 3 }));
  ok("H4 recordVersion 3 → refused", r.startsWith("ERR"), r);
  r = await rt(A.b, handover(A, await kase(A), { over: null }));
  ok("H5 the overpayment not stated (UNKNOWN has no representation) → CHECK ServiceHandover_balance", r.includes("ServiceHandover_balance"), r);
  r = await rt(A.b, handover(A, await kase(A), { open: -300 }));
  ok("H6 a negative balance (the legacy overpayment form) → refused for a new record", r.includes("ServiceHandover_balance"), r);
  r = await rt(A.b, handover(A, await kase(A), debtOk(A, { over: 500 })));
  ok("H7 debt AND overpayment → refused", r.includes("ServiceHandover_balance"), r);
  r = await rt(A.b, handover(A, await kase(A), debtOk(A, { approver: null })));
  ok("H8 a debt without an approver → SERVICE_HANDOVER_DEBT_UNAPPROVED", r.includes("SERVICE_HANDOVER_DEBT_UNAPPROVED"), r);
  r = await rt(A.b, handover(A, await kase(A), debtOk(A, { reason: null })));
  ok("H9 a debt without a reason → CHECK ServiceHandover_debt_decided", r.includes("ServiceHandover_debt_decided"), r);
  r = await rt(A.b, handover(A, await kase(A), debtOk(A, { at: false })));
  ok("H10 a debt without the approval time → CHECK ServiceHandover_debt_decided", r.includes("ServiceHandover_debt_decided"), r);
  r = await rt(A.b, handover(A, await kase(A), { approver: A.u, at: true }));
  ok("H11 an approver without a debt → CHECK ServiceHandover_debt_decided", r.includes("ServiceHandover_debt_decided"), r);
  r = await rt(A.b, handover(A, await kase(A), { reason: "סתם" }));
  ok("H12 a debt reason without a debt → CHECK ServiceHandover_debt_decided", r.includes("ServiceHandover_debt_decided"), r);
  const cDebt = await kase(A);
  ok("H13 a debt with reason + approver (= the actor) + time → accepted", (await rt(A.b, handover(A, cDebt, debtOk(A)))) === "OK");
  const rec = (await own(A.b, `SELECT "recordVersion" v, "openBalanceAgorot" o, "overpaidAgorot" p, "debtOverrideReason" r, "debtApprovedByUserId" a,
      "debtApprovedAt" IS NOT NULL t, "actorUserId" u FROM "ServiceHandover" WHERE "caseId" = $1`, cDebt))[0];
  ok("H14 the record holds who acted, who approved, when, what (12000) and why", Number(rec.v) === 2 && Number(rec.o) === 12_000 && Number(rec.p) === 0
    && rec.r === "ישלם מחר" && Number(rec.a) === A.u && Number(rec.u) === A.u && rec.t === true, JSON.stringify(rec));
  const cOver = await kase(A);
  ok("H15 an overpayment (700) is stated apart, no approval → accepted", (await rt(A.b, handover(A, cOver, { over: 700 }))) === "OK"
    && Number((await own(A.b, `SELECT "overpaidAgorot" p FROM "ServiceHandover" WHERE "caseId" = $1`, cOver))[0].p) === 700);
  r = await rt(A.b, handover(A, await kase(A), { loanerReason: "יחזיר מחר", loanerAt: true }));
  ok("H16 loaner out without an approver → SERVICE_HANDOVER_LOANER_UNAPPROVED", r.includes("SERVICE_HANDOVER_LOANER_UNAPPROVED"), r);
  r = await rt(A.b, handover(A, await kase(A), { loanerReason: "יחזיר מחר", loanerApprover: A.u }));
  ok("H17 loaner exception without the approval time → CHECK ServiceHandover_loaner_decided", r.includes("ServiceHandover_loaner_decided"), r);
  r = await rt(A.b, handover(A, await kase(A), { loanerApprover: A.u, loanerAt: true }));
  ok("H18 a loaner approval without its reason → CHECK ServiceHandover_loaner_decided", r.includes("ServiceHandover_loaner_decided"), r);
  ok("H19 loaner exception with reason + approver + time → accepted", (await rt(A.b, handover(A, await kase(A), { loanerReason: "יחזיר מחר", loanerApprover: A.u, loanerAt: true }))) === "OK");
  r = await rt(A.b, handover(A, await kase(A), { actor: null }));
  ok("H20 no actor → SERVICE_HANDOVER_NEW", r.includes("SERVICE_HANDOVER_NEW"), r);
  r = await rt(A.b, handover(A, await kase(A), { erased: true, name: null }));
  ok("H21 born erased → SERVICE_HANDOVER_NEW", r.includes("SERVICE_HANDOVER_NEW"), r);
  const cTwice = await kase(A);
  await rt(A.b, handover(A, cTwice));
  r = await rt(A.b, handover(A, cTwice));
  ok("H22 a second handover of the same case → unique violation", /unique|23505/i.test(r), r);

  console.log("P — forged approver");
  r = await rt(A.b, handover(A, await kase(A), debtOk(A, { approver: A2 })));
  ok("P1 approver = ANOTHER user of the same business → SERVICE_APPROVER_NOT_ACTOR", r.includes("SERVICE_APPROVER_NOT_ACTOR"), r);
  r = await rt(A.b, handover(A, await kase(A), { loanerReason: "x", loanerApprover: A2, loanerAt: true }));
  ok("P2 loaner approver = another user → SERVICE_APPROVER_NOT_ACTOR", r.includes("SERVICE_APPROVER_NOT_ACTOR"), r);
  r = await rt(A.b, handover(A, await kase(A), debtOk(A, { approver: B.u })));
  ok("P3 approver = a user of ANOTHER business → refused", r.includes("SERVICE_APPROVER_NOT_ACTOR") || r.includes("SERVICE_USER_OTHER_BUSINESS"), r);
  r = await rt(A.b, handover(A, await kase(A), debtOk(A, { approver: B.u, actor: B.u })));
  ok("P4 actor AND approver = a user of another business → SERVICE_USER_OTHER_BUSINESS", r.includes("SERVICE_USER_OTHER_BUSINESS"), r);
  r = await rt(A.b, handover(A, await kase(A), { loanerReason: "x", loanerApprover: B.u, loanerAt: true, actor: B.u }));
  ok("P4b loaner exception only, actor = approver = a user of another business → SERVICE_USER_OTHER_BUSINESS", r.includes("SERVICE_USER_OTHER_BUSINESS"), r);
  r = await rt(A.b, handover(A, await kase(A), { actor: B.u }));
  ok("P4c no exception, the actor a user of another business → SERVICE_USER_OTHER_BUSINESS", r.includes("SERVICE_USER_OTHER_BUSINESS"), r);
  const gone = await user(A, "gone");
  await q(`DELETE FROM "User" WHERE id = $1`, gone);
  r = await rt(A.b, handover(A, await kase(A), debtOk(A, { approver: gone, actor: gone })));
  ok("P5 actor = approver = a DELETED user → refused", r.includes("SERVICE_USER_OTHER_BUSINESS") || /foreign key/i.test(r), r);
  r = await rt(A.b, handover(A, await kase(A), debtOk(A, { approver: 2_000_000_000 })));
  ok("P6 approver = a user id that never existed → refused", r.startsWith("ERR"), r);
  // ServiceCompletion: the approver check comes before the case-status check, so the refusal names it
  const cc = await kase(A);
  const completion = (approver: number): Stmt => [`INSERT INTO "ServiceCompletion" ("businessId", "caseId", "completionType", "openBalanceAgorot", "overpaidAgorot",
      "debtOverrideReason", "debtApprovedByUserId", "debtApprovedAt", "actorUserId") VALUES ($1, $2, 'OWNER_CONFIRMED_AT_BUSINESS', 5000, 0, 'סוף חודש', $3, now(), $4)`,
    A.b, cc, approver, A.u];
  r = await rt(A.b, completion(A2));
  ok("P7 ServiceCompletion: approver = another user → SERVICE_APPROVER_NOT_ACTOR", r.includes("SERVICE_APPROVER_NOT_ACTOR"), r);
  r = await rt(A.b, completion(A.u));
  ok("P8 control: approver = actor passes the approver rule (refused only for the case status)", r.includes("SERVICE_COMPLETION_NOT_WORK_DONE"), r);
  r = await asOwner(A.b, handover(A, await kase(A), debtOk(A, { approver: A2 })));
  ok("P9 even the table owner cannot attribute an approval to another user", r.includes("SERVICE_APPROVER_NOT_ACTOR"), r);

  console.log("M — immutability");
  const upd = (set: string): Stmt => [`UPDATE "ServiceHandover" SET ${set} WHERE "caseId" = $1`, cDebt];
  r = await rt(A.b, upd(`"openBalanceAgorot" = 0`));
  ok("M1 the runtime cannot UPDATE a handover at all", /permission denied/i.test(r), r);
  for (const [label, set] of [["the balance", `"openBalanceAgorot" = 1`], ["the overpayment", `"overpaidAgorot" = 5`],
    ["the approver (to another user)", `"debtApprovedByUserId" = ${A2}`], ["the approval time", `"debtApprovedAt" = now() - interval '1 day'`],
    ["the reason", `"debtOverrideReason" = 'אחר'`], ["the record version", `"recordVersion" = 1`]] as const) {
    r = await asOwner(A.b, upd(set));
    ok(`M2 the owner cannot change ${label} → SERVICE_HANDOVER_FIXED`, r.includes("SERVICE_HANDOVER_FIXED"), r);
  }
  r = await asOwner(A.b, [`DELETE FROM "ServiceHandover" WHERE "caseId" = $1`, cDebt]);
  ok("M3 DELETE → refused", r.includes("SERVICE_HANDOVER_FIXED"), r);
  r = await inTx(owner, A.b, [[`TRUNCATE "ServiceHandover"`]]);
  ok("M4 TRUNCATE → refused", r.startsWith("ERR"), r);
  r = await inTx(owner, A.b, [upd(`"debtApprovedByUserId" = ${A2}`)], [`SELECT set_config('dubiz.service_handover_erasure', 'on', true)`]);
  ok("M5 the erasure marker cannot be borrowed to re-attribute an approval", r.includes("SERVICE_HANDOVER_FIXED"), r);
  r = await inTx(owner, A.b, [upd(`"debtApprovedByUserId" = NULL, "openBalanceAgorot" = 0`)], [`SELECT set_config('dubiz.service_handover_erasure', 'on', true)`]);
  ok("M6 … nor to change an amount with it", r.includes("SERVICE_HANDOVER_FIXED"), r);
  r = await inTx(owner, A.b, [upd(`"receivedByName" = NULL, "debtOverrideReason" = NULL, "actorUserId" = NULL, "erasedAt" = now(), "debtApprovedByUserId" = ${A2}`)],
    [`SELECT set_config('dubiz.service_erasure', 'on', true)`]);
  ok("M7 the foundation erasure marker cannot re-attribute an approval either", r.includes("SERVICE_HANDOVER_FIXED"), r);
  r = await inTx(runtime, A.b, [[`SELECT public.service_handover_record_erase_business()`]]);
  ok("M8 the runtime calling the erase function for a live business → SERVICE_HANDOVER_ERASURE_NOT_DELETING", r.includes("SERVICE_HANDOVER_ERASURE_NOT_DELETING"), r);
  r = await inTx(runtime, null, [[`SELECT public.service_handover_record_erase_business()`]]);
  ok("M9 … and without a tenant context → SERVICE_HANDOVER_ERASURE_NO_CONTEXT", r.includes("SERVICE_HANDOVER_ERASURE_NO_CONTEXT"), r);

  console.log("U — a deleted user");
  const leaving = await user(A, "leaving");
  const cLeave = await kase(A);
  await rt(A.b, handover(A, cLeave, debtOk(A, { approver: leaving, actor: leaving, loanerReason: "x", loanerApprover: leaving, loanerAt: true })));
  await q(`DELETE FROM "User" WHERE id = $1`, leaving);
  const lv = (await own(A.b, `SELECT "actorUserId" u, "debtApprovedByUserId" a, "loanerApprovedByUserId" l, "openBalanceAgorot" o, "debtApprovedAt" IS NOT NULL t,
      "loanerApprovedAt" IS NOT NULL lt, "debtOverrideReason" r FROM "ServiceHandover" WHERE "caseId" = $1`, cLeave))[0];
  ok("U1 the user's deletion nulls actor and both approvers; amount, reasons and approval times stay", lv && lv.u === null && lv.a === null && lv.l === null
    && Number(lv.o) === 12_000 && lv.t === true && lv.lt === true && lv.r === "ישלם מחר", JSON.stringify(lv));

  console.log("C — concurrency");
  const cRace = await kase(A);
  const race = await Promise.all([inTx(runtime, A.b, [handover(A, cRace)]), inTx(runtime2, A.b, [handover(A, cRace, { over: 5 })])]);
  ok("C1 two connections deliver the same case at once → exactly one record", race.filter((x) => x === "OK").length === 1
    && Number((await own(A.b, `SELECT count(*)::int n FROM "ServiceHandover" WHERE "caseId" = $1`, cRace))[0].n) === 1, race.join(" | "));

  console.log("I — isolation");
  ok("I1 business B sees none of A's handovers", Number((await rtRows(B.b, `SELECT count(*)::int n FROM "ServiceHandover" WHERE "businessId" = $1`, A.b))[0].n) === 0);
  r = await rt(B.b, handover(A, await kase(A)));
  ok("I2 B cannot write a handover for A (RLS)", /row-level security|policy/i.test(r), r);

  console.log("L — legacy rows (written before the migration, by .sdhov/chain.sh)");
  const leg = await q(`SELECT h.id, h."businessId" b, h."openBalanceAgorot" o, h."recordVersion" v FROM "ServiceHandover" h JOIN "Business" x ON x.id = h."businessId" WHERE x.name = 'hov-legacy' ORDER BY h.id`);
  if (leg.length) {
    const lb = Number(leg[0].b);
    ok("L1 the legacy rows are readable through the runtime, version 1, a negative balance kept as it was",
      Number((await rtRows(lb, `SELECT count(*)::int n FROM "ServiceHandover" WHERE "recordVersion" = 1`))[0].n) === leg.length && leg.some((x) => Number(x.o) === -300));
    r = await inTx(owner, lb, [[`UPDATE "ServiceHandover" SET "recordVersion" = 2, "overpaidAgorot" = 300, "openBalanceAgorot" = 0 WHERE id = $1`, Number(leg[2].id)]]);
    ok("L2 a legacy row cannot be upgraded / re-labelled afterwards", r.includes("SERVICE_HANDOVER_FIXED"), r);
    r = await inTx(owner, lb, [[`UPDATE "ServiceHandover" SET "debtApprovedByUserId" = "actorUserId" WHERE id = $1`, Number(leg[1].id)]]);
    ok("L3 an approver cannot be added to a legacy debt after the fact", r.includes("SERVICE_HANDOVER_FIXED"), r);
  } else {
    ok("L0 legacy rows present (run .sdhov/chain.sh first)", false);
  }

  console.log("E — erasure");
  // A: the foundation erase first, then this one; D: the other order
  const D = await business("d");
  const cD = await kase(D);
  await rt(D.b, handover(D, cD, debtOk(D, { loanerReason: "x", loanerApprover: D.u, loanerAt: true })));
  await rt(B.b, handover(B, await kase(B), debtOk(B)));
  const bRow = (await own(B.b, `SELECT count(*)::int n FROM "ServiceHandover" WHERE "businessId" = $1 AND "debtApprovedByUserId" IS NOT NULL`, B.b))[0];
  for (const z of [A, D]) await q(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, z.b);
  r = await rt(A.b, handover(A, await kase(A)));
  ok("E1 a business being deleted cannot get a new handover → SERVICE_UI_BUSINESS_DELETING", r.includes("SERVICE_UI_BUSINESS_DELETING"), r);
  const n1 = await rtRows(A.b, `SELECT public.service_erase_business() AS f, public.service_handover_record_erase_business() AS h`).catch((e) => [{ h: 0, error: err(e).slice(-200) }] as Rows);
  const n2 = await rtRows(D.b, `SELECT public.service_handover_record_erase_business() AS h, public.service_erase_business() AS f`).catch((e) => [{ h: 0, error: err(e).slice(-200) }] as Rows);
  ok("E2 both orders run as the runtime (each touched rows)", Number(n1[0].h) > 0 && Number(n2[0].h) > 0, JSON.stringify([n1, n2]));
  for (const [z, c, label] of [[A, cDebt, "foundation first"], [D, cD, "this function first"]] as const) {
    const e = (await own(z.b, `SELECT "receivedByName" n, "debtOverrideReason" r, "loanerOverrideReason" lr, "actorUserId" u, "debtApprovedByUserId" a,
        "loanerApprovedByUserId" l, "openBalanceAgorot" o, "overpaidAgorot" p, "recordVersion" v, "debtApprovedAt" IS NOT NULL t, "erasedAt" IS NOT NULL x
        FROM "ServiceHandover" WHERE "caseId" = $1`, c))[0];
    ok(`E3 (${label}) persons cleared (receiver, reasons, actor, approvers); amount, overpayment, version, approval time kept; erasedAt stamped`,
      e.n === null && e.r === null && e.lr === null && e.u === null && e.a === null && e.l === null && Number(e.o) === 12_000 && Number(e.p) === 0
      && Number(e.v) === 2 && e.t === true && e.x === true, JSON.stringify(e));
  }
  const again = await rtRows(A.b, `SELECT public.service_handover_record_erase_business() AS h`);
  ok("E4 re-run safe: 0 rows the second time", Number(again[0].h) === 0);
  ok("E5 no approver left in A or D", Number((await q(`SELECT count(*)::int n FROM "ServiceHandover" WHERE "businessId" IN ($1, $2) AND ("debtApprovedByUserId" IS NOT NULL OR "loanerApprovedByUserId" IS NOT NULL)`, A.b, D.b))[0].n) === 0);
  const bAfter = (await own(B.b, `SELECT count(*)::int n FROM "ServiceHandover" WHERE "businessId" = $1 AND "debtApprovedByUserId" IS NOT NULL`, B.b))[0];
  ok("E6 business B untouched (its approvers still named)", Number(bRow.n) >= 1 && Number(bAfter.n) === Number(bRow.n), JSON.stringify([bRow, bAfter]));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED: " + failures.join("; ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); await runtime2.$disconnect(); });
