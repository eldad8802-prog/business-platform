/**
 * Service Desk 1.2a — migration 20261112090000_service_desk_foundation, AS the real roles (.sdf/lab.sh --with-sdf):
 *
 *   1. Structure: ledger, seven tables under ENABLE + FORCE RLS, per-operation policies (no DELETE), explicit grants,
 *      every service function with search_path … pg_temp last, one SECURITY DEFINER, no flag row, no guard on any
 *      existing table.
 *   2. Isolation between businesses: reads, writes, cross-business references (customer, device, staff, billing
 *      document, user), no tenant context, the erasure door, a temporary "Business" (pg_temp).
 *   3. Case numbers: per business, gap-free under twelve concurrent creations and across a rolled-back creation.
 *   4. ServiceCase: the core's three fields + cancel request, reasons (1000 code points, trimmed, write-once).
 *   5. ServiceQuote: versions, one SENT, SUPERSEDED / WITHDRAWN final, approval = this row, billing document rules.
 *   6. ServiceCaseEvent: seq = case version, mirrors the case, idempotency, closed payload, append-only.
 *   7. ServiceHandover and ServiceCaseIntake: one handover, debt needs a reason, permanent; a signed intake is frozen.
 *   8. Erasure: only for a business being deleted, only personal fields, only through the function.
 *   9. Atomicity: a rolled-back transition leaves no case, no event, no number.
 *  10. Opening (1.1c): a case is created OPEN / version 1 with ONE case.opened at seq 1 in the same transaction
 *      (deferred constraint trigger), no other event at seq 1, no second opening, fail-closed across tenants.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network beyond the lab database. Raw SQL only.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=16&pool_timeout=60`;
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

async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }, { timeout: 60_000, maxWait: 60_000 }).catch((e: Error) => e.message);
}
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, key = "n") => Number(rows(r)[0]?.[key] ?? NaN);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const succeeded = (r: unknown) => typeof r !== "string";
const CHECK = /check constraint|23514/i;
const UNIQUE = /unique constraint|duplicate key|23505/i;
const FK = /foreign key|23503/i;
const RLS = /row-level security|new row violates row-level security/i;
const DENIED = /permission denied/i;
const EXCLUDE = /exclusion constraint|conflicting key value violates exclusion|23P01/i;
const H = (c: string) => c.repeat(64);

const MIG = "20261112090000_service_desk_foundation";
const TABLES = ["ServiceCaseNumberSequence", "ServiceDevice", "ServiceCase", "ServiceCaseIntake", "ServiceQuote", "ServiceCaseEvent", "ServiceHandover"];

// ── fixtures (owner) ─────────────────────────────────────────────────────────────────────────────────────────
async function business(name: string) {
  return num(await q(owner, null, `INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id AS n`, name));
}
async function user(biz: number, email: string) {
  return num(await q(owner, null, `INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id AS n`, email, biz));
}
async function customer(biz: number, name: string) {
  return num(await q(owner, null, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id AS n`, biz, name));
}
async function staff(biz: number, name: string) {
  return num(await q(owner, null, `INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, $2, now()) RETURNING id AS n`, biz, name));
}
async function billingDoc(biz: number, type: "QUOTE" | "TAX_INVOICE") {
  return num(await q(owner, null, `INSERT INTO "BillingDocument" ("businessId", "documentType", "updatedAt") VALUES ($1, $2::"BillingDocumentType", now()) RETURNING id AS n`, biz, type));
}
const pdfKey = (biz: number, s: string) => `biz/${biz}/service/quotes/${s}.pdf`;

// ── runtime helpers ──────────────────────────────────────────────────────────────────────────────────────────
const NEXT_NUMBER = `INSERT INTO "ServiceCaseNumberSequence" ("businessId", "nextValue") VALUES ($1, 2)
  ON CONFLICT ("businessId") DO UPDATE SET "nextValue" = "ServiceCaseNumberSequence"."nextValue" + 1, "updatedAt" = now()
  RETURNING "nextValue" - 1 AS n`;
/** The opening (1.1c) as task 1.3 will write it: the case first, then its one case.opened event (seq 1), same tx. */
async function openingTx(tx: Tx, biz: number, caseId: number, o: { seq?: number; type?: string; action?: string; from?: string | null; actor?: string; userId?: number | null } = {}) {
  return tx.$executeRawUnsafe(
    `INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", payload, "idempotencyKey")
     VALUES ($1, $2, $3, $4::"ServiceEventType", $5::"ServiceCaseAction", $6::"ServiceCaseStatus", 'OPEN', false, false, $7::"ServiceActor", $8, $9::jsonb, $10)`,
    biz, caseId, o.seq ?? 1, o.type ?? "case.opened", o.action ?? "OPEN", o.from === undefined ? null : o.from, o.actor ?? "OWNER_USER", o.userId ?? null,
    JSON.stringify({ kind: "IN_SHOP", caseId }), ikey());
}
async function createCaseTx(tx: Tx, biz: number, cust: number, extra: { deviceId?: number | null; staffId?: number | null; parent?: number | null; noOpening?: boolean } = {}) {
  const n = Number(((await tx.$queryRawUnsafe(NEXT_NUMBER, biz)) as Rows)[0].n);
  const r = (await tx.$queryRawUnsafe(
    `INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "deviceId", "staffMemberId", "parentCaseId", "problemDescription", "updatedAt")
     VALUES ($1, $2, 'IN_SHOP', $3, $4, $5, $6, 'המסך לא נדלק', now()) RETURNING id, "caseNumber"`,
    biz, n, cust, extra.deviceId ?? null, extra.staffId ?? null, extra.parent ?? null)) as Rows;
  const id = Number(r[0].id);
  if (!extra.noOpening) await openingTx(tx, biz, id);
  return { id, caseNumber: Number(r[0].caseNumber) };
}
const createCase = (biz: number, cust: number, extra = {}) => inTx(runtime, biz, (tx) => createCaseTx(tx, biz, cust, extra));
let keySeq = 0;
const ikey = () => `sdf-lab-key-${String(++keySeq).padStart(6, "0")}`;
/** A transition the way task 1.3 will write it: update the case (version + 1), then the event mirroring it. */
async function transitionTx(tx: Tx, biz: number, caseId: number, set: string, ev: {
  action: string; type: string; from: string; to: string; holdBefore?: string | null; holdAfter?: string | null;
  crBefore?: boolean; crAfter?: boolean; outcome?: string | null; payload?: object; key?: string; seqOverride?: number;
}) {
  const v = Number(((await tx.$queryRawUnsafe(
    `UPDATE "ServiceCase" SET ${set}, version = version + 1, "updatedAt" = now() WHERE id = $1 RETURNING version`, caseId)) as Rows)[0].version);
  await tx.$executeRawUnsafe(
    `INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "holdReasonBefore", "holdReasonAfter",
       "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, payload, "idempotencyKey")
     VALUES ($1, $2, $3, $4::"ServiceEventType", $5::"ServiceCaseAction", $6::"ServiceCaseStatus", $7::"ServiceCaseStatus",
       $8::"ServiceHoldReason", $9::"ServiceHoldReason", $10, $11, $12::"ServiceOutcome", 'SYSTEM', $13::jsonb, $14)`,
    biz, caseId, ev.seqOverride ?? v, ev.type, ev.action, ev.from, ev.to, ev.holdBefore ?? null, ev.holdAfter ?? null,
    ev.crBefore ?? false, ev.crAfter ?? false, ev.outcome ?? null, JSON.stringify(ev.payload ?? {}), ev.key ?? ikey());
  return v;
}
const transition = (biz: number, caseId: number, set: string, ev: Parameters<typeof transitionTx>[4]) =>
  inTx(runtime, biz, (tx) => transitionTx(tx, biz, caseId, set, ev));
async function insertQuote(biz: number, caseId: number, version: number, docId: number, extra: Partial<{ total: number; currency: string; hash: string; key: string; sha: string }> = {}) {
  return x(runtime, biz, `INSERT INTO "ServiceQuote" ("businessId", "caseId", version, "billingDocumentId", "totalAgorot", currency, "docHash", "sentPdfKey", "sentPdfSha256")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    biz, caseId, version, docId, extra.total ?? 45_000, extra.currency ?? "ILS", extra.hash ?? H(String(version % 10)),
    extra.key ?? pdfKey(biz, `c${caseId}-v${version}`), extra.sha ?? H("f"));
}

async function main() {
  // ── 1. Structure ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("1. structure");
  ok("1.1 the migration is recorded and finished; nothing is pending or rolled back",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, MIG)) === 1
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`)) === 0);
  ok("1.2 seven tables, each ENABLE + FORCE row-level security",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ANY($1) AND relrowsecurity AND relforcerowsecurity`, TABLES)) === 7);
  ok("1.3 policies per operation; none FOR DELETE or FOR ALL",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname = ANY($1)`, TABLES)) === 19
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname = ANY($1) AND p.polcmd IN ('d', '*')`, TABLES)) === 0);
  const grants = rows(await q(owner, null, `SELECT c.relname AS t, string_agg(x.privilege_type, ',' ORDER BY x.privilege_type) AS p
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x WHERE c.relname = ANY($1) AND pg_get_userbyid(x.grantee) = 'app_runtime' GROUP BY 1`, TABLES));
  const g = Object.fromEntries(grants.map((r) => [r.t, r.p]));
  ok("1.4 app_runtime: SELECT/INSERT/UPDATE on five tables; SELECT/INSERT only on the journal and the handover; no DELETE anywhere",
    ["ServiceCaseNumberSequence", "ServiceDevice", "ServiceCase", "ServiceCaseIntake", "ServiceQuote"].every((t) => g[t] === "INSERT,SELECT,UPDATE")
    && g.ServiceCaseEvent === "INSERT,SELECT" && g.ServiceHandover === "INSERT,SELECT", JSON.stringify(g));
  ok("1.5 no other role holds any privilege on the new tables or sequences",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE (c.relname = ANY($1) OR c.relname = ANY($2)) AND x.grantee <> c.relowner AND pg_get_userbyid(x.grantee) <> 'app_runtime'`,
      TABLES, TABLES.map((t) => `${t}_id_seq`))) === 0);
  const fns = rows(await q(owner, null, `SELECT proname, prosecdef AS secdef, proconfig::text AS cfg, has_function_privilege('public', oid, 'EXECUTE') AS pub,
      has_function_privilege('app_runtime', oid, 'EXECUTE') AS rt FROM pg_proc WHERE proname LIKE 'service\\_%' AND pronamespace = 'public'::regnamespace`));
  ok("1.6 every service function: search_path pg_catalog, public, pg_temp (pg_temp last); none executable by PUBLIC",
    fns.length === 12 && fns.every((f) => String(f.cfg).includes("search_path=pg_catalog, public, pg_temp") && f.pub === false), JSON.stringify(fns.map((f) => [f.proname, f.cfg, f.pub])));
  ok("1.7 exactly one SECURITY DEFINER (service_erase_business), executable by app_runtime",
    fns.filter((f) => f.secdef).length === 1 && fns.some((f) => f.proname === "service_erase_business" && f.secdef && f.rt));
  ok("1.8 no feature-flag row (the module is not switched on by this migration)",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "PlatformFeatureDefinition" WHERE key ILIKE '%service_desk%'`)) === 0);
  ok("1.9 no trigger, policy or column added to an existing table",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relname IN ('Business','User','Customer','StaffMember','BillingDocument') AND t.tgname ILIKE '%service%'`)) === 0
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('Business','User','Customer','StaffMember','BillingDocument') AND column_name ILIKE '%service%case%'`)) === 0);

  // ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────
  const A = await business("sdf-A"), B = await business("sdf-B"), E = await business("sdf-erase");
  const uA = await user(A, "sdf-a@lab.invalid"), uB = await user(B, "sdf-b@lab.invalid"), uE = await user(E, "sdf-e@lab.invalid");
  const cA1 = await customer(A, "לקוח א1"), cA2 = await customer(A, "לקוח א2"), cB = await customer(B, "לקוח ב"), cE = await customer(E, "לקוח מחיקה");
  const sA = await staff(A, "טכנאי א"), sB = await staff(B, "טכנאי ב");
  const qdA1 = await billingDoc(A, "QUOTE"), qdA2 = await billingDoc(A, "QUOTE"), invA = await billingDoc(A, "TAX_INVOICE"), qdB = await billingDoc(B, "QUOTE"), qdE = await billingDoc(E, "QUOTE");
  ok("0.0 synthetic fixtures created", [A, B, E, uA, uB, uE, cA1, cA2, cB, cE, sA, sB, qdA1, qdA2, invA, qdB, qdE].every((n) => Number.isInteger(n) && n > 0));
  const devA1 = num(await q(runtime, A, `INSERT INTO "ServiceDevice" ("businessId", "customerId", brand, model, "serialNumber", "serialNormalized", "updatedAt")
      VALUES ($1, $2, 'Samsung', 'A54', 'sn 123', 'SN123', now()) RETURNING id AS n`, A, cA1));
  const devA2 = num(await q(runtime, A, `INSERT INTO "ServiceDevice" ("businessId", "customerId", brand, "updatedAt") VALUES ($1, $2, 'Apple', now()) RETURNING id AS n`, A, cA2));
  ok("0.1 the runtime creates devices in its own business", devA1 > 0 && devA2 > 0);

  // ── 2. Isolation ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("2. isolation between businesses");
  const c1 = await createCase(A, cA1, { deviceId: devA1, staffId: sA });
  ok("2.1 the runtime opens a case in its business (number, device of the same customer, own staff)", succeeded(c1) && (c1 as { caseNumber: number }).caseNumber === 1, String(c1));
  const case1 = (c1 as { id: number }).id;
  ok("2.2 business B's context sees none of A's cases, devices, numbers",
    num(await q(runtime, B, `SELECT (SELECT count(*) FROM "ServiceCase") + (SELECT count(*) FROM "ServiceDevice") + (SELECT count(*) FROM "ServiceCaseNumberSequence") AS n`)) === 0);
  ok("2.3 no tenant context: the runtime sees nothing",
    num(await q(runtime, null, `SELECT (SELECT count(*) FROM "ServiceCase") + (SELECT count(*) FROM "ServiceDevice") AS n`)) === 0);
  ok("2.4 inserting a case for business B from A's context → refused by RLS",
    refused(await x(runtime, A, `INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt") VALUES ($1, 99, 'IN_SHOP', $2, 'x', now())`, B, cB), RLS));
  ok("2.5 updating A's case from B's context touches 0 rows",
    num(await q(runtime, B, `WITH u AS (UPDATE "ServiceCase" SET "diagnosisNote" = 'x' WHERE id = $1 RETURNING 1) SELECT count(*)::int AS n FROM u`, case1)) === 0);
  ok("2.6 a case of A naming B's customer → refused (composite FK)",
    refused(await x(runtime, A, `INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt") VALUES ($1, 900, 'IN_SHOP', $2, 'x', now())`, A, cB), FK));
  ok("2.7 a case naming a device of ANOTHER customer of the same business → refused (business, customer, device) FK",
    refused(await createCase(A, cA2, { deviceId: devA1 }), FK));
  ok("2.8 a case naming B's staff member → refused",
    refused(await createCase(A, cA1, { staffId: sB }), FK));
  ok("2.9 a device of A for B's customer → refused",
    refused(await x(runtime, A, `INSERT INTO "ServiceDevice" ("businessId", "customerId", "updatedAt") VALUES ($1, $2, now())`, A, cB), FK));
  ok("2.10 a quote of A on B's billing document → refused (the guard sees no such document)",
    refused(await insertQuote(A, case1, 1, qdB), /SERVICE_QUOTE_DOCUMENT_INVALID/));
  ok("2.11 a journal event of A naming B's user → refused",
    refused(await inTx(runtime, A, async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET version = version + 1 WHERE id = $1`, case1);
      const v = Number(((await tx.$queryRawUnsafe(`SELECT version FROM "ServiceCase" WHERE id = $1`, case1)) as Rows)[0].version);
      return tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", "idempotencyKey")
        VALUES ($1, $2, $3, 'case.scheduled', 'SCHEDULE', 'OPEN', 'OPEN', false, false, 'OWNER_USER', $4, $5)`, A, case1, v, uB, ikey());
    }), /SERVICE_USER_OTHER_BUSINESS/));
  ok("2.12 the erasure door refuses a business that is not being deleted (nothing changed)",
    refused(await q(runtime, A, `SELECT public.service_erase_business() AS n`), /SERVICE_ERASURE_NOT_DELETING/));
  ok("2.13 the erasure door refuses without a tenant context",
    refused(await q(runtime, null, `SELECT public.service_erase_business() AS n`), /SERVICE_ERASURE_NO_CONTEXT/));
  const tempAttack = await inTx(runtime, A, async (tx) => {
    await tx.$executeRawUnsafe(`CREATE TEMP TABLE "Business" (id integer, "deletionRequestedAt" timestamp, "deletedAt" timestamp)`);
    await tx.$executeRawUnsafe(`INSERT INTO pg_temp."Business" VALUES (${A}, now(), now())`);
    return tx.$queryRawUnsafe(`SELECT public.service_erase_business() AS n`);
  });
  ok("2.14 a temporary \"Business\" claiming A is being deleted does not open the door (pg_temp last)",
    refused(tempAttack, /SERVICE_ERASURE_NOT_DELETING|permission denied/), String(tempAttack));
  ok("2.15 setting the erasure marker as the runtime does not unlock a reason (not the owner)",
    refused(await inTx(runtime, A, async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('dubiz.service_erasure', 'on', true)`);
      await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET status = 'IN_REPAIR' WHERE id = $1`, case1);
      await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET status = 'READY', outcome = 'CANCELLED', "cancelReason" = 'א', "cancelledAt" = now() WHERE id = $1`, case1);
      return tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET "cancelReason" = NULL WHERE id = $1`, case1);
    }), /SERVICE_CASE_REASON_WRITE_ONCE/));

  // ── 3. Case numbers ──────────────────────────────────────────────────────────────────────────────────────
  console.log("3. case numbers");
  const parallel = await Promise.all(Array.from({ length: 12 }, () => createCase(A, cA1)));
  const nums = parallel.filter(succeeded).map((p) => (p as { caseNumber: number }).caseNumber).sort((a, b) => a - b);
  ok("3.1 twelve concurrent creations in one business: twelve distinct, consecutive numbers (2..13)",
    nums.length === 12 && nums.every((n, i) => n === i + 2), JSON.stringify(nums));
  const firstB = await createCase(B, cB);
  ok("3.2 another business starts at 1 (independent counter)", succeeded(firstB) && (firstB as { caseNumber: number }).caseNumber === 1);
  const rolled = await inTx(runtime, A, async (tx) => { await createCaseTx(tx, A, cA1); throw new Error("lab rollback"); });
  const after = await createCase(A, cA1);
  ok("3.3 a rolled-back creation leaves no case and returns its number (next = 14)",
    refused(rolled, /lab rollback/) && succeeded(after) && (after as { caseNumber: number }).caseNumber === 14
    && num(await q(runtime, A, `SELECT count(*)::int AS n FROM "ServiceCase"`)) === 14);
  ok("3.4 a duplicate number in one business → refused (unique)",
    refused(await x(runtime, A, `INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt") VALUES ($1, 1, 'IN_SHOP', $2, 'x', now())`, A, cA1), UNIQUE));

  // ── 4. ServiceCase rules ─────────────────────────────────────────────────────────────────────────────────
  console.log("4. ServiceCase");
  const fresh = async () => ((await createCase(A, cA1)) as { id: number }).id;
  const k1 = await fresh();
  const upd = (id: number, set: string) => x(runtime, A, `UPDATE "ServiceCase" SET ${set} WHERE id = $1`, id);
  ok("4.1 a hold outside IN_REPAIR → refused", refused(await upd(k1, `"holdReason" = 'PARTS'`), CHECK));
  ok("4.2 a hold in IN_REPAIR → accepted", succeeded(await upd(k1, `status = 'IN_REPAIR', "holdReason" = 'PARTS'`)));
  ok("4.3 an outcome outside the outcome statuses → refused", refused(await upd(k1, `outcome = 'REPAIRED', "holdReason" = NULL`), CHECK));
  ok("4.4 READY without an outcome → refused", refused(await upd(k1, `status = 'READY', "holdReason" = NULL`), CHECK));
  ok("4.5 CANCELLED with another outcome → refused", refused(await upd(k1, `status = 'CANCELLED', outcome = 'REPAIRED', "holdReason" = NULL, "cancelledAt" = now()`), CHECK));
  ok("4.6 a cancel request outside EXTERNAL → refused", refused(await upd(k1, `"cancellationRequested" = true, "holdReason" = NULL, "cancelReason" = 'x', "cancelledAt" = now()`), CHECK));
  const k2 = await fresh();
  ok("4.7 a cancel request without a reason → refused", refused(await upd(k2, `status = 'EXTERNAL', "cancellationRequested" = true, "cancelledAt" = now()`), CHECK));
  ok("4.8 at the supplier: request + reason + stamp → accepted", succeeded(await upd(k2, `status = 'EXTERNAL', "cancellationRequested" = true, "cancelReason" = 'הלקוח ביטל', "cancelledAt" = now()`)));
  ok("4.9 'cancelled' while still at the supplier (CANCELLED + request) → refused", refused(await upd(k2, `status = 'CANCELLED', outcome = 'CANCELLED'`), CHECK));
  ok("4.10 the return completes it: READY / CANCELLED, request cleared → accepted", succeeded(await upd(k2, `status = 'READY', outcome = 'CANCELLED', "cancellationRequested" = false`)));
  const k3 = await fresh();
  ok("4.11 READY / CANCELLED (held item) without a reason → refused", refused(await upd(k3, `status = 'READY', outcome = 'CANCELLED', "cancelledAt" = now()`), CHECK));
  ok("4.12 a direct CANCELLED (nothing held) without a reason → accepted", succeeded(await upd(k3, `status = 'CANCELLED', outcome = 'CANCELLED', "cancelledAt" = now()`)));
  const k4 = await fresh();
  ok("4.13 a reason of 1000 Hebrew characters → accepted", succeeded(await upd(k4, `status = 'READY', outcome = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = repeat('א', 1000)`)));
  const k5 = await fresh();
  ok("4.14 1001 characters → refused", refused(await upd(k5, `status = 'READY', outcome = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = repeat('א', 1001)`), CHECK));
  ok("4.15 1000 emoji (code points, not bytes) → accepted", succeeded(await upd(k5, `status = 'READY', outcome = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = repeat('🔧', 1000)`)));
  const k6 = await fresh();
  ok("4.16 an untrimmed reason → refused (the core stores it trimmed)", refused(await upd(k6, `status = 'READY', outcome = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = ' x '`), CHECK));
  ok("4.17 a blank reason → refused", refused(await upd(k6, `status = 'READY', outcome = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = '   '`), CHECK));
  ok("4.18 a recorded reason is write-once", refused(await upd(k4, `"cancelReason" = 'אחר'`), /SERVICE_CASE_REASON_WRITE_ONCE/));
  ok("4.19 a cancel stamp is write-once", refused(await upd(k4, `"cancelledAt" = now() + interval '1 day'`), /SERVICE_CASE_STAMP_WRITE_ONCE/));
  ok("4.20 the version never decreases", refused(await upd(k4, `version = 0`), /SERVICE_CASE_VERSION_BACKWARDS|check constraint/i));
  ok("4.21 identity fixed: customer, number, kind", refused(await upd(k4, `"customerId" = ${cA2}`), /SERVICE_CASE_IDENTITY_FIXED/)
    && refused(await upd(k4, `"caseNumber" = 777`), /SERVICE_CASE_IDENTITY_FIXED/) && refused(await upd(k4, `kind = 'FIELD'`), /SERVICE_CASE_IDENTITY_FIXED/));
  const k7 = await fresh();
  ok("4.22 ABANDONED needs its stamp and reason", refused(await upd(k7, `status = 'ABANDONED', outcome = 'REPAIRED'`), CHECK)
    && succeeded(await upd(k7, `status = 'ABANDONED', outcome = 'REPAIRED', "abandonedAt" = now(), "abandonReason" = 'לא נאסף'`)));
  ok("4.23 the runtime cannot DELETE a case (no privilege)", refused(await x(runtime, A, `DELETE FROM "ServiceCase" WHERE id = $1`, k7), DENIED));
  ok("4.24 the runtime cannot blank a description (erasure only)", refused(await upd(k7, `"problemDescription" = NULL`), /SERVICE_CASE_ERASURE_ONLY|check constraint/i));

  // ── 5. ServiceQuote ──────────────────────────────────────────────────────────────────────────────────────
  console.log("5. ServiceQuote");
  const qc = await fresh();
  ok("5.1 version 1 SENT on an own QUOTE document → accepted", succeeded(await insertQuote(A, qc, 1, qdA1)));
  ok("5.2 a second SENT version while one is open → refused (one SENT per case)", refused(await insertQuote(A, qc, 2, qdA1), UNIQUE));
  const revise = await inTx(runtime, A, async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "ServiceQuote" SET state = 'SUPERSEDED', "decidedAt" = now(), "decidedByActor" = 'OWNER_USER', "decidedByUserId" = $2 WHERE "caseId" = $1 AND version = 1 AND state = 'SENT'`, qc, uA);
    return tx.$executeRawUnsafe(`INSERT INTO "ServiceQuote" ("businessId", "caseId", version, "billingDocumentId", "totalAgorot", "docHash", "sentPdfKey", "sentPdfSha256")
      VALUES ($1, $2, 2, $3, 39000, $4, $5, $6)`, A, qc, qdA1, H("2"), pdfKey(A, `c${qc}-v2`), H("e"));
  });
  ok("5.3 REVISE in one transaction: v1 → SUPERSEDED, v2 SENT on the SAME document → accepted", succeeded(revise), String(revise));
  ok("5.4 a duplicate version number → refused", refused(await insertQuote(A, qc, 2, qdA1), UNIQUE));
  ok("5.5 approving the SUPERSEDED v1 → refused (final)", refused(await x(runtime, A, `UPDATE "ServiceQuote" SET state = 'APPROVED', "approvalMethod" = 'PHONE', "approvedVersion" = 1, "approvedTotalAgorot" = 45000, "approvedDocHash" = $2 WHERE "caseId" = $1 AND version = 1`, qc, H("1")), /SERVICE_QUOTE_FINAL/));
  ok("5.6 approving v2 with another total → refused (approval = this row)", refused(await x(runtime, A, `UPDATE "ServiceQuote" SET state = 'APPROVED', "decidedAt" = now(), "decidedByActor" = 'OWNER_USER', "approvalMethod" = 'PHONE', "approvedVersion" = 2, "approvedTotalAgorot" = 40000, "approvedDocHash" = $2 WHERE "caseId" = $1 AND version = 2`, qc, H("2")), CHECK));
  ok("5.7 approving v2 with another version / hash → refused", refused(await x(runtime, A, `UPDATE "ServiceQuote" SET state = 'APPROVED', "decidedAt" = now(), "decidedByActor" = 'OWNER_USER', "approvalMethod" = 'PHONE', "approvedVersion" = 1, "approvedTotalAgorot" = 39000, "approvedDocHash" = $2 WHERE "caseId" = $1 AND version = 2`, qc, H("1")), CHECK));
  ok("5.8 the owner recording a LINK approval → refused (LINK only from the customer link)", refused(await x(runtime, A, `UPDATE "ServiceQuote" SET state = 'APPROVED', "decidedAt" = now(), "decidedByActor" = 'OWNER_USER', "approvalMethod" = 'LINK', "approvedVersion" = 2, "approvedTotalAgorot" = 39000, "approvedDocHash" = $2 WHERE "caseId" = $1 AND version = 2`, qc, H("2")), CHECK));
  ok("5.9 changing the content of v2 → refused", refused(await x(runtime, A, `UPDATE "ServiceQuote" SET "totalAgorot" = 1 WHERE "caseId" = $1 AND version = 2`, qc), /SERVICE_QUOTE_CONTENT_FIXED/));
  // two concurrent approvals of v2: exactly one moves the row
  const approve = () => q(runtime, A, `WITH u AS (UPDATE "ServiceQuote" SET state = 'APPROVED', "decidedAt" = now(), "decidedByActor" = 'CUSTOMER_LINK', "approvalMethod" = 'LINK',
      "approvedVersion" = 2, "approvedTotalAgorot" = 39000, "approvedDocHash" = $2 WHERE "caseId" = $1 AND version = 2 AND state = 'SENT' RETURNING 1) SELECT count(*)::int AS n FROM u`, qc, H("2"));
  const [ap1, ap2] = await Promise.all([approve(), approve()]);
  ok("5.10 two concurrent approvals of v2: exactly one succeeds", [ap1, ap2].map((r) => (succeeded(r) ? num(r) : 0)).reduce((a, b) => a + b, 0) === 1, JSON.stringify([ap1, ap2]));
  ok("5.11 a second decision on the APPROVED v2 → refused", refused(await x(runtime, A, `UPDATE "ServiceQuote" SET state = 'REJECTED', "approvalMethod" = NULL, "approvedVersion" = NULL, "approvedTotalAgorot" = NULL, "approvedDocHash" = NULL WHERE "caseId" = $1 AND version = 2`, qc), /SERVICE_QUOTE_FINAL/));
  const wc = await fresh();
  await insertQuote(A, wc, 1, qdA2);
  ok("5.12 withdraw (cancel) → WITHDRAWN accepted", succeeded(await x(runtime, A, `UPDATE "ServiceQuote" SET state = 'WITHDRAWN', "decidedAt" = now(), "decidedByActor" = 'OWNER_USER' WHERE "caseId" = $1 AND version = 1`, wc)));
  ok("5.13 approving a WITHDRAWN quote → refused", refused(await x(runtime, A, `UPDATE "ServiceQuote" SET state = 'APPROVED', "approvalMethod" = 'PHONE', "approvedVersion" = 1, "approvedTotalAgorot" = 45000, "approvedDocHash" = $2 WHERE "caseId" = $1`, wc, H("1")), /SERVICE_QUOTE_FINAL/));
  ok("5.14 a non-QUOTE billing document → refused", refused(await insertQuote(A, await fresh(), 1, invA), /SERVICE_QUOTE_DOCUMENT_INVALID/));
  ok("5.15 the same billing document for ANOTHER case → refused (exclusion)", refused(await insertQuote(A, await fresh(), 1, qdA1), EXCLUDE));
  ok("5.16 currency other than ILS → refused", refused(await insertQuote(A, await fresh(), 1, await billingDoc(A, "QUOTE"), { currency: "USD" }), CHECK));
  ok("5.17 a malformed content hash → refused", refused(await insertQuote(A, await fresh(), 1, await billingDoc(A, "QUOTE"), { hash: "abc" }), CHECK));
  ok("5.18 a PDF key outside this business's service objects → refused", refused(await insertQuote(A, await fresh(), 1, await billingDoc(A, "QUOTE"), { key: `biz/${B}/service/x.pdf` }), CHECK));
  ok("5.19 a negative total → refused", refused(await insertQuote(A, await fresh(), 1, await billingDoc(A, "QUOTE"), { total: -1 }), CHECK));
  ok("5.20 deleting a linked billing document (even as the owner) → refused (FK)", refused(await x(owner, null, `DELETE FROM "BillingDocument" WHERE id = $1`, qdA1), FK));

  // ── 6. ServiceCaseEvent ──────────────────────────────────────────────────────────────────────────────────
  console.log("6. ServiceCaseEvent");
  const ec = await fresh();
  const t1 = await transition(A, ec, `status = 'SCHEDULED'`, { action: "SCHEDULE", type: "case.scheduled", from: "OPEN", to: "SCHEDULED", payload: { appointmentId: 11 } });
  const t2 = await transition(A, ec, `status = 'CHECKED_IN', "checkedInAt" = now()`, { action: "CHECK_IN", type: "case.checked_in", from: "SCHEDULED", to: "CHECKED_IN" });
  ok("6.1 two transitions: seq 2 and 3 = the case version after each", t1 === 2 && t2 === 3, JSON.stringify([t1, t2]));
  ok("6.2 an event whose seq is not the case version → refused", refused(await transition(A, ec, `status = 'DIAGNOSING'`, { action: "START_DIAGNOSIS", type: "case.diagnosis_started", from: "CHECKED_IN", to: "DIAGNOSING", seqOverride: 9 }), /SERVICE_EVENT_CASE_MISMATCH/));
  ok("6.3 an event whose after-state is not the case's → refused", refused(await transition(A, ec, `status = 'DIAGNOSING'`, { action: "START_DIAGNOSIS", type: "case.diagnosis_started", from: "CHECKED_IN", to: "IN_REPAIR" }), /SERVICE_EVENT_CASE_MISMATCH/));
  ok("6.4 a duplicate seq for the case → refused", refused(await inTx(runtime, A, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "idempotencyKey")
     VALUES ($1, $2, 3, 'case.checked_in', 'CHECK_IN', 'SCHEDULED', 'CHECKED_IN', false, false, 'SYSTEM', $3)`, A, ec, ikey())), UNIQUE));
  const dupKey = ikey();
  await transition(A, ec, `status = 'DIAGNOSING'`, { action: "START_DIAGNOSIS", type: "case.diagnosis_started", from: "CHECKED_IN", to: "DIAGNOSING", key: dupKey });
  ok("6.5 a duplicate idempotency key in the business → refused (and the case update rolls back with it)",
    refused(await transition(A, ec, `status = 'QUOTE_PENDING'`, { action: "SEND_QUOTE", type: "quote.sent", from: "DIAGNOSING", to: "QUOTE_PENDING", key: dupKey }), UNIQUE)
    && num(await q(runtime, A, `SELECT version AS n FROM "ServiceCase" WHERE id = $1`, ec)) === 4);
  ok("6.6 free text in the payload → refused (closed payload, ט-1 A)", refused(await transition(A, ec, `status = 'QUOTE_PENDING'`, { action: "SEND_QUOTE", type: "quote.sent", from: "DIAGNOSING", to: "QUOTE_PENDING", payload: { reason: "הלקוח ביטל" } }), CHECK));
  ok("6.7 a payload over 4096 bytes → refused", refused(await transition(A, ec, `status = 'QUOTE_PENDING'`, { action: "SEND_QUOTE", type: "quote.sent", from: "DIAGNOSING", to: "QUOTE_PENDING", payload: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "x".repeat(30)])) }), CHECK));
  await transition(A, ec, `status = 'QUOTE_PENDING'`, { action: "SEND_QUOTE", type: "quote.sent", from: "DIAGNOSING", to: "QUOTE_PENDING", payload: { quoteVersion: 1, totalAgorot: 45000 } });
  const rev = await transition(A, ec, `status = 'QUOTE_PENDING'`, { action: "REVISE_QUOTE", type: "quote.revised", from: "QUOTE_PENDING", to: "QUOTE_PENDING", payload: { supersededQuoteVersion: 1, quoteVersion: 2, totalAgorot: 39000 } });
  ok("6.8 quote.revised (in place) is accepted with its tokens", rev === 6, String(rev));
  ok("6.9 a cancel request event at EXTERNAL mirrors the case (request true)", succeeded(await inTx(runtime, A, async (tx) => {
    await transitionTx(tx, A, ec, `status = 'IN_REPAIR'`, { action: "APPROVE_QUOTE", type: "quote.approved", from: "QUOTE_PENDING", to: "IN_REPAIR" });
    await transitionTx(tx, A, ec, `status = 'EXTERNAL'`, { action: "SEND_TO_EXTERNAL", type: "external.sent", from: "IN_REPAIR", to: "EXTERNAL", payload: { supplierId: 8 } });
    return transitionTx(tx, A, ec, `"cancellationRequested" = true, "cancelReason" = 'בקשת לקוח', "cancelledAt" = now()`,
      { action: "CANCEL", type: "case.cancellation_requested", from: "EXTERNAL", to: "EXTERNAL", crAfter: true, payload: { reasonRecorded: true, itemAtSupplier: true } });
  })));
  ok("6.10 the runtime cannot UPDATE or DELETE the journal (no privilege)",
    refused(await x(runtime, A, `UPDATE "ServiceCaseEvent" SET payload = '{}' WHERE "caseId" = $1`, ec), DENIED)
    && refused(await x(runtime, A, `DELETE FROM "ServiceCaseEvent" WHERE "caseId" = $1`, ec), DENIED));
  ok("6.11 even the owner cannot rewrite, delete or truncate the journal",
    refused(await x(owner, null, `UPDATE "ServiceCaseEvent" SET payload = '{}' WHERE "caseId" = $1`, ec), /SERVICE_EVENT_APPEND_ONLY/)
    && refused(await x(owner, null, `DELETE FROM "ServiceCaseEvent" WHERE "caseId" = $1`, ec), /SERVICE_EVENT_APPEND_ONLY/)
    && refused(await x(owner, null, `TRUNCATE "ServiceCaseEvent"`), /SERVICE_JOURNAL_NO_TRUNCATE|cannot truncate a table referenced/));
  ok("6.12 the journal holds exactly the opening + the eight accepted events, seq 1..9 without a gap",
    JSON.stringify(rows(await q(runtime, A, `SELECT seq FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq`, ec)).map((r) => Number(r.seq))) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]));

  // ── 7. Handover and intake ───────────────────────────────────────────────────────────────────────────────
  console.log("7. ServiceHandover, ServiceCaseIntake");
  const hc = await fresh();
  const hand = (caseId: number, balance: number, debt: string | null, name = "ישראל ישראלי", signed = true) =>
    x(runtime, A, `INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot", "debtOverrideReason", "actorUserId")
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, A, caseId, name, signed, balance, debt, uA);
  ok("7.1 an open balance without the owner's reason → refused (ש4)", refused(await hand(hc, 5000, null), CHECK));
  ok("7.2 an open balance with a reason → accepted", succeeded(await hand(hc, 5000, "ישלם בהעברה")));
  ok("7.3 a second handover of the case → refused", refused(await hand(hc, 0, null), UNIQUE));
  ok("7.4 a blank receiver or no signature → refused", refused(await hand(await fresh(), 0, null, "  "), CHECK) && refused(await hand(await fresh(), 0, null, "דנה", false), CHECK));
  ok("7.5 the runtime cannot change a handover (no privilege); the owner neither (permanent)",
    refused(await x(runtime, A, `UPDATE "ServiceHandover" SET "openBalanceAgorot" = 0 WHERE "caseId" = $1`, hc), DENIED)
    && refused(await x(owner, null, `UPDATE "ServiceHandover" SET "openBalanceAgorot" = 0 WHERE "caseId" = $1`, hc), /SERVICE_HANDOVER_FIXED/));
  const ic = await fresh();
  await x(runtime, A, `INSERT INTO "ServiceCaseIntake" ("businessId", "caseId", "deviceSnapshot", "conditionNote", "conditionRecorded", "accessoriesRecorded", "updatedAt")
    VALUES ($1, $2, '{"brand":"Samsung","serial":"SN123"}', 'שריטה בפינה', true, true, now())`, A, ic);
  ok("7.6 an unsigned intake can still be edited", succeeded(await x(runtime, A, `UPDATE "ServiceCaseIntake" SET "accessoriesNote" = 'מטען' WHERE "caseId" = $1`, ic)));
  ok("7.7 signing it → accepted (signedAt ⇔ customerSigned)", succeeded(await x(runtime, A, `UPDATE "ServiceCaseIntake" SET "customerSigned" = true, "signedAt" = now(), "signatureKey" = $2 WHERE "caseId" = $1`, ic, `biz/${A}/service/sig/${ic}.png`)));
  ok("7.8 a signed intake: changing the condition → refused", refused(await x(runtime, A, `UPDATE "ServiceCaseIntake" SET "conditionNote" = 'אחר' WHERE "caseId" = $1`, ic), /SERVICE_INTAKE_SIGNED/));
  ok("7.9 a signed intake: the slip PDF key can be added once, then not changed",
    succeeded(await x(runtime, A, `UPDATE "ServiceCaseIntake" SET "slipPdfKey" = $2 WHERE "caseId" = $1`, ic, `biz/${A}/service/slip/${ic}.pdf`))
    && refused(await x(runtime, A, `UPDATE "ServiceCaseIntake" SET "slipPdfKey" = $2 WHERE "caseId" = $1`, ic, `biz/${A}/service/slip/${ic}-b.pdf`), /SERVICE_INTAKE_SIGNED/));

  // ── 8. Erasure ───────────────────────────────────────────────────────────────────────────────────────────
  console.log("8. account erasure");
  const eDev = num(await q(runtime, E, `INSERT INTO "ServiceDevice" ("businessId", "customerId", "serialNumber", "serialNormalized", description, "updatedAt") VALUES ($1, $2, 'S 1', 'S1', 'כחול', now()) RETURNING id AS n`, E, cE));
  const eCase = ((await createCase(E, cE, { deviceId: eDev })) as { id: number }).id;
  await x(runtime, E, `INSERT INTO "ServiceCaseIntake" ("businessId", "caseId", "deviceSnapshot", "conditionNote", "customerSigned", "signedAt", "signatureKey", "updatedAt")
    VALUES ($1, $2, '{"serial":"S1"}', 'סדוק', true, now(), $3, now())`, E, eCase, `biz/${E}/service/sig/1.png`);
  await inTx(runtime, E, async (tx) => {
    await transitionTx(tx, E, eCase, `status = 'CHECKED_IN'`, { action: "CHECK_IN", type: "case.checked_in", from: "OPEN", to: "CHECKED_IN" });
    return transitionTx(tx, E, eCase, `status = 'READY', outcome = 'CANCELLED', "cancelReason" = 'סיבה אישית', "cancelledAt" = now()`,
      { action: "CANCEL", type: "case.cancelled", from: "CHECKED_IN", to: "READY", outcome: "CANCELLED", payload: { reasonRecorded: true } });
  });
  await x(runtime, E, `INSERT INTO "ServiceQuote" ("businessId", "caseId", version, "billingDocumentId", "totalAgorot", "docHash", "sentPdfKey", "sentPdfSha256", "sentByUserId")
    VALUES ($1, $2, 1, $3, 100, $4, $5, $4, $6)`, E, eCase, qdE, H("a"), pdfKey(E, "e1"), uE);
  await x(runtime, E, `INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot", "debtOverrideReason", "actorUserId") VALUES ($1, $2, 'דנה כהן', true, 10, 'חוב', $3)`, E, eCase, uE);
  const journalBefore = num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "businessId" = $1`, E));
  ok("8.1 not deleting → the door refuses", refused(await q(runtime, E, `SELECT public.service_erase_business() AS n`), /SERVICE_ERASURE_NOT_DELETING/));
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, E);
  const erased = await q(runtime, E, `SELECT public.service_erase_business() AS n`);
  // case + device + intake + handover + quote (the two events carry no user and no digest)
  ok("8.2 being deleted → the runtime erases its own business through the door (5 rows)", succeeded(erased) && num(erased) === 5, String(erased));
  const ec2 = rows(await q(owner, null, `SELECT "problemDescription" AS p, "cancelReason" AS r, status::text AS s, outcome::text AS o, "erasedAt" IS NOT NULL AS e, version FROM "ServiceCase" WHERE id = $1`, eCase))[0];
  ok("8.3 the case keeps its facts (status, outcome, version) and loses its free text", !!ec2 && ec2.p === null && ec2.r === null && ec2.s === "READY" && ec2.o === "CANCELLED" && ec2.e === true && Number(ec2.version) === 3, JSON.stringify(ec2));
  const eh = rows(await q(owner, null, `SELECT "receivedByName" AS n, "debtOverrideReason" AS d, "openBalanceAgorot" AS b, "actorUserId" AS u FROM "ServiceHandover" WHERE "caseId" = $1`, eCase))[0];
  ok("8.4 the handover keeps the balance and loses the receiver, the reason and the actor", !!eh && eh.n === null && eh.d === null && Number(eh.b) === 10 && eh.u === null);
  const ei = rows(await q(owner, null, `SELECT "deviceSnapshot"::text AS s, "conditionNote" AS c, "signatureKey" AS k FROM "ServiceCaseIntake" WHERE "caseId" = $1`, eCase))[0];
  const edv = rows(await q(owner, null, `SELECT "serialNumber" AS s, description AS d FROM "ServiceDevice" WHERE id = $1`, eDev))[0];
  ok("8.5 intake and device: personal fields blanked", !!ei && ei.s === "{}" && ei.c === null && ei.k === null && !!edv && edv.s === null && edv.d === null);
  ok("8.6 the journal keeps every event (count unchanged); quote user ids nulled, content kept",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "businessId" = $1`, E)) === journalBefore
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceQuote" WHERE "businessId" = $1 AND "sentByUserId" IS NULL AND "totalAgorot" = 100`, E)) === 1);
  ok("8.7 business A is untouched by B's… E's erasure",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceCase" WHERE "businessId" = $1 AND "erasedAt" IS NOT NULL`, A)) === 0);
  const again = await q(runtime, E, `SELECT public.service_erase_business() AS n`);
  ok("8.8 a second run changes nothing (0 rows)", succeeded(again) && num(again) === 0, String(again));

  // ── 9. Atomicity ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("9. atomicity");
  const before = rows(await q(owner, null, `SELECT (SELECT count(*) FROM "ServiceCase" WHERE "businessId" = $1)::int AS c, (SELECT count(*) FROM "ServiceCaseEvent" WHERE "businessId" = $1)::int AS e, (SELECT "nextValue" FROM "ServiceCaseNumberSequence" WHERE "businessId" = $1) AS n`, A))[0];
  const boom = await inTx(runtime, A, async (tx) => {
    const c = await createCaseTx(tx, A, cA1);
    await transitionTx(tx, A, c.id, `status = 'SCHEDULED'`, { action: "SCHEDULE", type: "case.scheduled", from: "OPEN", to: "SCHEDULED" });
    throw new Error("lab fault after the event");
  });
  const afterB = rows(await q(owner, null, `SELECT (SELECT count(*) FROM "ServiceCase" WHERE "businessId" = $1)::int AS c, (SELECT count(*) FROM "ServiceCaseEvent" WHERE "businessId" = $1)::int AS e, (SELECT "nextValue" FROM "ServiceCaseNumberSequence" WHERE "businessId" = $1) AS n`, A))[0];
  ok("9.1 a rolled-back creation + transition leaves no case, no event, no consumed number",
    refused(boom, /lab fault/) && JSON.stringify(before) === JSON.stringify(afterB), JSON.stringify([before, afterB]));
  const partial = await inTx(runtime, A, async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET status = 'SCHEDULED', "holdReason" = NULL, version = version + 1 WHERE id = $1`, k1);
    return tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, payload, "idempotencyKey")
      VALUES ($1, $2, 99, 'case.scheduled', 'SCHEDULE', 'OPEN', 'SCHEDULED', false, false, 'SYSTEM', '{}', $3)`, A, k1, ikey());
  });
  ok("9.2 a case update whose event is refused rolls back with it (no state change without its event)",
    refused(partial, /SERVICE_EVENT_CASE_MISMATCH/) && rows(await q(runtime, A, `SELECT status::text AS s FROM "ServiceCase" WHERE id = $1`, k1))[0]?.s === "IN_REPAIR");

  // ── 10. The opening (1.1c): one case.opened at seq 1, written with the case ───────────────────────────────
  console.log("10. opening: case.opened at seq 1");
  const j1 = rows(await q(runtime, A, `SELECT seq, "eventType"::text AS t, action::text AS a, "fromStatus" IS NULL AS nofrom, "toStatus"::text AS s, actor::text AS who
      FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq`, case1));
  ok("10.1 a case and its opening in one transaction: the journal starts with case.opened / OPEN at seq 1, no from-status",
    j1.length === 1 && Number(j1[0].seq) === 1 && j1[0].t === "case.opened" && j1[0].a === "OPEN" && j1[0].nofrom === true && j1[0].s === "OPEN" && j1[0].who === "OWNER_USER", JSON.stringify(j1));
  ok("10.2 every case of every business has exactly one case.opened, at seq 1",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceCase" c WHERE (SELECT count(*) FROM "ServiceCaseEvent" e WHERE e."caseId" = c.id AND e."eventType" = 'case.opened') <> 1
      OR NOT EXISTS (SELECT 1 FROM "ServiceCaseEvent" e WHERE e."caseId" = c.id AND e.seq = 1 AND e."eventType" = 'case.opened')`)) === 0
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceCase"`)) > 30);
  const counts = async () => rows(await q(owner, null, `SELECT (SELECT count(*) FROM "ServiceCase" WHERE "businessId" = $1)::int AS c, (SELECT count(*) FROM "ServiceCaseEvent" WHERE "businessId" = $1)::int AS e, (SELECT "nextValue" FROM "ServiceCaseNumberSequence" WHERE "businessId" = $1) AS n`, A))[0];
  const c0 = await counts();
  const noOpening = await inTx(runtime, A, (tx) => createCaseTx(tx, A, cA1, { noOpening: true }));
  ok("10.3 a case without its opening event → refused at COMMIT (deferred), nothing left, no number consumed",
    refused(noOpening, /SERVICE_CASE_NOT_OPENED/) && JSON.stringify(await counts()) === JSON.stringify(c0), String(noOpening));
  const dupOpen = await fresh();
  ok("10.4 a second case.opened for a case → refused (seq 1 is taken)", refused(await inTx(runtime, A, (tx) => openingTx(tx, A, dupOpen)), UNIQUE));
  ok("10.5 case.opened at a seq other than 1 → refused (CHECK), even when the seq matches the case version",
    refused(await inTx(runtime, A, async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET version = 2 WHERE id = $1`, dupOpen);
      return openingTx(tx, A, dupOpen, { seq: 2 });
    }), CHECK));
  ok("10.6 another event at seq 1 → refused (CHECK): only the opening is seq 1",
    refused(await inTx(runtime, A, async (tx) => {
      const c = await createCaseTx(tx, A, cA1, { noOpening: true });
      return openingTx(tx, A, c.id, { type: "case.scheduled", action: "SCHEDULE", from: "OPEN" });
    }), CHECK));
  const badOpening = (o: Parameters<typeof openingTx>[3]) => inTx(runtime, A, async (tx) => {
    const c = await createCaseTx(tx, A, cA1, { noOpening: true });
    return openingTx(tx, A, c.id, o);
  });
  ok("10.7 an opening with a from-status, by SYSTEM, or with another action → refused (CHECK)",
    refused(await badOpening({ from: "OPEN" }), CHECK) && refused(await badOpening({ actor: "SYSTEM" }), CHECK) && refused(await badOpening({ action: "CHECK_IN" }), CHECK));
  ok("10.8 a transition naming action OPEN, or without a from-status → refused (CHECK)",
    refused(await transition(A, dupOpen, `status = 'SCHEDULED'`, { action: "OPEN", type: "case.scheduled", from: "OPEN", to: "SCHEDULED" }), CHECK)
    && refused(await inTx(runtime, A, async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET status = 'SCHEDULED', version = version + 1 WHERE id = $1`, dupOpen);
      return tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "idempotencyKey")
        VALUES ($1, $2, 2, 'case.scheduled', 'SCHEDULE', NULL, 'SCHEDULED', false, false, 'SYSTEM', $3)`, A, dupOpen, ikey());
    }), CHECK));
  const notInitial = (set: string) => x(runtime, A, `INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt", ${set.split("=")[0]}) VALUES ($1, 950, 'IN_SHOP', $2, 'x', now(), ${set.split("=")[1]})`, A, cA1);
  ok("10.9 a case created in any other state (status, version, outcome, cancel request) → refused (SERVICE_CASE_NOT_INITIAL)",
    refused(await notInitial(`status='DIAGNOSING'`), /SERVICE_CASE_NOT_INITIAL/) && refused(await notInitial(`version=2`), /SERVICE_CASE_NOT_INITIAL/)
    && refused(await notInitial(`outcome='REPAIRED'`), /SERVICE_CASE_NOT_INITIAL/) && refused(await notInitial(`"cancellationRequested"=true`), /SERVICE_CASE_NOT_INITIAL/));
  const c1b = await counts();
  const partialOpen = await inTx(runtime, A, async (tx) => {
    await createCaseTx(tx, A, cA1);
    throw new Error("lab fault after the opening");
  });
  ok("10.10 a rolled-back creation (case + opening) leaves no case, no event, no number",
    refused(partialOpen, /lab fault after the opening/) && JSON.stringify(await counts()) === JSON.stringify(c1b));
  ok("10.11 forcing the check IMMEDIATE refuses the case before its event: the deferral only allows the legal order",
    refused(await inTx(runtime, A, async (tx) => {
      await tx.$executeRawUnsafe(`SET CONSTRAINTS "ServiceCase_has_opening_event" IMMEDIATE`);
      return createCaseTx(tx, A, cA1);
    }), /SERVICE_CASE_NOT_OPENED/));
  ok("10.12 the runtime cannot disable the opening check (not the owner)",
    refused(await x(runtime, A, `ALTER TABLE "ServiceCase" DISABLE TRIGGER "ServiceCase_has_opening_event"`), /must be owner|permission denied/));
  const bCase = ((await createCase(B, cB)) as { id: number }).id;
  ok("10.13 isolation: an opening naming B's case from A's context → refused; B's context sees none of A's openings",
    refused(await inTx(runtime, A, (tx) => openingTx(tx, A, bCase)), /SERVICE_EVENT_CASE_INVALID|foreign key/)
    && refused(await inTx(runtime, A, (tx) => openingTx(tx, B, bCase)), /row-level security|SERVICE_EVENT_CASE_INVALID/)
    && num(await q(runtime, B, `SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, case1)) === 0
    && num(await q(runtime, B, `SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "eventType" = 'case.opened'`)) === num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceCase" WHERE "businessId" = $1`, B)));
  const switched = await inTx(runtime, A, async (tx) => {
    await createCaseTx(tx, A, cA1);
    return tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${B}', true)`);
  });
  ok("10.14 fails closed: the tenant context switched before COMMIT hides the opening → refused, nothing left",
    refused(switched, /SERVICE_CASE_NOT_OPENED/) && JSON.stringify(await counts()) === JSON.stringify(c1b), String(switched));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  await owner.$disconnect();
  await runtime.$disconnect();
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exit(1); }
}

main().catch(async (e) => {
  console.error(e);
  await owner.$disconnect();
  await runtime.$disconnect();
  process.exit(1);
});
