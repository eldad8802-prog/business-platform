/**
 * Service Desk 1.2b — migration 20261113090000_service_external_work, AS the real roles (.sdx/lab.sh --with-sdx).
 *
 *   1. Structure: two tables ENABLE + FORCE RLS, per-operation policies, explicit grants, eight functions with
 *      search_path … pg_temp last, one SECURITY DEFINER (the new erasure), the foundation's erasure unchanged.
 *   2. Isolation: reads, writes and references across businesses (case, supplier, staff, user), no tenant context.
 *   3. Send: only a case that is EXTERNAL, next round, initial state, device copied from the case.
 *   4. One open work per case and per device — under real concurrency, READ COMMITTED and REPEATABLE READ (corr. 2).
 *   5. Changes: one kind per version, forward-only progress, costs, final once, COST_FINAL_CORRECTED (corr. 1),
 *      no silent change (deferred check), the event mirrors the row, idempotency.
 *   6. Return, the case leaving EXTERNAL, the handover guard (ח‑8), supplier reference (corr. 3).
 *   7. Journal append-only; no DELETE for the runtime.
 *   8. Atomicity: a failed send or return leaves nothing.
 *   9. Account erasure through service_external_erase_business(); the foundation's erasure still works.
 *  10. 1.2a regression on the same database (opening, plain status changes, handover without work).
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. Raw SQL only.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";
import { parseDbFunction } from "../lib/services/account/erasure-db-function-contract";

const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=24&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: withPool(process.env.OWNER_URL!) });
const runtime = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!) });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
type Iso = Prisma.TransactionIsolationLevel;
async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>, iso?: Iso): Promise<T | string> {
  return client.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }, { timeout: 60_000, maxWait: 60_000, ...(iso ? { isolationLevel: iso } : {}) }).catch((e: Error) => e.message);
}
const q = (c: PrismaClient, g: number | null, sql: string, ...a: unknown[]) => inTx(c, g, (tx) => tx.$queryRawUnsafe(sql, ...a) as Promise<Rows>);
const x = (c: PrismaClient, g: number | null, sql: string, ...a: unknown[]) => inTx(c, g, (tx) => tx.$executeRawUnsafe(sql, ...a));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, k = "n") => Number(rows(r)[0]?.[k] ?? NaN);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const succeeded = (r: unknown) => typeof r !== "string";
const CHECK = /check constraint|23514/i, UNIQUE = /unique constraint|duplicate key|23505/i, FK = /foreign key|23503/i;
const RLS = /row-level security/i, DENIED = /permission denied/i;
const MIG = "20261113090000_service_external_work";
const TABLES = ["ServiceExternalWork", "ServiceExternalWorkEvent"];
const FNS = ["service_external_work_insert_guard", "service_external_work_guard", "service_external_work_has_event", "service_external_event_matches_work",
  "service_external_event_guard", "service_handover_no_open_external", "service_case_external_work_closed", "service_external_erase_business"];
let keySeq = 0;
const ikey = () => `sdx-lab-key-${String(++keySeq).padStart(6, "0")}`;

// ── fixtures (owner) and runtime helpers ────────────────────────────────────────────────────────────────────
const one = async (sql: string, ...a: unknown[]) => num(await q(owner, null, sql, ...a), "id");
async function business(name: string) {
  const biz = await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, name);
  const user = await one(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `${name}@lab.invalid`, biz);
  const cust = await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח', now()) RETURNING id`, biz);
  const staff = await one(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאי', now()) RETURNING id`, biz);
  const supplier = await one(`INSERT INTO "Supplier" ("businessId", name, "updatedAt") VALUES ($1, 'מעבדה חיצונית', now()) RETURNING id`, biz);
  return { biz, user, cust, staff, supplier };
}
type B = Awaited<ReturnType<typeof business>>;
async function device(b: B) {
  return num(await q(runtime, b.biz, `INSERT INTO "ServiceDevice" ("businessId", "customerId", brand, "updatedAt") VALUES ($1, $2, 'Samsung', now()) RETURNING id AS n`, b.biz, b.cust));
}
/** A case created with its opening (1.1c) and moved to EXTERNAL with its case event — what a send does first. */
async function externalCaseTx(tx: Tx, b: B, deviceId: number | null) {
  const n = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCaseNumberSequence" ("businessId", "nextValue") VALUES ($1, 2)
    ON CONFLICT ("businessId") DO UPDATE SET "nextValue" = "ServiceCaseNumberSequence"."nextValue" + 1 RETURNING "nextValue" - 1 AS n`, b.biz)) as Rows)[0].n);
  const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "deviceId", "problemDescription", "updatedAt")
    VALUES ($1, $2, 'IN_SHOP', $3, $4, 'לא נדלק', now()) RETURNING id`, b.biz, n, b.cust, deviceId)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, payload, "idempotencyKey")
    VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', '{}', $3)`, b.biz, id, ikey());
  await caseMoveTx(tx, b.biz, id, `status = 'EXTERNAL'`, "SEND_TO_EXTERNAL", "external.sent", "OPEN", "EXTERNAL");
  return id;
}
async function caseMoveTx(tx: Tx, biz: number, caseId: number, set: string, action: string, type: string, from: string, to: string, extra: { outcome?: string | null; crBefore?: boolean; crAfter?: boolean } = {}) {
  const v = Number(((await tx.$queryRawUnsafe(`UPDATE "ServiceCase" SET ${set}, version = version + 1, "updatedAt" = now() WHERE id = $1 RETURNING version`, caseId)) as Rows)[0].version);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4::"ServiceEventType", $5::"ServiceCaseAction", $6::"ServiceCaseStatus", $7::"ServiceCaseStatus", $8, $9, $10::"ServiceOutcome", 'SYSTEM', '{}', $11)`,
    biz, caseId, v, type, action, from, to, extra.crBefore ?? false, extra.crAfter ?? false, extra.outcome ?? null, ikey());
}
async function sendTx(tx: Tx, b: B, caseId: number, o: { round?: number; supplierId?: number; ref?: string | null; deviceId?: number | null; texts?: boolean } = {}) {
  const w = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "deviceId", "sentByUserId", "sendReason", "requestedWork", "conditionAtSend", "operationalNote", "supplierReference", "expectedBackOn", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, 'אין לנו ציוד', 'החלפת מסך', 'סדק בפינה', 'שליח ביום ב', $7, DATE '2026-11-20', now()) RETURNING id`,
    b.biz, caseId, o.round ?? 1, o.supplierId ?? b.supplier, o.deviceId ?? null, b.user, o.ref === undefined ? null : o.ref)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", "expectedBackOn", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, 1, 'SENT', 'SENT', DATE '2026-11-20', 'OWNER_USER', $4, '{"round":1}', $5)`, b.biz, w, caseId, b.user, ikey());
  return w;
}
const send = (b: B, caseId: number, o = {}) => inTx(runtime, b.biz, (tx) => sendTx(tx, b, caseId, o));
/** A change of a work: the row (version + 1, kind) and its event, as task 1.3 will write them. */
async function changeTx(tx: Tx, biz: number, workId: number, kind: string, set: string, ev: { amount?: number | null; previous?: number | null; reason?: string | null; key?: string; seqOverride?: number; kindOverride?: string } = {}) {
  const r = ((await tx.$queryRawUnsafe(`UPDATE "ServiceExternalWork" SET ${set ? set + ", " : ""}version = version + 1, "lastEventKind" = $2::"ServiceExternalWorkEventKind", "updatedAt" = now()
    WHERE id = $1 RETURNING version, "caseId", "progressStage"::text AS stage, "expectedBackOn"`, workId, kind)) as Rows)[0];
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", "amountAgorot", "previousAmountAgorot", "expectedBackOn", reason, actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4, $5::"ServiceExternalWorkEventKind", $6::"ServiceExternalProgress", $7, $8, $9::date, $10, 'OWNER_USER', NULL, '{}', $11)`,
    biz, workId, r.caseId, ev.seqOverride ?? Number(r.version), ev.kindOverride ?? kind, r.stage, ev.amount ?? null, ev.previous ?? null, r.expectedBackOn, ev.reason ?? null, ev.key ?? ikey());
  return Number(r.version);
}
const change = (b: B, workId: number, kind: string, set: string, ev = {}) => inTx(runtime, b.biz, (tx) => changeTx(tx, b.biz, workId, kind, set, ev));

async function main() {
  // ── 1. Structure ──────────────────────────────────────────────────────────────────────────────────────────
  console.log("1. structure");
  ok("1.1 the migration is recorded and finished; nothing pending",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, MIG)) === 1
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`)) === 0);
  ok("1.2 two tables, ENABLE + FORCE RLS",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity`, TABLES)) === 2);
  ok("1.3 five per-operation policies, none for DELETE or ALL",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname = ANY($1)`, TABLES)) === 5
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname = ANY($1) AND p.polcmd IN ('d','*')`, TABLES)) === 0);
  const g = Object.fromEntries(rows(await q(owner, null, `SELECT c.relname AS t, string_agg(x.privilege_type, ',' ORDER BY x.privilege_type) AS p
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x WHERE c.relname = ANY($1) AND pg_get_userbyid(x.grantee) = 'app_runtime' GROUP BY 1`, TABLES)).map((r) => [r.t, r.p]));
  ok("1.4 app_runtime: SELECT/INSERT/UPDATE on the work, SELECT/INSERT on the journal, no DELETE", g.ServiceExternalWork === "INSERT,SELECT,UPDATE" && g.ServiceExternalWorkEvent === "INSERT,SELECT", JSON.stringify(g));
  ok("1.5 no other role holds anything on the new tables or sequences",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE c.relname = ANY($1) AND x.grantee <> c.relowner AND pg_get_userbyid(x.grantee) <> 'app_runtime'`, [...TABLES, ...TABLES.map((t) => `${t}_id_seq`)])) === 0);
  const fns = rows(await q(owner, null, `SELECT proname, prosecdef s, proconfig::text cfg, has_function_privilege('public', oid, 'EXECUTE') pub, has_function_privilege('app_runtime', oid, 'EXECUTE') rt
    FROM pg_proc WHERE proname = ANY($1) AND pronamespace = 'public'::regnamespace`, FNS));
  ok("1.6 eight new functions, search_path … pg_temp last, none executable by PUBLIC",
    fns.length === 8 && fns.every((f) => String(f.cfg).includes("search_path=pg_catalog, public, pg_temp") && f.pub === false), JSON.stringify(fns.map((f) => f.proname)));
  ok("1.7 exactly one SECURITY DEFINER among them (the new erasure), executable by app_runtime",
    fns.filter((f) => f.s).length === 1 && fns.some((f) => f.proname === "service_external_erase_business" && f.s && f.rt));
  ok("1.8 the foundation's service_erase_business() is unchanged (still definer, pg_temp last, touches no external table)",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'service_erase_business' AND prosecdef
      AND proconfig::text LIKE '%pg_temp%' AND prosrc NOT LIKE '%ServiceExternal%'`)) === 1);
  const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations", MIG, "migration.sql"), "utf8");
  const p = parseDbFunction(sql, "service_external_erase_business");
  ok("1.9 the erasure function passes the contract's database-function checks (C25: definer, pg_temp, revoked, granted, tenant-scoped, deletion-gated, only scoped UPDATEs)",
    p.defined && p.securityDefiner && p.searchPathPgTempLast && p.revokedFromPublic && p.grantedToRuntime && p.refusesWithoutContext && p.refusesUnlessDeleting
    && p.unscopedWrites.length === 0 && JSON.stringify([...p.updates.keys()].sort()) === JSON.stringify(["ServiceExternalWork", "ServiceExternalWorkEvent"]), JSON.stringify({ ...p, updates: [...p.updates.keys()] }));

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────────
  const A = await business("sdx-A"), Bz = await business("sdx-B"), E = await business("sdx-erase");
  const inactive = await one(`INSERT INTO "Supplier" ("businessId", name, "isActive", "updatedAt") VALUES ($1, 'לא פעיל', false, now()) RETURNING id`, A.biz);
  ok("0.0 synthetic fixtures", [A.biz, Bz.biz, E.biz, inactive].every((n) => n > 0));
  const dA = await device(A), dShared = await device(A);

  // ── 2. Isolation ──────────────────────────────────────────────────────────────────────────────────────────
  console.log("2. isolation");
  const c1 = (await inTx(runtime, A.biz, (tx) => externalCaseTx(tx, A, dA))) as number;
  const w1 = await send(A, c1);
  ok("2.1 the runtime sends a case of its business to its supplier", succeeded(w1), String(w1));
  const work1 = w1 as number;
  ok("2.2 business B sees none of A's work or journal",
    num(await q(runtime, Bz.biz, `SELECT (SELECT count(*) FROM "ServiceExternalWork") + (SELECT count(*) FROM "ServiceExternalWorkEvent") AS n`)) === 0);
  ok("2.3 no tenant context: nothing", num(await q(runtime, null, `SELECT count(*)::int AS n FROM "ServiceExternalWork"`)) === 0);
  const cB = (await inTx(runtime, Bz.biz, (tx) => externalCaseTx(tx, Bz, null))) as number;
  ok("2.4 A's case sent to B's supplier → refused (composite FK)", refused(await send(A, (await inTx(runtime, A.biz, (tx) => externalCaseTx(tx, A, null))) as number, { supplierId: Bz.supplier }), FK));
  const r25 = await inTx(runtime, A.biz, (tx) => sendTx(tx, Bz, cB));
  ok("2.5 a work of business B written from A's context → refused (its case is invisible, or RLS)", refused(r25, /row-level security|SERVICE_EXTERNAL_CASE_INVALID/), String(r25).slice(0, 160));
  ok("2.6 a work naming another business's case → refused", refused(await inTx(runtime, A.biz, (tx) => sendTx(tx, A, cB)), /SERVICE_EXTERNAL_CASE_INVALID|foreign key/));
  ok("2.7 a return received by B's staff member → refused (composite FK)",
    refused(await change(A, work1, "RETURNED", `state = 'RETURNED', "returnedAt" = now(), "returnResult" = 'REPAIRED', "receivedByStaffMemberId" = ${Bz.staff}`), FK));
  ok("2.8 a send by B's user → refused (same-business user)",
    refused(await inTx(runtime, A.biz, async (tx) => { const c = await externalCaseTx(tx, A, null); return tx.$executeRawUnsafe(
      `INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "sentByUserId", "sendReason", "updatedAt") VALUES ($1, $2, 1, $3, $4, 'x', now())`, A.biz, c, A.supplier, Bz.user); }), /SERVICE_USER_OTHER_BUSINESS/));
  ok("2.9 B updating A's work touches 0 rows",
    num(await q(runtime, Bz.biz, `WITH u AS (UPDATE "ServiceExternalWork" SET "updatedAt" = now() WHERE id = $1 RETURNING 1) SELECT count(*)::int AS n FROM u`, work1)) === 0);

  // ── 3. Send rules ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("3. send rules");
  const s1 = rows(await q(runtime, A.biz, `SELECT round, "deviceId", state::text st, "progressStage"::text ps, version, "lastEventKind"::text k FROM "ServiceExternalWork" WHERE id = $1`, work1))[0];
  ok("3.1 round 1, AT_SUPPLIER / SENT / version 1, the case's device copied", Number(s1.round) === 1 && Number(s1.deviceId) === dA && s1.st === "AT_SUPPLIER" && s1.ps === "SENT" && Number(s1.version) === 1 && s1.k === "SENT", JSON.stringify(s1));
  const cSpoof = (await inTx(runtime, A.biz, (tx) => externalCaseTx(tx, A, null))) as number;
  const spoof = await send(A, cSpoof, { deviceId: dShared });
  ok("3.2 a writer cannot choose the device: it is always the case's (here: none)", succeeded(spoof) && num(await q(runtime, A.biz, `SELECT COALESCE("deviceId", 0) AS n FROM "ServiceExternalWork" WHERE id = $1`, spoof)) === 0);
  const notExt = await inTx(runtime, A.biz, async (tx) => {
    const n = 900 + (++keySeq);
    const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt") VALUES ($1, $2, 'IN_SHOP', $3, 'x', now()) RETURNING id`, A.biz, n, A.cust)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, payload, "idempotencyKey") VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', '{}', $3)`, A.biz, id, ikey());
    return sendTx(tx, A, id);
  });
  ok("3.3 a send for a case that is not EXTERNAL → refused", refused(notExt, /SERVICE_EXTERNAL_CASE_NOT_EXTERNAL/));
  ok("3.4 round not next → refused", refused(await send(A, (await inTx(runtime, A.biz, (tx) => externalCaseTx(tx, A, null))) as number, { round: 2 }), /SERVICE_EXTERNAL_ROUND_NOT_NEXT/));
  ok("3.5 a send that is not at its initial state → refused",
    refused(await inTx(runtime, A.biz, async (tx) => { const c = await externalCaseTx(tx, A, null); return tx.$executeRawUnsafe(
      `INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "sendReason", "estimatedCostAgorot", "updatedAt") VALUES ($1, $2, 1, $3, 'x', 100, now())`, A.biz, c, A.supplier); }), /SERVICE_EXTERNAL_NOT_INITIAL/));
  ok("3.6 a send without its SENT event → refused at COMMIT (no silent work)",
    refused(await inTx(runtime, A.biz, async (tx) => { const c = await externalCaseTx(tx, A, null); return tx.$executeRawUnsafe(
      `INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "sendReason", "updatedAt") VALUES ($1, $2, 1, $3, 'x', now())`, A.biz, c, A.supplier); }), /SERVICE_EXTERNAL_SILENT_CHANGE/));
  ok("3.7 a second open work on the same case → refused (unique)", refused(await send(A, c1, { round: 2 }), UNIQUE));

  // ── 4. One open work per device under concurrency (correction 2) ────────────────────────────────────────
  console.log("4. one open work per device — concurrency");
  for (const iso of [undefined, "RepeatableRead"] as const) {
    const dev = await device(A);
    const cases = await Promise.all([0, 1, 2, 3, 4, 5].map(() => inTx(runtime, A.biz, (tx) => externalCaseTx(tx, A, dev)) as Promise<number>));
    const results = await Promise.all(cases.map((c) => inTx(runtime, A.biz, async (tx) => { const w = await sendTx(tx, A, c); await tx.$executeRawUnsafe(`SELECT pg_sleep(0.2)`); return w; }, iso as Iso | undefined)));
    const wins = results.filter(succeeded).length;
    const open = num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceExternalWork" WHERE "deviceId" = $1 AND state = 'AT_SUPPLIER'`, dev));
    ok(`4.${iso ? 2 : 1} six cases of ONE device sent at once (${iso ?? "ReadCommitted"}): exactly one succeeds, one open work`,
      wins === 1 && open === 1 && results.filter((r) => typeof r === "string").every((r) => UNIQUE.test(r as string)), JSON.stringify({ wins, open, errs: results.filter((r) => typeof r === "string").map((r) => String(r).slice(0, 60)) }));
  }
  const cDev2 = (await inTx(runtime, A.biz, (tx) => externalCaseTx(tx, A, dA))) as number;
  ok("4.3 the device of an open work cannot go out again through another case", refused(await send(A, cDev2), UNIQUE));

  // ── 5. Changes ────────────────────────────────────────────────────────────────────────────────────────────
  console.log("5. changes: one kind per version, costs, correction, no silent change");
  ok("5.1 progress forward (SENT → AWAITING_DIAGNOSIS, a skip) → accepted, version 2", (await change(A, work1, "PROGRESS", `"progressStage" = 'AWAITING_DIAGNOSIS'`)) === 2);
  ok("5.2 progress backward → refused", refused(await change(A, work1, "PROGRESS", `"progressStage" = 'RECEIVED_BY_SUPPLIER'`), /SERVICE_EXTERNAL_PROGRESS/));
  ok("5.3 the same stage again → refused", refused(await change(A, work1, "PROGRESS", `"progressStage" = 'AWAITING_DIAGNOSIS'`), /SERVICE_EXTERNAL_PROGRESS/));
  ok("5.4 a change outside its kind (PROGRESS that also moves a cost) → refused",
    refused(await change(A, work1, "PROGRESS", `"progressStage" = 'ESTIMATE_RECEIVED', "estimatedCostAgorot" = 100`), /SERVICE_EXTERNAL_CHANGE_NOT_KIND/));
  ok("5.5 a version that does not move by one → refused",
    refused(await x(runtime, A.biz, `UPDATE "ServiceExternalWork" SET version = version + 2, "lastEventKind" = 'PROGRESS', "progressStage" = 'REPAIR_DONE' WHERE id = $1`, work1), /SERVICE_EXTERNAL_VERSION/));
  ok("5.6 a change with no event → refused at COMMIT (no silent change)",
    refused(await x(runtime, A.biz, `UPDATE "ServiceExternalWork" SET version = version + 1, "lastEventKind" = 'EXPECTED_BACK_CHANGED', "expectedBackOn" = DATE '2026-12-01' WHERE id = $1`, work1), /SERVICE_EXTERNAL_SILENT_CHANGE/));
  ok("5.7 an event that names another kind than the change → refused",
    refused(await change(A, work1, "EXPECTED_BACK_CHANGED", `"expectedBackOn" = DATE '2026-12-01'`, { kindOverride: "PROGRESS" }), /SERVICE_EXTERNAL_EVENT_MISMATCH/));
  ok("5.8 an event at another seq → refused", refused(await change(A, work1, "EXPECTED_BACK_CHANGED", `"expectedBackOn" = DATE '2026-12-01'`, { seqOverride: 9 }), /SERVICE_EXTERNAL_EVENT_MISMATCH/));
  ok("5.9 the expected date moved → accepted, the event carries it", succeeded(await change(A, work1, "EXPECTED_BACK_CHANGED", `"expectedBackOn" = DATE '2026-12-01'`))
    && num(await q(runtime, A.biz, `SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "workId" = $1 AND kind = 'EXPECTED_BACK_CHANGED' AND "expectedBackOn" = DATE '2026-12-01'`, work1)) === 1);
  ok("5.10 an estimate, a revised estimate, an approved cost → accepted; the history keeps both estimates",
    succeeded(await change(A, work1, "COST_ESTIMATED", `"estimatedCostAgorot" = 30000`, { amount: 30000 }))
    && succeeded(await change(A, work1, "COST_ESTIMATED", `"estimatedCostAgorot" = 34000`, { amount: 34000, previous: 30000 }))
    && succeeded(await change(A, work1, "COST_APPROVED", `"approvedCostAgorot" = 32000`, { amount: 32000 }))
    && num(await q(runtime, A.biz, `SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "workId" = $1 AND kind = 'COST_ESTIMATED'`, work1)) === 2);
  ok("5.11 an event amount that is not the row's → refused", refused(await change(A, work1, "COST_APPROVED", `"approvedCostAgorot" = 33000`, { amount: 1 }), /SERVICE_EXTERNAL_EVENT_MISMATCH/));
  ok("5.12 a negative cost → refused", refused(await change(A, work1, "COST_ESTIMATED", `"estimatedCostAgorot" = -1`, { amount: -1 }), CHECK));
  ok("5.13 the final cost → accepted once", succeeded(await change(A, work1, "COST_FINAL", `"finalCostAgorot" = 31500`, { amount: 31500 })));
  ok("5.14 a second final cost → refused (correction only)", refused(await change(A, work1, "COST_FINAL", `"finalCostAgorot" = 30000`, { amount: 30000 }), /SERVICE_EXTERNAL_FINAL_ONCE/));
  ok("5.15 a 'correction' without a reason → refused (CHECK)", refused(await change(A, work1, "COST_FINAL_CORRECTED", `"finalCostAgorot" = 13500`, { amount: 13500, previous: 31500 }), CHECK));
  ok("5.16 a correction to the same value → refused", refused(await change(A, work1, "COST_FINAL_CORRECTED", `"finalCostAgorot" = 31500`, { amount: 31500, previous: 31500, reason: "x" }), /SERVICE_EXTERNAL_CORRECTION|check constraint/i));
  ok("5.17 COST_FINAL_CORRECTED with previous, new and reason → accepted; the original COST_FINAL event stays",
    succeeded(await change(A, work1, "COST_FINAL_CORRECTED", `"finalCostAgorot" = 13500`, { amount: 13500, previous: 31500, reason: "הוקלד 315 במקום 135" }))
    && num(await q(runtime, A.biz, `SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "workId" = $1 AND kind = 'COST_FINAL' AND "amountAgorot" = 31500`, work1)) === 1
    && num(await q(runtime, A.biz, `SELECT "finalCostAgorot" AS n FROM "ServiceExternalWork" WHERE id = $1`, work1)) === 13500);
  ok("5.18 a reason on any other kind → refused", refused(await change(A, work1, "EXPECTED_BACK_CHANGED", `"expectedBackOn" = DATE '2026-12-02'`, { reason: "x" }), CHECK));
  const dupKey = ikey();
  await change(A, work1, "EXPECTED_BACK_CHANGED", `"expectedBackOn" = DATE '2026-12-03'`, { key: dupKey });
  const vBefore = num(await q(runtime, A.biz, `SELECT version AS n FROM "ServiceExternalWork" WHERE id = $1`, work1));
  ok("5.19 a replayed idempotency key → refused, and its row change rolls back with it",
    refused(await change(A, work1, "EXPECTED_BACK_CHANGED", `"expectedBackOn" = DATE '2026-12-04'`, { key: dupKey }), UNIQUE)
    && num(await q(runtime, A.biz, `SELECT version AS n FROM "ServiceExternalWork" WHERE id = $1`, work1)) === vBefore);
  const race = await Promise.all([0, 1].map((i) => inTx(runtime, A.biz, async (tx) => {
    const n = Number(((await tx.$queryRawUnsafe(`UPDATE "ServiceExternalWork" SET version = version + 1, "lastEventKind" = 'EXPECTED_BACK_CHANGED', "expectedBackOn" = DATE '2026-12-1${i}', "updatedAt" = now()
      WHERE id = $1 AND version = $2 RETURNING version`, work1, vBefore)) as Rows).length);
    if (n === 0) return "VERSION_CONFLICT";
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", "expectedBackOn", actor, payload, "idempotencyKey")
      VALUES ($1, $2, $3, $4, 'EXPECTED_BACK_CHANGED', 'AWAITING_DIAGNOSIS', DATE '2026-12-1${i}', 'SYSTEM', '{}', $5)`, A.biz, work1, c1, vBefore + 1, ikey());
    await tx.$executeRawUnsafe(`SELECT pg_sleep(0.2)`);
    return "OK";
  })));
  ok("5.20 two concurrent changes at the same expected version: exactly one wins, the other is a version conflict",
    race.filter((r) => r === "OK").length === 1 && race.filter((r) => r === "VERSION_CONFLICT").length === 1, JSON.stringify(race));

  // ── 6. Return, case, handover, supplier reference ─────────────────────────────────────────────────────────
  console.log("6. return, case leaving EXTERNAL, handover (ח‑8), supplier reference (correction 3)");
  ok("6.1 the case leaving EXTERNAL while the work is at the supplier → refused at COMMIT",
    refused(await inTx(runtime, A.biz, (tx) => caseMoveTx(tx, A.biz, c1, `status = 'IN_REPAIR'`, "RETURN_FROM_EXTERNAL", "external.returned", "EXTERNAL", "IN_REPAIR")), /SERVICE_CASE_LEFT_EXTERNAL/));
  const cRet = (await inTx(runtime, A.biz, (tx) => externalCaseTx(tx, A, null))) as number;
  const wRet = (await send(A, cRet)) as number;
  ok("6.2 a handover while the item is at the supplier → refused",
    refused(await inTx(runtime, A.biz, async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET status = 'READY', outcome = 'REPAIRED' WHERE id = $1`, cRet);
      return tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot") VALUES ($1, $2, 'דנה', true, 0)`, A.biz, cRet);
    }), /SERVICE_HANDOVER_AT_SUPPLIER/));
  const ret = await inTx(runtime, A.biz, async (tx) => {
    await caseMoveTx(tx, A.biz, cRet, `status = 'READY', outcome = 'NOT_REPAIRED'`, "RETURN_FROM_EXTERNAL", "external.returned", "EXTERNAL", "READY", { outcome: "NOT_REPAIRED" });
    return changeTx(tx, A.biz, wRet, "RETURNED", `state = 'RETURNED', "returnedAt" = now(), "returnedByUserId" = ${A.user}, "returnResult" = 'NOT_REPAIRED', "workPerformed" = 'בדיקה בלבד', "unresolvedIssue" = 'לוח אם', "followUpRequired" = true, "receivedByStaffMemberId" = ${A.staff}`);
  });
  ok("6.3 the return: case READY / NOT_REPAIRED and the work RETURNED in one transaction → accepted", succeeded(ret), String(ret));
  ok("6.4 the handover after the return → accepted",
    succeeded(await x(runtime, A.biz, `INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot") VALUES ($1, $2, 'דנה', true, 0)`, A.biz, cRet)));
  ok("6.5 back to the supplier from RETURNED → refused", refused(await change(A, wRet, "PROGRESS", `state = 'AT_SUPPLIER', "progressStage" = 'REPAIR_DONE'`), /SERVICE_EXTERNAL_RETURNED|SERVICE_EXTERNAL_CHANGE_NOT_KIND|check constraint/i));
  ok("6.6 progress or an estimate after the return → refused",
    refused(await change(A, wRet, "PROGRESS", `"progressStage" = 'REPAIR_DONE'`), /SERVICE_EXTERNAL_RETURNED/)
    && refused(await change(A, wRet, "COST_ESTIMATED", `"estimatedCostAgorot" = 5`, { amount: 5 }), /SERVICE_EXTERNAL_RETURNED/));
  ok("6.7 a final cost after the return, then its correction → accepted",
    succeeded(await change(A, wRet, "COST_FINAL", `"finalCostAgorot" = 9000`, { amount: 9000 }))
    && succeeded(await change(A, wRet, "COST_FINAL_CORRECTED", `"finalCostAgorot" = 9900`, { amount: 9900, previous: 9000, reason: "חשבונית" })));
  ok("6.8 a second return → refused", refused(await change(A, wRet, "RETURNED", `"returnResult" = 'REPAIRED'`), /SERVICE_EXTERNAL_RETURNED/));
  for (const bad of ["RMA 123", "dana@shop.co.il", "דנה", "x".repeat(41)]) {
    ok(`6.10 supplierReference ${JSON.stringify(bad.slice(0, 12))} → refused (CHECK)`, refused(await send(A, (await inTx(runtime, A.biz, (tx) => externalCaseTx(tx, A, null))) as number, { ref: bad }), CHECK));
  }
  const cRef = (await inTx(runtime, A.biz, (tx) => externalCaseTx(tx, A, null))) as number;
  const wRef = (await send(A, cRef)) as number;
  ok("6.11 the RMA set once with a progress update → accepted; a second one → refused",
    succeeded(await change(A, wRef, "PROGRESS", `"progressStage" = 'RECEIVED_BY_SUPPLIER', "supplierReference" = 'RMA-77/1'`))
    && refused(await change(A, wRef, "PROGRESS", `"progressStage" = 'AWAITING_DIAGNOSIS', "supplierReference" = 'RMA-78'`), /SERVICE_EXTERNAL_PROGRESS/));
  // cancel at the supplier: the request lives on the case; the work stays AT_SUPPLIER until the documented return
  const cCan = (await inTx(runtime, A.biz, (tx) => externalCaseTx(tx, A, null))) as number;
  const wCan = (await send(A, cCan)) as number;
  await change(A, wCan, "COST_ESTIMATED", `"estimatedCostAgorot" = 20000`, { amount: 20000 });
  const req = await inTx(runtime, A.biz, (tx) => caseMoveTx(tx, A.biz, cCan, `"cancellationRequested" = true, "cancelReason" = 'הלקוח ביטל', "cancelledAt" = now()`, "CANCEL", "case.cancellation_requested", "EXTERNAL", "EXTERNAL", { crAfter: true }));
  ok("6.12 a cancel at the supplier: the case requests it, the work stays AT_SUPPLIER",
    succeeded(req) && rows(await q(runtime, A.biz, `SELECT state::text s FROM "ServiceExternalWork" WHERE id = $1`, wCan))[0]?.s === "AT_SUPPLIER");
  const done = await inTx(runtime, A.biz, async (tx) => {
    await caseMoveTx(tx, A.biz, cCan, `status = 'READY', outcome = 'CANCELLED', "cancellationRequested" = false`, "RETURN_FROM_EXTERNAL", "external.returned", "EXTERNAL", "READY", { outcome: "CANCELLED", crBefore: true });
    return changeTx(tx, A.biz, wCan, "RETURNED", `state = 'RETURNED', "returnedAt" = now(), "returnResult" = 'RETURNED_UNWORKED'`);
  });
  ok("6.13 the documented return completes it: READY / CANCELLED, the supplier cost kept",
    succeeded(done) && num(await q(runtime, A.biz, `SELECT "estimatedCostAgorot" AS n FROM "ServiceExternalWork" WHERE id = $1`, wCan)) === 20000, String(done));

  // ── 7. Journal append-only, no DELETE ─────────────────────────────────────────────────────────────────────
  console.log("7. journal append-only, no DELETE");
  ok("7.1 the runtime cannot UPDATE or DELETE the journal (no privilege)",
    refused(await x(runtime, A.biz, `UPDATE "ServiceExternalWorkEvent" SET payload = '{}' WHERE "workId" = $1`, work1), DENIED)
    && refused(await x(runtime, A.biz, `DELETE FROM "ServiceExternalWorkEvent" WHERE "workId" = $1`, work1), DENIED));
  ok("7.2 even the owner cannot rewrite, delete or truncate it",
    refused(await x(owner, null, `UPDATE "ServiceExternalWorkEvent" SET payload = '{}' WHERE "workId" = $1`, work1), /SERVICE_EXTERNAL_EVENT_APPEND_ONLY/)
    && refused(await x(owner, null, `DELETE FROM "ServiceExternalWorkEvent" WHERE "workId" = $1`, work1), /SERVICE_EXTERNAL_EVENT_APPEND_ONLY/)
    && refused(await x(owner, null, `TRUNCATE "ServiceExternalWorkEvent"`), /SERVICE_JOURNAL_NO_TRUNCATE|cannot truncate/));
  ok("7.3 the runtime cannot DELETE a work (no privilege)", refused(await x(runtime, A.biz, `DELETE FROM "ServiceExternalWork" WHERE id = $1`, work1), DENIED));
  const seqs = rows(await q(runtime, A.biz, `SELECT seq FROM "ServiceExternalWorkEvent" WHERE "workId" = $1 ORDER BY seq`, work1)).map((r) => Number(r.seq));
  ok("7.4 the journal of work 1 is seq 1..n without a gap and ends at the row's version",
    seqs.every((s, i) => s === i + 1) && seqs[seqs.length - 1] === num(await q(runtime, A.biz, `SELECT version AS n FROM "ServiceExternalWork" WHERE id = $1`, work1)), JSON.stringify(seqs));

  // ── 8. Atomicity ──────────────────────────────────────────────────────────────────────────────────────────
  console.log("8. atomicity");
  const counts = async () => JSON.stringify(rows(await q(owner, null, `SELECT (SELECT count(*) FROM "ServiceExternalWork" WHERE "businessId" = $1)::int w,
    (SELECT count(*) FROM "ServiceExternalWorkEvent" WHERE "businessId" = $1)::int e, (SELECT count(*) FROM "ServiceCase" WHERE "businessId" = $1)::int c`, A.biz))[0]);
  const before = await counts();
  const boom = await inTx(runtime, A.biz, async (tx) => { const c = await externalCaseTx(tx, A, null); await sendTx(tx, A, c); throw new Error("lab fault after the send"); });
  ok("8.1 a failed send (case + work + events) leaves nothing", refused(boom, /lab fault/) && (await counts()) === before);
  const vR = num(await q(runtime, A.biz, `SELECT version AS n FROM "ServiceExternalWork" WHERE id = $1`, wRef));
  const boom2 = await inTx(runtime, A.biz, async (tx) => {
    await caseMoveTx(tx, A.biz, cRef, `status = 'IN_REPAIR'`, "RETURN_FROM_EXTERNAL", "external.returned", "EXTERNAL", "IN_REPAIR");
    await changeTx(tx, A.biz, wRef, "RETURNED", `state = 'RETURNED', "returnedAt" = now(), "returnResult" = 'REPAIRED'`);
    throw new Error("lab fault after the return");
  });
  ok("8.2 a failed return leaves the case EXTERNAL and the work AT_SUPPLIER at its version",
    refused(boom2, /lab fault/) && rows(await q(runtime, A.biz, `SELECT c.status::text cs, w.state::text ws, w.version FROM "ServiceCase" c JOIN "ServiceExternalWork" w ON w."caseId" = c.id WHERE w.id = $1`, wRef))
      .every((r) => r.cs === "EXTERNAL" && r.ws === "AT_SUPPLIER" && Number(r.version) === vR));

  // ── 9. Account erasure ────────────────────────────────────────────────────────────────────────────────────
  console.log("9. account erasure");
  const cE = (await inTx(runtime, E.biz, (tx) => externalCaseTx(tx, E, null))) as number;
  const wE = (await send(E, cE, { ref: "RMA-555" })) as number;
  await change(E, wE, "COST_FINAL", `"finalCostAgorot" = 5000`, { amount: 5000 });
  await change(E, wE, "COST_FINAL_CORRECTED", `"finalCostAgorot" = 5500`, { amount: 5500, previous: 5000, reason: "סיבה אישית" });
  const ySnap = JSON.stringify(rows(await q(owner, null, `SELECT row_to_json(w) j FROM "ServiceExternalWork" w WHERE "businessId" = $1 ORDER BY id`, A.biz)));
  ok("9.1 not being deleted → the erasure refuses, nothing changed", refused(await q(runtime, E.biz, `SELECT public.service_external_erase_business() AS n`), /SERVICE_EXTERNAL_ERASURE_NOT_DELETING/));
  ok("9.2 without a tenant context → refuses", refused(await q(runtime, null, `SELECT public.service_external_erase_business() AS n`), /SERVICE_EXTERNAL_ERASURE_NO_CONTEXT/));
  ok("9.3 the erasure marker set by the runtime unlocks nothing (not the owner)",
    refused(await inTx(runtime, E.biz, async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('dubiz.service_erasure', 'on', true)`);
      return tx.$executeRawUnsafe(`UPDATE "ServiceExternalWork" SET "sendReason" = NULL, "erasedAt" = now() WHERE id = $1`, wE); }), /SERVICE_EXTERNAL_VERSION|check constraint/i));
  const tempAttack = await inTx(runtime, E.biz, async (tx) => {
    await tx.$executeRawUnsafe(`CREATE TEMP TABLE "Business" (id integer, "deletionRequestedAt" timestamp, "deletedAt" timestamp)`);
    await tx.$executeRawUnsafe(`INSERT INTO pg_temp."Business" VALUES (${E.biz}, now(), now())`);
    return tx.$queryRawUnsafe(`SELECT public.service_external_erase_business() AS n`);
  });
  ok("9.4 a temporary \"Business\" claiming the business is being deleted does not open it (pg_temp last)", refused(tempAttack, /NOT_DELETING|permission denied/), String(tempAttack));
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, E.biz);
  const erased = await q(runtime, E.biz, `SELECT public.service_external_erase_business() AS n`);
  ok("9.5 being deleted → the runtime erases its own business (1 work + 3 events)", succeeded(erased) && num(erased) === 4, String(erased));
  const ew = rows(await q(owner, null, `SELECT "sendReason" a, "requestedWork" b, "conditionAtSend" c, "operationalNote" d, "supplierReference" r, "sentByUserId" u, "erasedAt" IS NOT NULL e,
    "finalCostAgorot" f, "supplierId" s, "progressStage"::text ps FROM "ServiceExternalWork" WHERE id = $1`, wE))[0];
  ok("9.6 the work loses its six texts, the supplier reference and its user; supplier, amount and stage stay",
    !!ew && [ew.a, ew.b, ew.c, ew.d, ew.r, ew.u].every((v) => v === null) && ew.e === true && Number(ew.f) === 5500 && Number(ew.s) === E.supplier && ew.ps === "SENT", JSON.stringify(ew));
  ok("9.7 the journal keeps every event; users, digests and the correction reason are gone",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "workId" = $1`, wE)) === 3
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "workId" = $1 AND (reason IS NOT NULL OR "actorUserId" IS NOT NULL OR "erasedAt" IS NULL)`, wE)) === 0);
  ok("9.8 business A is untouched", JSON.stringify(rows(await q(owner, null, `SELECT row_to_json(w) j FROM "ServiceExternalWork" w WHERE "businessId" = $1 ORDER BY id`, A.biz))) === ySnap);
  ok("9.9 a second run changes nothing", num(await q(runtime, E.biz, `SELECT public.service_external_erase_business() AS n`)) === 0);
  ok("9.10 the foundation's erasure still runs for the same business (regression)", succeeded(await q(runtime, E.biz, `SELECT public.service_erase_business() AS n`)));

  // ── 10. 1.2a regression on the same database ──────────────────────────────────────────────────────────────
  console.log("10. 1.2a regression with 1.2b in place");
  const plain = await inTx(runtime, A.biz, async (tx) => {
    const n = 5000 + (++keySeq);
    const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt") VALUES ($1, $2, 'IN_SHOP', $3, 'x', now()) RETURNING id`, A.biz, n, A.cust)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, payload, "idempotencyKey") VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', '{}', $3)`, A.biz, id, ikey());
    return id;
  });
  ok("10.1 a case still opens with its case.opened (1.1c)", succeeded(plain));
  ok("10.2 a case without its opening is still refused", refused(await inTx(runtime, A.biz, (tx) => tx.$executeRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt") VALUES ($1, 7777, 'IN_SHOP', $2, 'x', now())`, A.biz, A.cust)), /SERVICE_CASE_NOT_OPENED/));
  ok("10.3 plain status changes of a case that never went out are unaffected",
    succeeded(await inTx(runtime, A.biz, (tx) => caseMoveTx(tx, A.biz, plain as number, `status = 'SCHEDULED'`, "SCHEDULE", "case.scheduled", "OPEN", "SCHEDULED"))));
  ok("10.4 a handover of a case that never went out is unaffected",
    succeeded(await inTx(runtime, A.biz, async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET status = 'READY', outcome = 'REPAIRED' WHERE id = $1`, plain);
      return tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot") VALUES ($1, $2, 'דנה', true, 0)`, A.biz, plain);
    })));
  ok("10.5 a case may still enter EXTERNAL before its work row (the order a send writes)",
    succeeded(await inTx(runtime, A.biz, async (tx) => { const c = await externalCaseTx(tx, A, null); return sendTx(tx, A, c); })));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  await owner.$disconnect(); await runtime.$disconnect();
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exit(1); }
}

main().catch(async (e) => { console.error(e); await owner.$disconnect(); await runtime.$disconnect(); process.exit(1); });
