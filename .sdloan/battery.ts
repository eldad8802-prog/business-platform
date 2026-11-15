/**
 * Service Desk loans (migration 20261201090000, DRAFT) — the database rules AS the real runtime role, on the handover-record
 * lab with this migration applied (.sd3p4/lab.sh <db>, --deploy-only, .sdm1/chain.sh <db>, .sdhov/chain.sh <db>,
 * .sdloan/chain.sh <db>). Synthetic only.
 *
 *   S  shape: two tables FORCE RLS, no DELETE grant, one SECURITY DEFINER function
 *   N  a normal loan in every work status: the initial row, the LENT event, the identifier normalized by the database,
 *      lentAt stamped by it
 *   X  statuses: OPEN / SCHEDULED / READY only as an approved exception; never WORK_DONE / DELIVERED / ABANDONED / CLOSED /
 *      CANCELLED, nor a case being cancelled; a work status takes no exception
 *   D  double loan: the same identified item (any spelling) never OUT twice; again after its return; unidentified items
 *   R  return: once, with its condition, stamped by the database; any case status (also delivered / closed / cancelled);
 *      a second return refused; nothing deleted; no silent change; the event mirrors the loan
 *   C  close without a return: approved (approver = actor), with a reason
 *   E  case exit: CANCEL / cancel request / held-item cancel / ABANDON with a loan OUT only with an approval bound to that
 *      case event; the loan stays OUT; CLOSED refused while a loan is OUT
 *   H  handover with a loan OUT carries the loaner exception; with NO loan out (never lent, returned, closed, after a
 *      cancel) no loaner field is saved (SERVICE_HANDOVER_LOANER_NONE); without a loan the plain handover is unchanged
 *   L  handovers saved before this migration (legacy v1, v2 with a loaner exception and no loan): kept byte-identical,
 *      readable, and their approval / reason never changes (nor is one added) afterwards
 *   P  forged approver / actor: another user of the same business, a user of another business — refused by the database
 *   U  deleting a user (every user column, and one of several) only nulls the column; rows and journal remain
 *   B  deleting a business removes its loans; another business is untouched
 *   I  isolation (RLS + composite tenant FKs): another business's loans, case or inventory item are out of reach
 *   M  immutability: no DELETE, no TRUNCATE, no change outside a kind, no version skip, the erasure marker not borrowable
 *   K  concurrency on two connections: the same item lent twice at once → one; returned twice at once → one; lend vs cancel;
 *      handover vs return (with and without the case lock; REPEATABLE READ) and handover vs a new loan
 *   F  a failure mid-operation leaves nothing   ·   Q  idempotency keys unique per business
 *   Z  erasure: refused unless deleting; clears the texts and users; keeps states and times; re-run 0; others untouched
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
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
const err = (e: unknown) => (e as Error).message.replace(/\s+/g, " ").trim();
/** One transaction in a tenant context; "OK" or "ERR:<message tail>". */
async function inTx(client: PrismaClient, b: number | null, fn: (tx: Tx) => Promise<unknown>): Promise<string> {
  try {
    await client.$transaction(async (tx) => {
      if (b !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
      await fn(tx);
    }, { timeout: 60_000, maxWait: 60_000 });
    return "OK";
  } catch (e) { return `ERR:${err(e).slice(-500)}`; }
}
async function rowsOf(client: PrismaClient, b: number | null, sql: string, ...a: unknown[]): Promise<Rows> {
  return client.$transaction(async (tx) => {
    if (b !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const t = Date.now();
let seqNo = 0;
const ikey = () => `sdloan-${t}-${String(++seqNo).padStart(6, "0")}`;

async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `loan-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `loan-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await rowsOf(owner, b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  const item = Number((await rowsOf(owner, b, `INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt")
    VALUES ($1, 'טלפון חלופי', 'UNIT', 3, now()) RETURNING id`, b))[0].id);
  return { b, u, cust, item };
}
type Biz = Awaited<ReturnType<typeof business>>;
const user = async (z: Biz, tag: string) =>
  Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `loan-${tag}-${t}-${++seqNo}@lab.invalid`, z.b))[0].id);

/** A case opened with its case.opened event (owner), then moved by status updates with their events (as the service does). */
async function kase(z: Biz, path: Array<[string, string, string, string?]> = []): Promise<number> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(z.b));
    const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription")
      VALUES ($1, $2, 'IN_SHOP', $3, 'תקלה סינתטית') RETURNING id`, z.b, 50_000 + ++seqNo, z.cust)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "toStatus", "cancellationRequestedBefore",
      "cancellationRequestedAfter", actor, "actorUserId", "idempotencyKey") VALUES ($1, $2, 1, 'case.opened', 'OPEN', 'OPEN', false, false, 'OWNER_USER', $3, $4)`, z.b, id, z.u, ikey());
    for (const step of path) await moveTx(tx, z.b, id, ...step);
    return id;
  });
}
/** One case transition: the row (status / outcome / cancel request, version + 1) and its event at that seq. */
async function moveTx(tx: Tx, b: number, caseId: number, to: string, action: string, type: string, extra = "") {
  const c = ((await tx.$queryRawUnsafe(`SELECT status::text s, "cancellationRequested" cr FROM "ServiceCase" WHERE id = $1`, caseId)) as Rows)[0];
  const r = ((await tx.$queryRawUnsafe(`UPDATE "ServiceCase" SET status = $2::"ServiceCaseStatus"${extra ? ", " + extra : ""}, version = version + 1, "updatedAt" = now()
    WHERE id = $1 RETURNING version, outcome::text o, "cancellationRequested" cr`, caseId, to)) as Rows)[0];
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore",
      "cancellationRequestedAfter", outcome, actor, payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4::"ServiceEventType", $5::"ServiceCaseAction", $6::"ServiceCaseStatus", $7::"ServiceCaseStatus", $8, $9, $10::"ServiceOutcome", 'SYSTEM', '{}', $11)`,
    b, caseId, Number(r.version), type, action, c.s, to, c.cr, r.cr, r.o ?? null, ikey());
  return Number(r.version);
}
const TO_REPAIR: Array<[string, string, string, string?]> = [["CHECKED_IN", "CHECK_IN", "case.checked_in"], ["DIAGNOSING", "START_DIAGNOSIS", "case.diagnosis_started"], ["IN_REPAIR", "START_REPAIR", "repair.started"]];
const TO_READY: Array<[string, string, string, string?]> = [...TO_REPAIR, ["READY", "FINISH_REPAIR", "repair.finished", `outcome = 'REPAIRED'`]];

type Lend = Partial<{ name: string | null; ident: string | null; item: number | null; cond: string; note: string | null; expected: string | null;
  reason: string | null; approver: number | null; actor: number | null; key: string; evActor: number | null; evApprover: number | null; evReason: string | null;
  evApprovalKind: string | null; evCond: string | null; skipEvent: boolean; extraCols: string }>;
/** A loan as the service writes it: the row, then its LENT event mirroring it. Every field can be falsified. */
async function lendTx(tx: Tx, z: Biz, caseId: number, o: Lend = {}): Promise<number> {
  const actor = o.actor === undefined ? z.u : o.actor;
  const reason = o.reason ?? null;
  const approver = o.approver === undefined ? (reason ? actor : null) : o.approver;
  const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceLoan" ("businessId", "caseId", "itemName", "itemIdentifier", "inventoryItemId", "lentByUserId",
      "conditionAtLend", "lendNote", "expectedReturnOn", "lendExceptionReason", "lendApprovedByUserId", "updatedAt"${o.extraCols ? ", " + o.extraCols.split("=")[0] : ""})
    VALUES ($1, $2, $3, $4, $5, $6, $7::"ServiceLoanCondition", $8, $9::date, $10, $11, now()${o.extraCols ? ", " + o.extraCols.split("=")[1] : ""}) RETURNING id`,
    z.b, caseId, o.name === undefined ? "טלפון חלופי" : o.name, o.ident === undefined ? null : o.ident, o.item ?? null, actor, o.cond ?? "GOOD",
    o.note ?? null, o.expected ?? null, reason, approver)) as Rows)[0].id);
  if (!o.skipEvent) {
    const l = ((await tx.$queryRawUnsafe(`SELECT to_char("expectedReturnOn", 'YYYY-MM-DD') e FROM "ServiceLoan" WHERE id = $1`, id)) as Rows)[0];
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceLoanEvent" ("businessId", "loanId", "caseId", seq, kind, "stateAfter", "expectedReturnOn", condition,
        "approvalKind", "approvedByUserId", reason, actor, "actorUserId", payload, "idempotencyKey")
      VALUES ($1, $2, $3, 1, 'LENT', 'OUT', $4::date, $5::"ServiceLoanCondition", $6::"ServiceLoanApprovalKind", $7, $8, 'OWNER_USER', $9, '{"lent":true}', $10)`,
      z.b, id, caseId, l.e ?? null, o.evCond === undefined ? (o.cond ?? "GOOD") : o.evCond,
      o.evApprovalKind === undefined ? (reason ? "LEND_OUTSIDE_WORK" : null) : o.evApprovalKind,
      o.evApprover === undefined ? approver : o.evApprover, o.evReason === undefined ? reason : o.evReason,
      o.evActor === undefined ? actor : o.evActor, o.key ?? ikey());
  }
  return id;
}
const lend = (z: Biz, caseId: number, o: Lend = {}, client = runtime) => inTx(client, z.b, (tx) => lendTx(tx, z, caseId, o));
/** The last loan id of a case (owner read). */
const loanOf = async (z: Biz, caseId: number) => Number((await rowsOf(owner, z.b, `SELECT max(id) id FROM "ServiceLoan" WHERE "caseId" = $1`, caseId))[0].id);

type Change = Partial<{ set: string; params: unknown[]; evApprovalKind: string | null; evApprover: number | null; evReason: string | null; evCond: string | null;
  evActor: number | null; caseSeq: number | null; skipEvent: boolean; versionDelta: number; key: string }>;
/** A change of a loan: the row (one kind, version + 1) and its event, as the service writes it. */
async function changeTx(tx: Tx, z: Biz, loanId: number, kind: string, o: Change = {}): Promise<void> {
  const before = ((await tx.$queryRawUnsafe(`SELECT version, "caseId" FROM "ServiceLoan" WHERE id = $1 FOR UPDATE`, loanId)) as Rows)[0];
  const params = o.params ?? [];
  const r = ((await tx.$queryRawUnsafe(`UPDATE "ServiceLoan" SET ${o.set ? o.set + ", " : ""}version = version + ${o.versionDelta ?? 1},
      "lastEventKind" = '${kind}'::"ServiceLoanEventKind", "updatedAt" = now() WHERE id = $1 RETURNING version, state::text s,
      to_char("expectedReturnOn", 'YYYY-MM-DD') e, "conditionAtReturn"::text cr, "closeNote" cn, "closeApprovedByUserId" ca`, loanId, ...params)) as Rows)[0];
  if (o.skipEvent) return;
  const cond = o.evCond === undefined ? (kind === "RETURNED" ? r.cr : null) : o.evCond;
  const ak = o.evApprovalKind === undefined ? (kind === "CLOSED" ? "LOAN_CLOSE_UNRETURNED" : null) : o.evApprovalKind;
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceLoanEvent" ("businessId", "loanId", "caseId", seq, kind, "stateAfter", "expectedReturnOn", condition,
      "approvalKind", "approvedByUserId", reason, "caseSeq", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4, $5::"ServiceLoanEventKind", $6::"ServiceLoanState", $7::date, $8::"ServiceLoanCondition", $9::"ServiceLoanApprovalKind", $10, $11, $12,
      'OWNER_USER', $13, '{}', $14)`,
    z.b, loanId, Number(before.caseId), Number(r.version), kind, r.s, r.e ?? null, cond ?? null, ak,
    o.evApprover === undefined ? (kind === "CLOSED" ? r.ca : null) : o.evApprover,
    o.evReason === undefined ? (kind === "CLOSED" ? r.cn : null) : o.evReason, o.caseSeq ?? null,
    o.evActor === undefined ? z.u : o.evActor, o.key ?? ikey());
}
const RETURN = (z: Biz, by = z.u, cond = "GOOD"): Change => ({ set: `state = 'RETURNED', "returnedByUserId" = ${by}, "conditionAtReturn" = '${cond}', "returnNote" = 'הוחזר תקין', "returnedAt" = now()` });
const CLOSE = (by: number, approver: number | null, note: string | null = "הלקוח איבד את המכשיר"): Change =>
  ({ set: `state = 'CLOSED', "closedByUserId" = ${by}, "closeReason" = 'LOST', "closeNote" = ${note === null ? "NULL" : `'${note}'`}, "closeApprovedByUserId" = ${approver === null ? "NULL" : approver}, "closedAt" = now(), "closeApprovedAt" = now()`, evActor: by });
const change = (z: Biz, loanId: number, kind: string, o: Change = {}, client = runtime) => inTx(client, z.b, (tx) => changeTx(tx, z, loanId, kind, o));
/** The case exit approval for every OUT loan of the case, bound to the case event just written (seq = version). */
async function exitApproveTx(tx: Tx, z: Biz, caseId: number, kind: "CANCEL_OPEN_LOANER" | "ABANDON_OPEN_LOANER", o: Partial<{ caseSeq: number; approver: number | null; reason: string | null }> = {}) {
  const v = Number(((await tx.$queryRawUnsafe(`SELECT version FROM "ServiceCase" WHERE id = $1`, caseId)) as Rows)[0].version);
  const loans = (await tx.$queryRawUnsafe(`SELECT id FROM "ServiceLoan" WHERE "caseId" = $1 AND state = 'OUT' ORDER BY id FOR UPDATE`, caseId)) as Rows;
  for (const l of loans) {
    await changeTx(tx, z, Number(l.id), "CASE_EXIT_APPROVED", { evApprovalKind: kind, evApprover: o.approver === undefined ? z.u : o.approver, evReason: o.reason === undefined ? "הלקוח יחזיר בשבוע הבא" : o.reason, caseSeq: o.caseSeq ?? v });
  }
}
const state = async (z: Biz, loanId: number) => (await rowsOf(owner, z.b, `SELECT state::text s, version v, "lastEventKind"::text k FROM "ServiceLoan" WHERE id = $1`, loanId))[0];
const events = async (z: Biz, loanId: number) => rowsOf(owner, z.b, `SELECT seq, kind::text k, "approvalKind"::text a, "approvedByUserId" ab, reason, "caseSeq" cs, "actorUserId" u FROM "ServiceLoanEvent" WHERE "loanId" = $1 ORDER BY seq`, loanId);
const has = (r: string, s: string | RegExp) => (typeof s === "string" ? r.includes(s) : s.test(r));
type Hx = Partial<{ reason: string | null; approver: number | null; at: boolean }>;
/** A version-2 handover row (zero balance) by the business's user, with any of the three loaner fields. */
const hovTx = (tx: Tx, z: Biz, caseId: number, x: Hx = {}) => tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "signatureCaptured", "recordVersion",
    "openBalanceAgorot", "overpaidAgorot", "loanerOverrideReason", "loanerApprovedByUserId", "loanerApprovedAt", "actorUserId")
  VALUES ($1, $2, false, 2, 0, 0, $3, $4, $5::timestamp, $6)`, z.b, caseId, x.reason ?? null, x.approver ?? null, x.at ? new Date() : null, z.u);
/** The full loaner exception as the service writes it: reason, approver = the acting user, the approval time. */
const EXC = (z: Biz): Hx => ({ reason: "יחזיר מחר", approver: z.u, at: true });

async function main() {
  const A = await business("a");
  const B = await business("b");
  const A2 = await user(A, "a2");

  console.log("S — shape");
  {
    const s = (await q(`SELECT
      (SELECT count(*) FROM pg_class WHERE relname IN ('ServiceLoan', 'ServiceLoanEvent') AND relrowsecurity AND relforcerowsecurity)::int f,
      (SELECT count(*) FROM information_schema.role_table_grants WHERE table_name IN ('ServiceLoan', 'ServiceLoanEvent') AND grantee = 'app_runtime' AND privilege_type IN ('DELETE', 'TRUNCATE'))::int d,
      (SELECT count(*) FROM information_schema.role_table_grants WHERE table_name = 'ServiceLoanEvent' AND grantee = 'app_runtime' AND privilege_type = 'UPDATE')::int eu,
      (SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE proname LIKE 'service\\_loan\\_%' AND prosecdef) sd`))[0];
    ok("S1 both tables ENABLE + FORCE row-level security", Number(s.f) === 2, JSON.stringify(s));
    ok("S2 the runtime has no DELETE / TRUNCATE on either table and no UPDATE on the journal", Number(s.d) === 0 && Number(s.eu) === 0, JSON.stringify(s));
    ok("S3 exactly one SECURITY DEFINER function: service_loan_erase_business", s.sd === "service_loan_erase_business", String(s.sd));
  }

  console.log("N — a normal loan in every work status");
  for (const [i, st] of ["CHECKED_IN", "DIAGNOSING", "IN_REPAIR", "QUOTE_PENDING", "EXTERNAL", "QA"].entries()) {
    const path: Array<[string, string, string, string?]> = st === "CHECKED_IN" ? [TO_REPAIR[0]] : st === "DIAGNOSING" ? TO_REPAIR.slice(0, 2)
      : st === "QUOTE_PENDING" ? [...TO_REPAIR.slice(0, 2), ["QUOTE_PENDING", "SEND_QUOTE", "quote.sent"]]
      : st === "EXTERNAL" ? [...TO_REPAIR, ["EXTERNAL", "SEND_TO_EXTERNAL", "external.sent"]]
      : st === "QA" ? [...TO_REPAIR, ["QA", "FINISH_REPAIR", "repair.finished"]] : TO_REPAIR;
    const c = await kase(A, path);
    const r = await lend(A, c, { ident: ` sn-00${i} 77/a `.trim(), expected: "2026-12-20", note: "שריטה בגב" });
    ok(`N${i + 1} lent while ${st} → accepted`, r === "OK", r);
  }
  {
    const c = await kase(A, TO_REPAIR);
    const r = await lend(A, c, { ident: "ab-12.34 x", item: A.item, extraCols: `"lentAt"=TIMESTAMP '2001-01-01'` });
    const l = (await rowsOf(owner, A.b, `SELECT "itemIdentifierNormalized" n, "lentAt" > now() - interval '1 hour' AS fresh, "inventoryItemId" i, state::text s, version v FROM "ServiceLoan" WHERE "caseId" = $1`, c))[0];
    ok("N7 the identifier is normalized by the database (upper, no blanks / . - _ /) whatever the writer sent", r === "OK" && l?.n === "AB1234X", JSON.stringify(l) + r);
    ok("N8 lentAt is the transaction time (a back-dated lentAt is overwritten)", l?.fresh === true, JSON.stringify(l));
    ok("N9 the inventory reference is kept and NO inventory movement / quantity change happens",
      Number(l?.i) === A.item && Number((await rowsOf(owner, A.b, `SELECT "currentQuantity" q FROM "InventoryItem" WHERE id = $1`, A.item))[0].q) === 3
      && Number((await rowsOf(owner, A.b, `SELECT count(*)::int n FROM "InventoryMovement" WHERE "itemId" = $1`, A.item))[0].n) === 0);
    const r2 = await lend(A, c, { name: "מטען", ident: "chg-1", extraCols: `"itemIdentifierNormalized"='FORGED'` });
    const l2 = (await rowsOf(owner, A.b, `SELECT "itemIdentifierNormalized" n FROM "ServiceLoan" WHERE "itemIdentifier" = 'chg-1' AND "caseId" = $1`, c))[0];
    ok("N10 a forged normalized identifier is replaced by the database's own", r2 === "OK" && l2?.n === "CHG1", JSON.stringify(l2) + r2);
    ok("N11 an identifier with no letter or digit → refused", has(await lend(A, c, { ident: " - . / " .trim() || "-./" }), /SERVICE_LOAN_IDENTIFIER_EMPTY|ServiceLoan_identifier/));
    ok("N12 a blank / over-long name, an untrimmed note → refused by CHECK",
      has(await lend(A, c, { name: "  " }), "ServiceLoan_texts") && has(await lend(A, c, { name: "x".repeat(201) }), "ServiceLoan_texts")
      && has(await lend(A, c, { note: " רווח " }), "ServiceLoan_texts"));
    ok("N13 the name is required at birth", has(await lend(A, c, { name: null }), /SERVICE_LOAN_NEW|ServiceLoan_texts/));
    ok("N14 a non-initial row (born RETURNED / version 2 / erased) → refused",
      has(await lend(A, c, { extraCols: `state='RETURNED'` }), /SERVICE_LOAN_NOT_INITIAL|ServiceLoan_state_shape/)
      && has(await lend(A, c, { extraCols: `version=2` }), "SERVICE_LOAN_NOT_INITIAL")
      && has(await lend(A, c, { extraCols: `"erasedAt"=now()` }), "SERVICE_LOAN_NOT_INITIAL"));
    ok("N15 without the acting user → refused", has(await lend(A, c, { actor: null, evActor: A.u }), /SERVICE_LOAN_NEW/));
    ok("N16 a loan without its LENT event → refused at COMMIT (no silent change)", has(await lend(A, c, { skipEvent: true }), "SERVICE_LOAN_SILENT_CHANGE"));
    ok("N17 an event that does not mirror the loan (condition) → refused", has(await lend(A, c, { cond: "GOOD", evCond: "DAMAGED" }), "SERVICE_LOAN_EVENT_MISMATCH"));
  }

  console.log("X — statuses");
  {
    const open = await kase(A);
    ok("X1 OPEN without an exception → refused", has(await lend(A, open), "SERVICE_LOAN_EXCEPTION_UNAPPROVED"));
    ok("X2 OPEN with reason + approver = actor → accepted (LEND_OUTSIDE_WORK)", (await lend(A, open, { reason: "הלקוח צריך טלפון כבר היום" })) === "OK");
    const lo = await loanOf(A, open);
    const ev = (await events(A, lo))[0];
    const row = (await rowsOf(owner, A.b, `SELECT "lendApprovedByUserId" a, "lendApprovedAt" IS NOT NULL t, "lendExceptionReason" r FROM "ServiceLoan" WHERE id = $1`, lo))[0];
    ok("X3 the exception is recorded: reason, approver, approval time on the loan; kind + approver + reason on its event",
      Number(row.a) === A.u && row.t === true && row.r === "הלקוח צריך טלפון כבר היום" && ev.a === "LEND_OUTSIDE_WORK" && Number(ev.ab) === A.u && ev.reason === row.r, JSON.stringify([row, ev]));
    const sch = await kase(A, [["SCHEDULED", "SCHEDULE", "case.scheduled"]]);
    ok("X4 SCHEDULED: refused without, accepted with the exception", has(await lend(A, sch), "SERVICE_LOAN_EXCEPTION_UNAPPROVED") && (await lend(A, sch, { reason: "לפני התור" })) === "OK");
    const rdy = await kase(A, TO_READY);
    ok("X5 READY: refused without, accepted with the exception", has(await lend(A, rdy), "SERVICE_LOAN_EXCEPTION_UNAPPROVED") && (await lend(A, rdy, { reason: "עד שיבוא לאסוף" })) === "OK");
    const rep = await kase(A, TO_REPAIR);
    ok("X6 a work status refuses an exception approval (nothing to approve)", has(await lend(A, rep, { reason: "מיותר" }), "SERVICE_LOAN_NO_EXCEPTION"));
    ok("X7 an exception reason without its LEND_OUTSIDE_WORK event kind → refused (the event mirrors the loan)",
      has(await lend(A, open, { reason: "שוב", evApprovalKind: null, evApprover: null, evReason: null }), /SERVICE_LOAN_EVENT_MISMATCH|ServiceLoanEvent_approval/));
    for (const [n, [st, path]] of ([
      ["WORK_DONE", [...TO_REPAIR, ["WORK_DONE", "FINISH_REPAIR", "repair.finished", `outcome = 'COMPLETED'`]]],
      ["DELIVERED", [...TO_READY, ["DELIVERED", "DELIVER", "case.delivered"]]],
      ["ABANDONED", [...TO_READY, ["ABANDONED", "ABANDON", "case.abandoned", `"abandonReason" = 'לא נאסף', "abandonedAt" = now(), "pickupRemindersSent" = 1`]]],
      ["CLOSED", [...TO_READY, ["DELIVERED", "DELIVER", "case.delivered"], ["CLOSED", "CLOSE", "case.closed", `"closedAt" = now()`]]],
      ["CANCELLED", [["CANCELLED", "CANCEL", "case.cancelled", `outcome = 'CANCELLED', "cancelledAt" = now()`]]],
    ] as Array<[string, Array<[string, string, string, string?]>]>).entries()) {
      let c: number | string;
      try { c = await kase(A, path); } catch (e) { c = err(e); }
      const r = typeof c === "number" ? await lend(A, c, { reason: "ניסיון" }) : c;
      const r2 = typeof c === "number" ? await lend(A, c) : c;
      ok(`X${8 + n} ${st} → refused with or without an exception`, has(r, "SERVICE_LOAN_CASE_STATUS") && has(r2, "SERVICE_LOAN_CASE_STATUS"), `${r} | ${r2}`);
    }
    const ext = await kase(A, [...TO_REPAIR, ["EXTERNAL", "SEND_TO_EXTERNAL", "external.sent"], ["EXTERNAL", "CANCEL", "case.cancellation_requested", `"cancellationRequested" = true, "cancelReason" = 'בוטל', "cancelledAt" = now()`]]);
    ok("X13 a cancel requested at the supplier → refused (SERVICE_LOAN_CASE_CANCELLING)", has(await lend(A, ext), "SERVICE_LOAN_CASE_CANCELLING"));
    const held = await kase(A, [...TO_REPAIR, ["READY", "CANCEL", "case.cancelled", `outcome = 'CANCELLED', "cancelReason" = 'בוטל', "cancelledAt" = now()`]]);
    ok("X14 a cancelled held item (READY + CANCELLED) → refused even with an exception", has(await lend(A, held, { reason: "x" }), "SERVICE_LOAN_CASE_CANCELLING"));
  }

  console.log("D — double loan");
  {
    const c1 = await kase(A, TO_REPAIR), c2 = await kase(A, TO_REPAIR);
    ok("D1 item IMEI 3567-8901 lent on case 1", (await lend(A, c1, { ident: "IMEI 3567-8901" })) === "OK");
    ok("D2 the same item (another spelling: 'imei35678901') on case 2 while out → refused by the UNIQUE index", has(await lend(A, c2, { ident: "imei35678901" }), /ServiceLoan_one_out_per_identifier|unique|23505/i));
    ok("D3 the same item again on the SAME case → refused", has(await lend(A, c1, { ident: "IMEI3567 8901" }), /ServiceLoan_one_out_per_identifier|unique|23505/i));
    const l1 = await loanOf(A, c1);
    ok("D4 after its return it can be lent again", (await change(A, l1, "RETURNED", RETURN(A))) === "OK" && (await lend(A, c2, { ident: "imei35678901" })) === "OK");
    ok("D5 items with no identifier are never 'the same item' (two unidentified loans on one case)", (await lend(A, c1, { name: "כבל" })) === "OK" && (await lend(A, c1, { name: "כבל" })) === "OK");
    ok("D6 the same identifier in ANOTHER business is another item → accepted", (await lend(B, await kase(B, TO_REPAIR), { ident: "IMEI 3567-8901" })) === "OK");
  }

  console.log("R — return");
  {
    const c = await kase(A, TO_REPAIR);
    await lend(A, c, { ident: "RET-1" });
    const l = await loanOf(A, c);
    ok("R1 a return without its event → refused at COMMIT", has(await change(A, l, "RETURNED", { ...RETURN(A), skipEvent: true }), "SERVICE_LOAN_SILENT_CHANGE"));
    ok("R2 a return without a condition → refused", has(await change(A, l, "RETURNED", { set: `state = 'RETURNED', "returnedByUserId" = ${A.u}, "returnedAt" = now()`, evCond: "GOOD" }), /ServiceLoan_state_shape/));
    ok("R3 a return without the receiving user → refused", has(await change(A, l, "RETURNED", { set: `state = 'RETURNED', "conditionAtReturn" = 'GOOD', "returnedAt" = now()` }), /SERVICE_LOAN_RETURN/));
    ok("R4 a return that also changes the item name → refused (one kind, its own columns)", has(await change(A, l, "RETURNED", { set: RETURN(A).set + `, "itemName" = 'אחר'` }), "SERVICE_LOAN_CHANGE_NOT_KIND"));
    ok("R5 a version skip → refused", has(await change(A, l, "RETURNED", { ...RETURN(A), versionDelta: 2 }), "SERVICE_LOAN_VERSION"));
    ok("R6 a return event with another condition than the row → refused", has(await change(A, l, "RETURNED", { ...RETURN(A, A.u, "WORN"), evCond: "GOOD" }), "SERVICE_LOAN_EVENT_MISMATCH"));
    ok("R7 the return (condition DAMAGED, a note) → accepted", (await change(A, l, "RETURNED", { set: `state = 'RETURNED', "returnedByUserId" = ${A.u}, "conditionAtReturn" = 'DAMAGED', "returnNote" = 'סדק במסך', "returnedAt" = TIMESTAMP '2001-01-01'` })) === "OK");
    const row = (await rowsOf(owner, A.b, `SELECT state::text s, version v, "returnedAt" > now() - interval '1 hour' fresh, "conditionAtLend"::text cl, "conditionAtReturn"::text cr FROM "ServiceLoan" WHERE id = $1`, l))[0];
    ok("R8 RETURNED, version 2, returnedAt stamped by the database, both conditions kept", row.s === "RETURNED" && Number(row.v) === 2 && row.fresh === true && row.cl === "GOOD" && row.cr === "DAMAGED", JSON.stringify(row));
    const r9 = await change(A, l, "RETURNED", { ...RETURN(A, A2), evActor: A2 });
    ok("R9 a second return → refused SERVICE_LOAN_FINAL (the first return stays as it was)", has(r9, "SERVICE_LOAN_FINAL") && Number((await state(A, l)).v) === 2, r9);
    ok("R10 a close after the return → refused (final)", has(await change(A, l, "CLOSED", CLOSE(A.u, A.u)), "SERVICE_LOAN_FINAL"));
    ok("R11 the journal: LENT (1), RETURNED (2)", JSON.stringify((await events(A, l)).map((e) => e.k)) === JSON.stringify(["LENT", "RETURNED"]));
    // returns in any case status
    for (const [i, [label, path]] of ([
      ["after the repaired item was delivered (with the approved exception)", null],
      ["on a CANCELLED case (approved)", "CANCEL"],
    ] as Array<[string, string | null]>).entries()) {
      const k = await kase(A, path === null ? TO_READY : TO_REPAIR);
      await lend(A, k, path === null ? { reason: "עד האיסוף" } : {});
      const lo = await loanOf(A, k);
      const exit = path === null
        ? await inTx(runtime, A.b, async (tx) => {
            await moveTx(tx, A.b, k, "DELIVERED", "DELIVER", "case.delivered", `"deliveredAt" = now()`);
            await tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "signatureCaptured", "recordVersion", "openBalanceAgorot", "overpaidAgorot",
              "loanerOverrideReason", "loanerApprovedByUserId", "loanerApprovedAt", "actorUserId") VALUES ($1, $2, false, 2, 0, 0, 'יחזיר מחר', $3, now(), $3)`, A.b, k, A.u);
          })
        : await inTx(runtime, A.b, async (tx) => { await moveTx(tx, A.b, k, "CANCELLED", "CANCEL", "case.cancelled", `outcome = 'CANCELLED', "cancelledAt" = now()`); await exitApproveTx(tx, A, k, "CANCEL_OPEN_LOANER"); });
      const r = await change(A, lo, "RETURNED", RETURN(A));
      ok(`R${12 + i} a return ${label} → accepted`, exit === "OK" && r === "OK" && (await state(A, lo)).s === "RETURNED", `${exit} | ${r}`);
    }
    const k = await kase(A, TO_REPAIR);
    await lend(A, k, { expected: "2026-12-01" });
    const lo = await loanOf(A, k);
    ok("R14 the expected return date changes while OUT (EXPECTED_RETURN_CHANGED), the event carries the new date",
      (await change(A, lo, "EXPECTED_RETURN_CHANGED", { set: `"expectedReturnOn" = DATE '2026-12-15'` })) === "OK"
      && (await rowsOf(owner, A.b, `SELECT to_char("expectedReturnOn", 'YYYY-MM-DD') e FROM "ServiceLoanEvent" WHERE "loanId" = $1 AND seq = 2`, lo))[0].e === "2026-12-15");
    ok("R15 the same date again → refused (SERVICE_LOAN_NO_CHANGE)", has(await change(A, lo, "EXPECTED_RETURN_CHANGED", { set: `"expectedReturnOn" = DATE '2026-12-15'` }), "SERVICE_LOAN_NO_CHANGE"));
    ok("R16 a LENT kind on an existing loan → refused", has(await change(A, lo, "LENT", {}), "SERVICE_LOAN_KIND"));
  }

  console.log("C — close without a return");
  {
    const c = await kase(A, TO_REPAIR);
    await lend(A, c, { ident: "CLS-1" });
    const l = await loanOf(A, c);
    ok("C1 without an approver → refused", has(await change(A, l, "CLOSED", CLOSE(A.u, null)), /SERVICE_LOAN_CLOSE_UNAPPROVED|ServiceLoan_state_shape/));
    ok("C2 without a reason → refused", has(await change(A, l, "CLOSED", CLOSE(A.u, A.u, null)), /SERVICE_LOAN_CLOSE_UNAPPROVED|ServiceLoan_state_shape/));
    ok("C3 an approver other than the actor (same business) → refused SERVICE_APPROVER_NOT_ACTOR (by the loan row itself)", has(await change(A, l, "CLOSED", { ...CLOSE(A.u, A2), evApprover: A.u }), "SERVICE_APPROVER_NOT_ACTOR"));
    ok("C4 the close event without its approval kind / approver / reason → refused (the event mirrors the loan; CHECK ServiceLoanEvent_approval)",
      has(await change(A, l, "CLOSED", { ...CLOSE(A.u, A.u), evApprovalKind: null, evApprover: null, evReason: null }), /ServiceLoanEvent_approval|SERVICE_LOAN_EVENT_MISMATCH/)
      && has(await change(A, l, "CLOSED", { ...CLOSE(A.u, A.u), evApprovalKind: null }), /ServiceLoanEvent_approval/));
    ok("C5 LOST, approver = actor, with a reason → CLOSED; the identifier is free again", (await change(A, l, "CLOSED", CLOSE(A.u, A.u))) === "OK"
      && (await state(A, l)).s === "CLOSED" && (await lend(A, await kase(A, TO_REPAIR), { ident: "cls 1" })) === "OK");
    const ev = (await events(A, l))[1];
    ok("C6 the close event: LOAN_CLOSE_UNRETURNED, approver, reason", ev.a === "LOAN_CLOSE_UNRETURNED" && Number(ev.ab) === A.u && ev.reason === "הלקוח איבד את המכשיר", JSON.stringify(ev));
  }

  console.log("E — the case exits while a loan is OUT");
  {
    const c = await kase(A, TO_REPAIR);
    await lend(A, c, { ident: "EXIT-1" });
    const l = await loanOf(A, c);
    const cancel = (tx: Tx) => moveTx(tx, A.b, c, "CANCELLED", "CANCEL", "case.cancelled", `outcome = 'CANCELLED', "cancelReason" = 'הלקוח ביטל', "cancelledAt" = now()`);
    ok("E1 CANCEL → CANCELLED with the loan out and no approval → refused at COMMIT", has(await inTx(runtime, A.b, cancel), "SERVICE_LOAN_CANCEL_UNAPPROVED"));
    ok("E2 an approval not bound to the cancel (ABANDON kind) → refused", has(await inTx(runtime, A.b, async (tx) => { await cancel(tx); await exitApproveTx(tx, A, c, "ABANDON_OPEN_LOANER"); }), "SERVICE_LOAN_EXIT_NOT_BOUND"));
    ok("E3 an approval bound to an older case seq → refused", has(await inTx(runtime, A.b, async (tx) => { await cancel(tx); await exitApproveTx(tx, A, c, "CANCEL_OPEN_LOANER", { caseSeq: 2 }); }), "SERVICE_LOAN_EXIT_NOT_BOUND"));
    ok("E4 an approval written BEFORE the cancel event (nothing to bind to) → refused", has(await inTx(runtime, A.b, async (tx) => { await exitApproveTx(tx, A, c, "CANCEL_OPEN_LOANER"); await cancel(tx); }), "SERVICE_LOAN_EXIT_NOT_BOUND"));
    ok("E5 an approval without a reason → refused", has(await inTx(runtime, A.b, async (tx) => { await cancel(tx); await exitApproveTx(tx, A, c, "CANCEL_OPEN_LOANER", { reason: null }); }), /SERVICE_LOAN_EVENT_UNAPPROVED|ServiceLoanEvent_approval/));
    ok("E5b an approval with a reason but no approver → refused SERVICE_LOAN_EVENT_UNAPPROVED", has(await inTx(runtime, A.b, async (tx) => { await cancel(tx); await exitApproveTx(tx, A, c, "CANCEL_OPEN_LOANER", { approver: null }); }), "SERVICE_LOAN_EVENT_UNAPPROVED"));
    ok("E6 an approver other than the actor → refused", has(await inTx(runtime, A.b, async (tx) => { await cancel(tx); await exitApproveTx(tx, A, c, "CANCEL_OPEN_LOANER", { approver: A2 }); }), "SERVICE_APPROVER_NOT_ACTOR"));
    ok("E7 CANCEL with the approval bound to its event → CANCELLED", (await inTx(runtime, A.b, async (tx) => { await cancel(tx); await exitApproveTx(tx, A, c, "CANCEL_OPEN_LOANER"); })) === "OK");
    const s = await state(A, l), ev = (await events(A, l))[1];
    const cv = Number((await rowsOf(owner, A.b, `SELECT version FROM "ServiceCase" WHERE id = $1`, c))[0].version);
    ok("E8 the loan stays OUT (never released or deleted); its journal holds CASE_EXIT_APPROVED / CANCEL_OPEN_LOANER bound to the cancel's seq, approver, reason",
      s.s === "OUT" && ev.k === "CASE_EXIT_APPROVED" && ev.a === "CANCEL_OPEN_LOANER" && Number(ev.cs) === cv && Number(ev.ab) === A.u && ev.reason === "הלקוח יחזיר בשבוע הבא", JSON.stringify([s, ev]));
    // a cancel request at the supplier
    const x = await kase(A, [...TO_REPAIR, ["EXTERNAL", "SEND_TO_EXTERNAL", "external.sent"]]);
    await lend(A, x, { ident: "EXIT-2" });
    const req = (tx: Tx) => moveTx(tx, A.b, x, "EXTERNAL", "CANCEL", "case.cancellation_requested", `"cancellationRequested" = true, "cancelReason" = 'בוטל', "cancelledAt" = now()`);
    ok("E9 a cancel REQUEST at the supplier with the loan out → refused without, accepted with the approval",
      has(await inTx(runtime, A.b, req), "SERVICE_LOAN_CANCEL_UNAPPROVED") && (await inTx(runtime, A.b, async (tx) => { await req(tx); await exitApproveTx(tx, A, x, "CANCEL_OPEN_LOANER"); })) === "OK");
    const lx = await loanOf(A, x);
    const oldSeq = Number((await rowsOf(owner, A.b, `SELECT version FROM "ServiceCase" WHERE id = $1`, x))[0].version);
    ok("E9b the supplier returns the item (the cancel completes → READY + CANCELLED) with the approval in place → accepted",
      (await inTx(runtime, A.b, (tx) => moveTx(tx, A.b, x, "READY", "RETURN_FROM_EXTERNAL", "external.returned", `outcome = 'CANCELLED', "cancellationRequested" = false`))) === "OK");
    ok("E9c a new exit approval bound to that OLDER cancel event (not the case's current version) → refused SERVICE_LOAN_EXIT_NOT_BOUND",
      has(await change(A, lx, "CASE_EXIT_APPROVED", { evApprovalKind: "CANCEL_OPEN_LOANER", evApprover: A.u, evReason: "שוב", caseSeq: oldSeq }), "SERVICE_LOAN_EXIT_NOT_BOUND"));
    // a held item cancelled → READY (+ CANCELLED)
    const h = await kase(A, TO_REPAIR);
    await lend(A, h, { ident: "EXIT-3" });
    const hc = (tx: Tx) => moveTx(tx, A.b, h, "READY", "CANCEL", "case.cancelled", `outcome = 'CANCELLED', "cancelReason" = 'בוטל', "cancelledAt" = now()`);
    ok("E10 a held item's cancel (→ READY + CANCELLED) with the loan out → refused without, accepted with the approval",
      has(await inTx(runtime, A.b, hc), "SERVICE_LOAN_CANCEL_UNAPPROVED") && (await inTx(runtime, A.b, async (tx) => { await hc(tx); await exitApproveTx(tx, A, h, "CANCEL_OPEN_LOANER"); })) === "OK");
    // ABANDON
    const ab = await kase(A, TO_READY);
    await lend(A, ab, { reason: "עד האיסוף", ident: "EXIT-4" });
    const abandon = (tx: Tx) => moveTx(tx, A.b, ab, "ABANDONED", "ABANDON", "case.abandoned", `"abandonReason" = 'לא נאסף', "abandonedAt" = now(), "pickupRemindersSent" = 1`);
    ok("E11 ABANDON with the loan out → refused without; a CANCEL approval does not cover it", has(await inTx(runtime, A.b, abandon), "SERVICE_LOAN_ABANDON_UNAPPROVED")
      && has(await inTx(runtime, A.b, async (tx) => { await abandon(tx); await exitApproveTx(tx, A, ab, "CANCEL_OPEN_LOANER"); }), "SERVICE_LOAN_EXIT_NOT_BOUND"));
    ok("E12 ABANDON with the ABANDON_OPEN_LOANER approval → accepted, the loan still OUT",
      (await inTx(runtime, A.b, async (tx) => { await abandon(tx); await exitApproveTx(tx, A, ab, "ABANDON_OPEN_LOANER"); })) === "OK" && (await state(A, await loanOf(A, ab))).s === "OUT");
    // CLOSE
    const cl = await kase(A, TO_READY);
    await lend(A, cl, { reason: "עד האיסוף", ident: "EXIT-5" });
    const lcl = await loanOf(A, cl);
    const deliver = async (tx: Tx) => {
      await moveTx(tx, A.b, cl, "DELIVERED", "DELIVER", "case.delivered", `"deliveredAt" = now()`);
      await tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "signatureCaptured", "recordVersion", "openBalanceAgorot", "overpaidAgorot",
        "loanerOverrideReason", "loanerApprovedByUserId", "loanerApprovedAt", "actorUserId") VALUES ($1, $2, false, 2, 0, 0, 'יחזיר מחר', $3, now(), $3)`, A.b, cl, A.u);
    };
    ok("E13 DELIVER with the loaner exception → accepted", (await inTx(runtime, A.b, deliver)) === "OK");
    const close = (tx: Tx) => moveTx(tx, A.b, cl, "CLOSED", "CLOSE", "case.closed", `"closedAt" = now()`);
    ok("E14 CLOSE while the loan is still out → refused at COMMIT (SERVICE_LOAN_OUT_ON_CLOSE)", has(await inTx(runtime, A.b, close), "SERVICE_LOAN_OUT_ON_CLOSE"));
    ok("E15 return the loan and CLOSE in one transaction → accepted", (await inTx(runtime, A.b, async (tx) => { await changeTx(tx, A, lcl, "RETURNED", RETURN(A)); await close(tx); })) === "OK");
    const cl2 = await kase(A, TO_READY);
    await lend(A, cl2, { reason: "עד האיסוף" });
    const l2 = await loanOf(A, cl2);
    ok("E16 a loan closed as LOST (approved) lets the case close", (await change(A, l2, "CLOSED", CLOSE(A.u, A.u))) === "OK"
      && (await inTx(runtime, A.b, async (tx) => {
        await moveTx(tx, A.b, cl2, "DELIVERED", "DELIVER", "case.delivered", `"deliveredAt" = now()`);
        await tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "signatureCaptured", "recordVersion", "openBalanceAgorot", "overpaidAgorot", "actorUserId") VALUES ($1, $2, false, 2, 0, 0, $3)`, A.b, cl2, A.u);
        await moveTx(tx, A.b, cl2, "CLOSED", "CLOSE", "case.closed", `"closedAt" = now()`);
      })) === "OK");
    const plain = await kase(A, TO_REPAIR);
    ok("E17 a case with no loan cancels exactly as before", (await inTx(runtime, A.b, (tx) => moveTx(tx, A.b, plain, "READY", "CANCEL", "case.cancelled", `outcome = 'CANCELLED', "cancelReason" = 'בוטל', "cancelledAt" = now()`))) === "OK");
  }

  console.log("H — handover");
  {
    const c = await kase(A, TO_READY);
    await lend(A, c, { reason: "עד האיסוף", ident: "HOV-1" });
    const dv = (tx: Tx) => moveTx(tx, A.b, c, "DELIVERED", "DELIVER", "case.delivered", `"deliveredAt" = now()`);
    ok("H1 a handover with the loan out and no loaner exception → refused SERVICE_HANDOVER_LOANER_OUT", has(await inTx(runtime, A.b, async (tx) => {
      await dv(tx);
      await tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "signatureCaptured", "recordVersion", "openBalanceAgorot", "overpaidAgorot", "actorUserId") VALUES ($1, $2, false, 2, 0, 0, $3)`, A.b, c, A.u);
    }), "SERVICE_HANDOVER_LOANER_OUT"));
    ok("H2 DELIVERED with no handover row at all and the loan out → refused at COMMIT", has(await inTx(runtime, A.b, dv), /SERVICE_LOAN_DELIVER_UNAPPROVED|SERVICE_HANDOVER/));
    ok("H3 the exception with an approver other than the actor → refused (#1128 rule)", has(await inTx(runtime, A.b, async (tx) => {
      await dv(tx);
      await tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "signatureCaptured", "recordVersion", "openBalanceAgorot", "overpaidAgorot", "loanerOverrideReason", "loanerApprovedByUserId", "loanerApprovedAt", "actorUserId") VALUES ($1, $2, false, 2, 0, 0, 'יחזיר', $3, now(), $4)`, A.b, c, A2, A.u);
    }), "SERVICE_APPROVER_NOT_ACTOR"));
    const n = await kase(A, TO_READY);
    ok("H4 a handover of a case without a loan is unchanged", (await inTx(runtime, A.b, async (tx) => {
      await moveTx(tx, A.b, n, "DELIVERED", "DELIVER", "case.delivered", `"deliveredAt" = now()`);
      await tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "signatureCaptured", "recordVersion", "openBalanceAgorot", "overpaidAgorot", "actorUserId") VALUES ($1, $2, false, 2, 0, 0, $3)`, A.b, n, A.u);
    })) === "OK");
    const r = await kase(A, TO_READY);
    await lend(A, r, { reason: "עד האיסוף" });
    await change(A, await loanOf(A, r), "RETURNED", RETURN(A));
    ok("H5 after the return the handover needs no exception", (await inTx(runtime, A.b, async (tx) => {
      await moveTx(tx, A.b, r, "DELIVERED", "DELIVER", "case.delivered", `"deliveredAt" = now()`);
      await tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "signatureCaptured", "recordVersion", "openBalanceAgorot", "overpaidAgorot", "actorUserId") VALUES ($1, $2, false, 2, 0, 0, $3)`, A.b, r, A.u);
    })) === "OK");

    // the other direction (owner 2026-11-12): NO loan out ⇒ no loaner approval / reason is saved
    const hovs = async (caseId: number) => Number((await rowsOf(owner, A.b, `SELECT count(*)::int n FROM "ServiceHandover" WHERE "caseId" = $1`, caseId))[0].n);
    const deliverWith = (caseId: number, x: Hx) => async (tx: Tx) => {
      await moveTx(tx, A.b, caseId, "DELIVERED", "DELIVER", "case.delivered", `"deliveredAt" = now()`);
      await hovTx(tx, A, caseId, x);
    };
    const never = await kase(A, TO_READY);
    ok("H6 a case that never had a loan: the full loaner exception (reason + approver = actor + time) → refused SERVICE_HANDOVER_LOANER_NONE, nothing written",
      has(await inTx(runtime, A.b, deliverWith(never, EXC(A))), "SERVICE_HANDOVER_LOANER_NONE") && (await hovs(never)) === 0);
    const rr = await kase(A, TO_READY);
    await lend(A, rr, { reason: "עד האיסוף", ident: "HOV-RET" });
    ok("H7 a loan returned, then the handover with the exception → refused SERVICE_HANDOVER_LOANER_NONE (the approval has nothing to approve)",
      (await change(A, await loanOf(A, rr), "RETURNED", RETURN(A))) === "OK"
      && has(await inTx(runtime, A.b, deliverWith(rr, EXC(A))), "SERVICE_HANDOVER_LOANER_NONE") && (await hovs(rr)) === 0);
    ok("H7b … and the same handover without the exception → accepted", (await inTx(runtime, A.b, deliverWith(rr, {}))) === "OK" && (await hovs(rr)) === 1);
    const cl = await kase(A, TO_READY);
    await lend(A, cl, { reason: "עד האיסוף", ident: "HOV-CLS" });
    ok("H8 a loan closed without a return (approved), then the handover with the exception → refused SERVICE_HANDOVER_LOANER_NONE",
      (await change(A, await loanOf(A, cl), "CLOSED", CLOSE(A.u, A.u))) === "OK"
      && has(await inTx(runtime, A.b, deliverWith(cl, EXC(A))), "SERVICE_HANDOVER_LOANER_NONE"));
    const part = await kase(A, TO_READY);
    const parts = await Promise.all([{ approver: A.u, at: true }, { at: true }, { approver: A.u }, { reason: "יחזיר" }, { reason: "יחזיר", approver: A.u }]
      .map((x) => inTx(runtime, A.b, deliverWith(part, x))));
    ok("H9 no loan: ANY loaner field alone or partial (approver + time, time, approver, reason, reason + approver) → refused SERVICE_HANDOVER_LOANER_NONE",
      parts.every((x) => has(x, "SERVICE_HANDOVER_LOANER_NONE")) && (await hovs(part)) === 0, JSON.stringify(parts));
    const out = await kase(A, TO_READY);
    await lend(A, out, { reason: "עד האיסוף", ident: "HOV-OUT" });
    const partsOut = await Promise.all([{ approver: A.u, at: true }, { approver: A.u }, { at: true }].map((x) => inTx(runtime, A.b, deliverWith(out, x))));
    ok("H10 a loan OUT with a partial exception without its reason (approver + time, approver, time) → refused (CHECK ServiceHandover_loaner_decided)",
      partsOut.every((x) => has(x, "ServiceHandover_loaner_decided")) && (await hovs(out)) === 0, JSON.stringify(partsOut));
    ok("H11 a loan OUT with the full exception → accepted; the record holds the reason, approver = actor, the approval time",
      (await inTx(runtime, A.b, deliverWith(out, EXC(A)))) === "OK");
    const rec = (await rowsOf(owner, A.b, `SELECT "loanerOverrideReason" r, "loanerApprovedByUserId" a, "loanerApprovedAt" IS NOT NULL t, "actorUserId" u FROM "ServiceHandover" WHERE "caseId" = $1`, out))[0];
    ok("H11b … reason, approver = actor (server-resolved), time", rec?.r === "יחזיר מחר" && Number(rec?.a) === A.u && Number(rec?.u) === A.u && rec?.t === true, JSON.stringify(rec));
    const two = await kase(A, TO_READY);
    await lend(A, two, { reason: "עד האיסוף", ident: "HOV-2A" });
    await lend(A, two, { reason: "עד האיסוף", ident: "HOV-2B" });
    ok("H12 two loans, one returned and one still OUT → the exception is still required and accepted",
      (await change(A, await loanOf(A, two), "RETURNED", RETURN(A))) === "OK"
      && has(await inTx(runtime, A.b, deliverWith(two, {})), "SERVICE_HANDOVER_LOANER_OUT") && (await inTx(runtime, A.b, deliverWith(two, EXC(A)))) === "OK");
    // a case cancelled with the loan out: the cancel's approval (on the loan) is not the handover's
    const cc = await kase(A, TO_REPAIR);
    await lend(A, cc, { ident: "HOV-CNL" });
    ok("H13 CANCEL with the loan out and its approval → CANCELLED, the loan stays OUT", (await inTx(runtime, A.b, async (tx) => {
      await moveTx(tx, A.b, cc, "CANCELLED", "CANCEL", "case.cancelled", `outcome = 'CANCELLED', "cancelReason" = 'בוטל', "cancelledAt" = now()`);
      await exitApproveTx(tx, A, cc, "CANCEL_OPEN_LOANER");
    })) === "OK" && (await state(A, await loanOf(A, cc))).s === "OUT");
    ok("H13b … a handover row for it without the loaner exception → refused SERVICE_HANDOVER_LOANER_OUT (the cancel approval does not stand in)",
      has(await inTx(runtime, A.b, (tx) => hovTx(tx, A, cc, {})), "SERVICE_HANDOVER_LOANER_OUT"));
    ok("H13c … after the loan's return, a handover row with the loaner exception → refused SERVICE_HANDOVER_LOANER_NONE",
      (await change(A, await loanOf(A, cc), "RETURNED", RETURN(A))) === "OK" && has(await inTx(runtime, A.b, (tx) => hovTx(tx, A, cc, EXC(A))), "SERVICE_HANDOVER_LOANER_NONE"));
    ok("H14 even the table owner cannot save a loaner exception with no loan out", has(await inTx(owner, A.b, deliverWith(await kase(A, TO_READY), EXC(A))), "SERVICE_HANDOVER_LOANER_NONE"));
  }

  console.log("L — handovers saved before this migration (legacy version 1, version 2 with a loaner exception and no loan)");
  {
    const pre = await q(`SELECT h.id, h."businessId" b, h."recordVersion" v, h."loanerOverrideReason" r, h."loanerApprovedByUserId" a, h."loanerApprovedAt" IS NOT NULL t,
        md5(to_jsonb(h)::text) d FROM "ServiceHandover" h JOIN "Business" x ON x.id = h."businessId" WHERE x.name IN ('loan-pre-v2', 'hov-legacy') ORDER BY h.id`);
    const v2x = pre.filter((h) => Number(h.v) === 2 && h.r !== null);
    const v1x = pre.filter((h) => Number(h.v) === 1 && h.r !== null);
    ok("L1 the rows exist: version-2 with a loaner exception and no loan, legacy version-1 with a loaner reason (.sdloan/seed-v2-loaner.sql, .sdhov/seed-legacy.sql)",
      v2x.length >= 1 && v1x.length >= 1 && v2x.every((h) => h.a !== null && h.t === true), JSON.stringify(pre));
    const vb = Number(v2x[0]?.b ?? 0), vid = Number(v2x[0]?.id ?? 0);
    ok("L2 … readable through the runtime, unchanged by the migration (no loan for its case)", Number((await rowsOf(runtime, vb, `SELECT count(*)::int n FROM "ServiceHandover" h
        WHERE h.id = $1 AND NOT EXISTS (SELECT 1 FROM "ServiceLoan" l WHERE l."caseId" = h."caseId")`, vid))[0].n) === 1);
    const updPre = (set: string) => inTx(owner, vb, (tx) => tx.$executeRawUnsafe(`UPDATE "ServiceHandover" SET ${set} WHERE id = $1`, vid));
    ok("L3 its saved approval / reason never changes retroactively (owner): reason, approver, time, cleared reason → SERVICE_HANDOVER_FIXED",
      (await Promise.all([updPre(`"loanerOverrideReason" = 'אחר'`), updPre(`"loanerApprovedAt" = now() - interval '1 day'`),
        updPre(`"loanerOverrideReason" = NULL, "loanerApprovedByUserId" = NULL, "loanerApprovedAt" = NULL`)])).every((x) => has(x, "SERVICE_HANDOVER_FIXED")));
    ok("L3b … and the runtime cannot UPDATE a handover at all", /permission denied/i.test(await inTx(runtime, vb, (tx) => tx.$executeRawUnsafe(`UPDATE "ServiceHandover" SET "loanerOverrideReason" = 'x' WHERE id = $1`, vid))));
    const plain = Number((await rowsOf(owner, A.b, `SELECT max(id) id FROM "ServiceHandover" WHERE "businessId" = $1 AND "loanerApprovedAt" IS NULL AND "recordVersion" = 2`, A.b))[0].id);
    ok("L4 a loaner exception cannot be ADDED to a saved handover afterwards (owner) → SERVICE_HANDOVER_FIXED",
      has(await inTx(owner, A.b, (tx) => tx.$executeRawUnsafe(`UPDATE "ServiceHandover" SET "loanerOverrideReason" = 'בדיעבד', "loanerApprovedByUserId" = $2, "loanerApprovedAt" = now() WHERE id = $1`, plain, A.u)), "SERVICE_HANDOVER_FIXED"));
    const after = await q(`SELECT md5(to_jsonb(h)::text) d FROM "ServiceHandover" h JOIN "Business" x ON x.id = h."businessId" WHERE x.name IN ('loan-pre-v2', 'hov-legacy') ORDER BY h.id`);
    ok("L5 every pre-migration row is byte-identical after all of the above", after.length === pre.length && after.every((h, i) => h.d === pre[i].d));
  }

  console.log("P — forged approver / actor");
  {
    const open = await kase(A);
    ok("P1 a lending exception approved by ANOTHER user of the same business → refused SERVICE_APPROVER_NOT_ACTOR (by the loan row itself)",
      has(await lend(A, open, { reason: "x", approver: A2, evApprover: A.u }), "SERVICE_APPROVER_NOT_ACTOR"));
    ok("P2 … approved by a user of ANOTHER business → refused", has(await lend(A, open, { reason: "x", approver: B.u }), /SERVICE_USER_OTHER_BUSINESS|SERVICE_APPROVER_NOT_ACTOR/));
    ok("P3 lent by a user of another business → refused SERVICE_USER_OTHER_BUSINESS (by the loan row itself)", has(await lend(A, await kase(A, TO_REPAIR), { actor: B.u, evActor: A.u }), "SERVICE_USER_OTHER_BUSINESS"));
    ok("P4 a non-existent user → refused", has(await lend(A, await kase(A, TO_REPAIR), { actor: 2_000_000_000 }), /SERVICE_USER_OTHER_BUSINESS|foreign key/i));
    ok("P5 the LENT event attributed to another user than the lender → refused", has(await lend(A, await kase(A, TO_REPAIR), { evActor: A2 }), "SERVICE_LOAN_EVENT_MISMATCH"));
    const c = await kase(A, TO_REPAIR);
    await lend(A, c);
    const l = await loanOf(A, c);
    ok("P6 a return received by a user of another business → refused SERVICE_USER_OTHER_BUSINESS (by the loan row itself, and by its event)",
      has(await change(A, l, "RETURNED", { ...RETURN(A, B.u), evActor: A.u }), "SERVICE_USER_OTHER_BUSINESS") && has(await change(A, l, "RETURNED", { ...RETURN(A, B.u), evActor: B.u }), "SERVICE_USER_OTHER_BUSINESS"));
    ok("P7 a return event by another user than the receiver → refused", has(await change(A, l, "RETURNED", { ...RETURN(A, A.u), evActor: A2 }), "SERVICE_LOAN_EVENT_MISMATCH"));
    ok("P8 a close approved by a user of another business → refused", has(await change(A, l, "CLOSED", CLOSE(A.u, B.u)), /SERVICE_USER_OTHER_BUSINESS|SERVICE_APPROVER_NOT_ACTOR/));
  }

  console.log("U — deleting a user");
  {
    const Z = await business("u");
    const Z2 = await user(Z, "z2"), Z3 = await user(Z, "z3");
    const open = await kase(Z);
    await lend(Z, open, { actor: Z2, reason: "חריג" });
    const l = await loanOf(Z, open);
    ok("U0 Z2 lent (with the exception); Z3 receives the return", (await change(Z, l, "RETURNED", { ...RETURN(Z, Z3), evActor: Z3 })) === "OK");
    const rd = await inTx(owner, null, (tx) => tx.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, Z2));
    const row = (await rowsOf(owner, Z.b, `SELECT "lentByUserId" a, "lendApprovedByUserId" b, "returnedByUserId" r, "lendApprovedAt" IS NOT NULL t, state::text s FROM "ServiceLoan" WHERE id = $1`, l))[0];
    ok("U1 deleting the lender-approver (another user column still names Z3) → only its columns become NULL; approval time, state stay",
      rd === "OK" && row.a === null && row.b === null && Number(row.r) === Z3 && row.t === true && row.s === "RETURNED", `${rd} ${JSON.stringify(row)}`);
    const rd3 = await inTx(owner, null, (tx) => tx.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, Z3));
    const evs = await events(Z, l);
    ok("U2 deleting the receiver too → nulled; the journal keeps both events with their actors NULL",
      rd3 === "OK" && evs.length === 2 && evs.every((e) => e.u === null) && evs[0].ab === null, `${rd3} ${JSON.stringify(evs)}`);
    const c = await kase(Z, TO_REPAIR);
    const Z4 = await user(Z, "z4");
    await lend(Z, c, { actor: Z4 });
    const l2 = await loanOf(Z, c);
    await change(Z, l2, "CLOSED", { ...CLOSE(Z4, Z4) });
    const rd4 = await inTx(owner, null, (tx) => tx.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, Z4));
    const r2 = (await rowsOf(owner, Z.b, `SELECT "closedByUserId" a, "closeApprovedByUserId" b, "closeApprovedAt" IS NOT NULL t FROM "ServiceLoan" WHERE id = $1`, l2))[0];
    ok("U3 deleting the closer-approver → nulled; the approval time stays", rd4 === "OK" && r2.a === null && r2.b === null && r2.t === true, `${rd4} ${JSON.stringify(r2)}`);
  }

  console.log("I — isolation");
  {
    const c = await kase(A, TO_REPAIR);
    await lend(A, c, { ident: "ISO-1" });
    const l = await loanOf(A, c);
    ok("I1 business B's context sees none of A's loans or events", (await rowsOf(runtime, B.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "businessId" = $1`, A.b))[0].n === 0
      && (await rowsOf(runtime, B.b, `SELECT count(*)::int n FROM "ServiceLoanEvent" WHERE "businessId" = $1`, A.b))[0].n === 0);
    ok("I2 no tenant context sees nothing", (await rowsOf(runtime, null, `SELECT count(*)::int n FROM "ServiceLoan"`))[0].n === 0);
    ok("I3 B cannot write a loan for A (RLS)", has(await inTx(runtime, B.b, (tx) => lendTx(tx, A, c)), /row-level security|SERVICE_LOAN_CASE_INVALID/));
    ok("I4 B cannot lend on A's case: the guard refuses (SERVICE_LOAN_CASE_INVALID) before the composite tenant FK would", has(await inTx(runtime, B.b, (tx) => lendTx(tx, B, c)), "SERVICE_LOAN_CASE_INVALID"));
    ok("I4b … and the composite tenant FK alone refuses it too (owner, guard bypassed by a disabled trigger)", has(await inTx(owner, B.b, async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "ServiceLoan" DISABLE TRIGGER "ServiceLoan_insert_guard"`);
      await tx.$executeRawUnsafe(`INSERT INTO "ServiceLoan" ("businessId", "caseId", "itemName", "lentByUserId", "conditionAtLend") VALUES ($1, $2, 'x', $3, 'GOOD')`, B.b, c, B.u);
    }), /ServiceLoan_case_tenant_fkey|foreign key/));
    ok("I5 B cannot reference A's inventory item", has(await lend(B, await kase(B, TO_REPAIR), { item: A.item }), /foreign key|ServiceLoan_inventory_item_tenant_fkey/));
    ok("I6 B cannot return A's loan (the UPDATE sees no row)", (await rowsOf(runtime, B.b, `UPDATE "ServiceLoan" SET state = 'RETURNED' WHERE id = $1 RETURNING id`, l)).length === 0 && (await state(A, l)).s === "OUT");
    ok("I7 an event of B naming A's loan → refused", has(await inTx(runtime, B.b, (tx) => tx.$executeRawUnsafe(`INSERT INTO "ServiceLoanEvent" ("businessId", "loanId", "caseId", seq, kind, "stateAfter", condition, actor, "actorUserId", "idempotencyKey") VALUES ($1, $2, $3, 2, 'EXPECTED_RETURN_CHANGED', 'OUT', NULL, 'OWNER_USER', $4, $5)`, B.b, l, c, B.u, ikey())), "SERVICE_LOAN_EVENT_LOAN_INVALID"));
  }

  console.log("M — immutability");
  {
    const c = await kase(A, TO_REPAIR);
    await lend(A, c, { ident: "IMM-1" });
    const l = await loanOf(A, c);
    ok("M1 the runtime cannot DELETE a loan (no grant)", has(await inTx(runtime, A.b, (tx) => tx.$executeRawUnsafe(`DELETE FROM "ServiceLoan" WHERE id = $1`, l)), /permission denied/));
    ok("M2 even the owner cannot DELETE a loan or an event (guard)", has(await inTx(owner, A.b, (tx) => tx.$executeRawUnsafe(`DELETE FROM "ServiceLoanEvent" WHERE "loanId" = $1`, l)), "SERVICE_LOAN_APPEND_ONLY")
      && has(await inTx(owner, A.b, (tx) => tx.$executeRawUnsafe(`DELETE FROM "ServiceLoan" WHERE id = $1`, l)), /SERVICE_LOAN_APPEND_ONLY|foreign key/));
    ok("M3 TRUNCATE refused (owner)", has(await inTx(owner, null, (tx) => tx.$executeRawUnsafe(`TRUNCATE "ServiceLoanEvent"`)), /TRUNCATE|SERVICE_/i)
      && has(await inTx(owner, null, (tx) => tx.$executeRawUnsafe(`TRUNCATE "ServiceLoan" CASCADE`)), /TRUNCATE|SERVICE_/i));
    ok("M4 an event cannot be edited (runtime: no grant; owner: guard)", has(await inTx(runtime, A.b, (tx) => tx.$executeRawUnsafe(`UPDATE "ServiceLoanEvent" SET reason = 'x' WHERE "loanId" = $1`, l)), /permission denied/)
      && has(await inTx(owner, A.b, (tx) => tx.$executeRawUnsafe(`UPDATE "ServiceLoanEvent" SET condition = 'DAMAGED' WHERE "loanId" = $1`, l)), "SERVICE_LOAN_APPEND_ONLY"));
    ok("M5 an update with no kind change (the item name, same version) → refused", has(await inTx(runtime, A.b, (tx) => tx.$executeRawUnsafe(`UPDATE "ServiceLoan" SET "itemName" = 'אחר' WHERE id = $1`, l)), "SERVICE_LOAN_VERSION"));
    ok("M6 a CASE_EXIT_APPROVED that changes the condition at lending → refused", has(await change(A, l, "CASE_EXIT_APPROVED", { set: `"conditionAtLend" = 'WORN'`, evApprovalKind: "CANCEL_OPEN_LOANER", evApprover: A.u, evReason: "x", caseSeq: 4 }), "SERVICE_LOAN_CHANGE_NOT_KIND"));
    ok("M7 the runtime cannot borrow the erasure marker to blank a loan", has(await inTx(runtime, A.b, async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('dubiz.service_loan_erasure', 'on', true)`);
      await tx.$executeRawUnsafe(`UPDATE "ServiceLoan" SET "itemName" = NULL, "itemIdentifier" = NULL, "itemIdentifierNormalized" = NULL, "lentByUserId" = NULL, "erasedAt" = now() WHERE id = $1`, l);
    }), /SERVICE_LOAN_VERSION|SERVICE_LOAN_/));
    ok("M9 the runtime cannot null a user column by a plain update (only a deleted user's FK action may)",
      has(await inTx(runtime, A.b, (tx) => tx.$executeRawUnsafe(`UPDATE "ServiceLoan" SET "lentByUserId" = NULL WHERE id = $1`, l)), /SERVICE_LOAN_VERSION|SERVICE_LOAN_/));
    ok("M10 an extra journal event that mirrors no loan version (seq beyond the version) → refused SERVICE_LOAN_EVENT_MISMATCH",
      has(await inTx(runtime, A.b, (tx) => tx.$executeRawUnsafe(`INSERT INTO "ServiceLoanEvent" ("businessId", "loanId", "caseId", seq, kind, "stateAfter", actor, "actorUserId", "idempotencyKey")
        VALUES ($1, $2, $3, 7, 'EXPECTED_RETURN_CHANGED', 'OUT', 'OWNER_USER', $4, $5)`, A.b, l, c, A.u, ikey())), "SERVICE_LOAN_EVENT_MISMATCH"));
    ok("M8 an EXIT approval while no cancel happened (case event at the current seq is not a CANCEL) → refused",
      has(await change(A, l, "CASE_EXIT_APPROVED", { evApprovalKind: "CANCEL_OPEN_LOANER", evApprover: A.u, evReason: "x", caseSeq: Number((await rowsOf(owner, A.b, `SELECT version FROM "ServiceCase" WHERE id = $1`, c))[0].version) }), "SERVICE_LOAN_EXIT_NOT_BOUND"));
  }

  console.log("K — concurrency (two connections)");
  {
    const c1 = await kase(A, TO_REPAIR), c2 = await kase(A, TO_REPAIR);
    const both = await Promise.all([lend(A, c1, { ident: "RACE-1" }, runtime), lend(A, c2, { ident: "race 1" }, runtime2)]);
    ok("K1 the same item lent on two cases at once → exactly one loan", both.filter((r) => r === "OK").length === 1 && both.some((r) => /unique|23505|one_out_per_identifier/i.test(r))
      && Number((await rowsOf(owner, A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "businessId" = $1 AND "itemIdentifierNormalized" = 'RACE1' AND state = 'OUT'`, A.b))[0].n) === 1, JSON.stringify(both));
    const l = Number((await rowsOf(owner, A.b, `SELECT id FROM "ServiceLoan" WHERE "businessId" = $1 AND "itemIdentifierNormalized" = 'RACE1'`, A.b))[0].id);
    const two = await Promise.all([change(A, l, "RETURNED", RETURN(A), runtime), change(A, l, "RETURNED", RETURN(A), runtime2)]);
    ok("K2 two returns at once → exactly one; the loan is RETURNED at version 2 with two events", two.filter((r) => r === "OK").length === 1
      && (await state(A, l)).v === 2 && (await events(A, l)).length === 2, JSON.stringify(two));
    const c3 = await kase(A, TO_REPAIR);
    const race = await Promise.all([
      lend(A, c3, { ident: "RACE-3" }, runtime),
      inTx(runtime2, A.b, async (tx) => { await new Promise((r) => setTimeout(r, 30)); await moveTx(tx, A.b, c3, "READY", "CANCEL", "case.cancelled", `outcome = 'CANCELLED', "cancelReason" = 'בוטל', "cancelledAt" = now()`); }),
    ]);
    const after = (await rowsOf(owner, A.b, `SELECT c.outcome::text o, (SELECT count(*)::int FROM "ServiceLoan" l WHERE l."caseId" = c.id AND l.state = 'OUT') n FROM "ServiceCase" c WHERE c.id = $1`, c3))[0];
    ok("K3 a loan and an unapproved cancel of one case at once never leave a cancelled case with an unapproved loan out",
      !(after.o === "CANCELLED" && Number(after.n) > 0) && race.filter((r) => r === "OK").length === 1, JSON.stringify([race, after]));

    // the handover vs a return / a new loan of the same case. Lock order on every path: the case row first, then the loan.
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const lockCase = (tx: Tx, caseId: number) => tx.$queryRawUnsafe(`SELECT id FROM "ServiceCase" WHERE id = $1 FOR UPDATE`, caseId);
    const hovRow = async (caseId: number) => (await rowsOf(owner, A.b, `SELECT count(*)::int n, bool_or("loanerApprovedAt" IS NOT NULL OR "loanerOverrideReason" IS NOT NULL) x FROM "ServiceHandover" WHERE "caseId" = $1`, caseId))[0];
    const outN = async (caseId: number) => Number((await rowsOf(owner, A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "caseId" = $1 AND state = 'OUT'`, caseId))[0].n);
    // K4: the return (the service's order: case lock, loan, event) holds its locks; the handover with the exception
    // arrives meanwhile, waits for the case, then reads the committed return → refused
    const k4 = await kase(A, TO_READY);
    await lend(A, k4, { reason: "עד האיסוף", ident: "RACE-4" });
    const l4 = await loanOf(A, k4);
    const r4 = await Promise.all([
      inTx(runtime, A.b, async (tx) => { await lockCase(tx, k4); await changeTx(tx, A, l4, "RETURNED", RETURN(A)); await wait(400); }),
      (async () => { await wait(100); return inTx(runtime2, A.b, (tx) => hovTx(tx, A, k4, EXC(A))); })(),
    ]);
    ok("K4 a return and a handover WITH the exception at once → the return wins, the exception is refused SERVICE_HANDOVER_LOANER_NONE",
      r4[0] === "OK" && has(r4[1], "SERVICE_HANDOVER_LOANER_NONE") && Number((await hovRow(k4)).n) === 0 && (await outN(k4)) === 0, JSON.stringify(r4));
    // K4b: the other order — the handover WITH the exception first (it holds the case, and the OUT loan FOR SHARE); the
    // return (case lock first) waits, then commits after it: the exception was saved while the loan was out; no deadlock
    const k4b = await kase(A, TO_READY);
    await lend(A, k4b, { reason: "עד האיסוף", ident: "RACE-4B" });
    const l4b = await loanOf(A, k4b);
    const r4b = await Promise.all([
      inTx(runtime2, A.b, async (tx) => { await hovTx(tx, A, k4b, EXC(A)); await wait(400); }),
      (async () => { await wait(100); return inTx(runtime, A.b, async (tx) => { await lockCase(tx, k4b); await changeTx(tx, A, l4b, "RETURNED", RETURN(A)); }); })(),
    ]);
    ok("K4b the handover with the exception first, the return arriving meanwhile → it waits, both commit (the loan was out when approved), no deadlock",
      r4b[0] === "OK" && r4b[1] === "OK" && (await hovRow(k4b)).x === true && (await outN(k4b)) === 0, JSON.stringify(r4b));
    // K5: a NEW loan (its insert guard locks the case) holds; the handover WITHOUT the exception arrives meanwhile, waits
    // for the case, then sees the committed loan → refused (never a case with a loan out and a handover without approval)
    const k5 = await kase(A, TO_READY);
    const r5 = await Promise.all([
      inTx(runtime, A.b, async (tx) => { await lendTx(tx, A, k5, { reason: "עד האיסוף", ident: "RACE-5" }); await wait(400); }),
      (async () => { await wait(100); return inTx(runtime2, A.b, (tx) => hovTx(tx, A, k5, {})); })(),
    ]);
    ok("K5 a new loan and a handover WITHOUT the exception at once → the loan wins, the handover is refused SERVICE_HANDOVER_LOANER_OUT",
      r5[0] === "OK" && has(r5[1], "SERVICE_HANDOVER_LOANER_OUT") && Number((await hovRow(k5)).n) === 0 && (await outN(k5)) === 1, JSON.stringify(r5));
    // K5b: a new loan racing a handover WITH the exception on a case with no loan before: after the case lock the loan is
    // seen → the exception is valid and accepted (no false refusal, no stale "none")
    const k5b = await kase(A, TO_READY);
    const r5b = await Promise.all([
      inTx(runtime, A.b, async (tx) => { await lendTx(tx, A, k5b, { reason: "עד האיסוף", ident: "RACE-5B" }); await wait(400); }),
      (async () => { await wait(100); return inTx(runtime2, A.b, (tx) => hovTx(tx, A, k5b, EXC(A))); })(),
    ]);
    ok("K5b a new loan and a handover WITH the exception at once → both commit; the exception names a loan that is out",
      r5b[0] === "OK" && r5b[1] === "OK" && (await hovRow(k5b)).x === true && (await outN(k5b)) === 1, JSON.stringify(r5b));
    // K6: REPEATABLE READ — the handover's snapshot predates a committed return; the guard never judges by the stale "out"
    const k6 = await kase(A, TO_READY);
    await lend(A, k6, { reason: "עד האיסוף", ident: "RACE-6" });
    const l6 = await loanOf(A, k6);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const r6 = await Promise.all([
      runtime2.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(A.b));
        await tx.$queryRawUnsafe(`SELECT count(*) FROM "ServiceLoan" WHERE "caseId" = $1`, k6); // the snapshot is taken here
        await gate;
        await hovTx(tx, A, k6, EXC(A));
      }, { isolationLevel: "RepeatableRead", timeout: 60_000, maxWait: 60_000 }).then(() => "OK", (e) => `ERR:${err(e).slice(-300)}`),
      (async () => { await wait(100); const x = await change(A, l6, "RETURNED", RETURN(A)); release(); return x; })(),
    ]);
    ok("K6 REPEATABLE READ: a return committed after the handover's snapshot → the exception is refused (serialization failure), never saved",
      r6[1] === "OK" && /could not serialize|40001|SERVICE_HANDOVER_LOANER_NONE/i.test(r6[0]) && Number((await hovRow(k6)).n) === 0, JSON.stringify(r6));
  }

  console.log("F — failure mid-operation");
  {
    const c = await kase(A, TO_REPAIR);
    const r = await inTx(runtime, A.b, async (tx) => { await lendTx(tx, A, c, { ident: "FAIL-1" }); await tx.$executeRawUnsafe(`SELECT 1 / 0`); });
    ok("F1 a lend whose transaction fails after the row and its event → nothing remains", has(r, /division by zero/) && Number((await rowsOf(owner, A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "caseId" = $1`, c))[0].n) === 0
      && (await lend(A, c, { ident: "FAIL-1" })) === "OK");
    const l = await loanOf(A, c);
    const r2 = await inTx(runtime, A.b, async (tx) => { await changeTx(tx, A, l, "RETURNED", RETURN(A)); throw new Error("lab fault"); });
    ok("F2 a return that fails mid-way → the loan is still OUT at version 1", has(r2, "lab fault") && (await state(A, l)).s === "OUT" && (await state(A, l)).v === 1);
  }

  console.log("Q — idempotency keys");
  {
    const c = await kase(A, TO_REPAIR);
    const k = ikey();
    ok("Q1 the first loan with a key → accepted", (await lend(A, c, { key: k })) === "OK");
    ok("Q2 a second event with the same key in the business → refused (UNIQUE), nothing written", has(await lend(A, c, { key: k }), /unique|23505|idempotencyKey/i)
      && Number((await rowsOf(owner, A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "caseId" = $1`, c))[0].n) === 1);
    ok("Q3 the same key in another business is another request", (await lend(B, await kase(B, TO_REPAIR), { key: k })) === "OK");
    ok("Q4 a malformed key → refused by CHECK", has(await lend(A, c, { key: "bad key!" }), "ServiceLoanEvent_tokens"));
  }

  console.log("Z — erasure");
  {
    const E = await business("e");
    const E2 = await user(E, "e2");
    const c = await kase(E, TO_REPAIR);
    await lend(E, c, { ident: "ERA-1", note: "שריטה", expected: "2026-12-30" });
    const l1 = await loanOf(E, c);
    await change(E, l1, "CLOSED", CLOSE(E.u, E.u));
    const o = await kase(E);
    await lend(E, o, { actor: E2, reason: "חריג" });
    const l2 = await loanOf(E, o);
    ok("Z1 refused without a tenant context", has(await inTx(runtime, null, (tx) => tx.$queryRawUnsafe(`SELECT public.service_loan_erase_business() n`)), "SERVICE_LOAN_ERASURE_NO_CONTEXT"));
    ok("Z2 refused while the business is not being deleted", has(await inTx(runtime, E.b, (tx) => tx.$queryRawUnsafe(`SELECT public.service_loan_erase_business() n`)), "SERVICE_LOAN_ERASURE_NOT_DELETING"));
    await q(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, E.b);
    ok("Z3 a new loan for a business being deleted → refused", has(await lend(E, await kase(E, TO_REPAIR).catch(() => c)), /SERVICE_UI_BUSINESS_DELETING/));
    const n = Number((await rowsOf(runtime, E.b, `SELECT public.service_loan_erase_business() n`))[0].n);
    const rows = await rowsOf(owner, E.b, `SELECT "itemName" a, "itemIdentifier" b, "itemIdentifierNormalized" c, "lendNote" d, "closeNote" e, "lendExceptionReason" f,
      "lentByUserId" g, "lendApprovedByUserId" h, "closedByUserId" i, "closeApprovedByUserId" j, "erasedAt" IS NOT NULL z, state::text s, "conditionAtLend"::text cl,
      "closeReason"::text cr, "closeApprovedAt" IS NOT NULL ct, "lendApprovedAt" IS NOT NULL lt, to_char("expectedReturnOn", 'YYYY-MM-DD') x, version v FROM "ServiceLoan" WHERE id = ANY($1::int[]) ORDER BY id`, [l1, l2]);
    const evs = await rowsOf(owner, E.b, `SELECT "actorUserId" a, "approvedByUserId" b, reason r, "requestDigest" d, "erasedAt" IS NOT NULL z, kind::text k FROM "ServiceLoanEvent" WHERE "loanId" = ANY($1::int[])`, [l1, l2]);
    ok("Z4 the erasure clears every free text and user of the loans", n === 2 + evs.length && rows.every((r) => [r.a, r.b, r.c, r.d, r.e, r.f, r.g, r.h, r.i, r.j].every((v) => v === null) && r.z === true), `${n} ${JSON.stringify(rows)}`);
    ok("Z5 … and keeps the states, conditions, close reason, approval times, dates and versions", rows[0].s === "CLOSED" && rows[0].cr === "LOST" && rows[0].ct === true && rows[0].cl === "GOOD"
      && rows[0].x === "2026-12-30" && Number(rows[0].v) === 2 && rows[1].s === "OUT" && rows[1].lt === true, JSON.stringify(rows));
    ok("Z6 the journal: actors, approvers, reasons, digests cleared; kinds kept", evs.every((e) => e.a === null && e.b === null && e.r === null && e.d === null && e.z === true) && evs.some((e) => e.k === "CLOSED"), JSON.stringify(evs));
    ok("Z7 re-run → 0", Number((await rowsOf(runtime, E.b, `SELECT public.service_loan_erase_business() n`))[0].n) === 0);
    ok("Z8 another business's loans are untouched", Number((await rowsOf(owner, A.b, `SELECT count(*)::int n FROM "ServiceLoan" WHERE "businessId" = $1 AND ("erasedAt" IS NOT NULL OR "itemName" IS NULL)`, A.b))[0].n) === 0);
    const del = await inTx(owner, null, (tx) => tx.$executeRawUnsafe(`DELETE FROM "Business" WHERE id = $1`, E.b));
    ok("B1 deleting the business (cascade) removes its loans and journal; no guard blocks it", del === "OK"
      && Number((await q(`SELECT count(*)::int n FROM "ServiceLoan" WHERE "businessId" = $1`, E.b))[0].n) === 0
      && Number((await q(`SELECT count(*)::int n FROM "ServiceLoanEvent" WHERE "businessId" = $1`, E.b))[0].n) === 0, del);
    ok("B2 the other businesses' loans are all still there", Number((await q(`SELECT count(*)::int n FROM "ServiceLoan" WHERE "businessId" = $1`, A.b))[0].n) > 20);
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  await Promise.all([owner.$disconnect(), runtime.$disconnect(), runtime2.$disconnect()]);
  if (failures.length > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await Promise.all([owner.$disconnect(), runtime.$disconnect(), runtime2.$disconnect()]); process.exit(1); });
