/**
 * Leads L1 · G-01b — migration 20261108090000_lead_claimed_phone, AS the real roles (.lcp/lab.sh):
 *
 *   1. The ledger: the migration is recorded and finished; nothing else is pending.
 *   2. Additive: leads that existed before (.lcp/pre.sql) keep every value; none gets a claimed phone.
 *   3. The CHECK accepts only normalized digits (8–20), for the runtime as for the owner.
 *   4. "Lead_open_phone_key" is unchanged: one OPEN lead per phone still holds; a claimed phone never takes part in
 *      it — several open enquiries may claim one phone, and a claim equal to an existing lead's phone collides with
 *      nothing (an anonymous enquiry can never block, attach to or be blocked by an existing lead).
 *   5. The new index exists and is NOT unique.
 *   6. Isolation is unchanged: in business A's context the runtime sees and finds by claimed phone only A's leads,
 *      cannot write a lead into B, and without a context sees nothing.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network. Raw SQL only (schema.prisma does not model the column).
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=8&pool_timeout=30`;
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
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
  }, { timeout: 30_000 }).catch((e: Error) => e.message);
}
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, key = "n") => Number(rows(r)[0]?.[key] ?? NaN);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const CHECK = /check constraint|23514/i;
const UNIQUE = /unique constraint|23505|Lead_open_phone_key/i;
const RLS = /row-level security|42501/i;
const insertLead = (businessId: number, name: string, phone: string | null, claimed: string | null, status = "NEW") =>
  `INSERT INTO "Lead" ("businessId", "customerName", phone, "claimedPhone", status, "updatedAt")
   VALUES (${businessId}, '${name}', ${phone ? `'${phone}'` : "NULL"}, ${claimed ? `'${claimed}'` : "NULL"}, '${status}'::"LeadStatus", now())`;

async function main() {
  const biz = rows(await q(owner, null, `SELECT id, name FROM "Business" WHERE name IN ('lcp-pre-A','lcp-pre-B') ORDER BY name`));
  const A = Number(biz.find((b) => b.name === "lcp-pre-A")?.id);
  const B = Number(biz.find((b) => b.name === "lcp-pre-B")?.id);

  console.log("1. ledger");
  ok("1.1 the migration is recorded and finished",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = '20261108090000_lead_claimed_phone' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)) === 1);
  ok("1.2 no migration is unfinished or rolled back",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`)) === 0);

  console.log("2. existing rows");
  const pre = rows(await q(owner, null, `SELECT "customerName" AS name, phone, email, status::text AS status, "claimedPhone" FROM "Lead" WHERE "businessId" IN (${A}, ${B}) ORDER BY id`));
  const asSet = (list: unknown[][]) => list.map((r) => JSON.stringify(r)).sort().join("\n");
  ok("2.1 the four leads that existed keep their name, phone, email and status",
    asSet(pre.map((r) => [r.name, r.phone, r.email, r.status])) === asSet([
      ["פתוח עם טלפון", "972500000001", null, "OPEN"], ["סגור", "972500000002", null, "WON"], ["בלי טלפון", null, "a@lab.test", "NEW"], ["עסק אחר", "972500000001", null, "NEW"]]),
    JSON.stringify(pre));
  ok("2.2 none of them got a claimed phone", pre.every((r) => r.claimedPhone === null));

  console.log("3. the digits-only CHECK");
  ok("3.1 the runtime may write a normalized claimed phone (A's context)",
    !refused(await x(runtime, A, insertLead(A, "טופס 1", null, "972541112222")), /./));
  for (const bad of ["abc", "050-111-2222", "1234567", "9".repeat(21), " 972541112222"]) {
    ok(`3.2 '${bad}' is refused (runtime)`, refused(await x(runtime, A, insertLead(A, "רע", null, bad)), CHECK));
  }
  ok("3.3 …and refused for the owner too", refused(await x(owner, null, insertLead(A, "רע", null, "not-digits")), CHECK));

  console.log("4. one open lead per phone — unchanged, and claimed phones never take part");
  ok("4.1 a second OPEN lead with the same PHONE is still refused (Lead_open_phone_key)",
    refused(await x(runtime, A, insertLead(A, "כפול", "972500000001", null, "OPEN")), UNIQUE));
  ok("4.2 several open enquiries may CLAIM one phone",
    !refused(await x(runtime, A, insertLead(A, "טופס 2", null, "972541112222")), /./)
      && num(await q(runtime, A, `SELECT count(*)::int AS n FROM "Lead" WHERE "claimedPhone" = '972541112222'`)) === 2);
  ok("4.3 a claim equal to an existing open lead's phone collides with nothing",
    !refused(await x(runtime, A, insertLead(A, "טופס 3", null, "972500000001")), /./));

  console.log("5. the index");
  const idx = rows(await q(owner, null, `SELECT i.indisunique AS u, pg_get_indexdef(i.indexrelid) AS d FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'Lead_businessId_claimedPhone_idx'`));
  ok("5.1 Lead_businessId_claimedPhone_idx exists on (businessId, claimedPhone) and is NOT unique",
    idx.length === 1 && idx[0].u === false && String(idx[0].d).includes(`("businessId", "claimedPhone")`), JSON.stringify(idx));

  console.log("6. isolation unchanged");
  ok("6.1 in A's context a claimed-phone lookup sees only A's leads",
    num(await q(runtime, A, `SELECT count(*)::int AS n FROM "Lead" WHERE "claimedPhone" IS NOT NULL AND "businessId" <> ${A}`)) === 0
      && num(await q(runtime, A, `SELECT count(*)::int AS n FROM "Lead" WHERE "claimedPhone" = '972500000001'`)) === 1);
  ok("6.2 in B's context A's claimed phones are invisible",
    num(await q(runtime, B, `SELECT count(*)::int AS n FROM "Lead" WHERE "claimedPhone" IS NOT NULL`)) === 0);
  ok("6.3 A's context cannot write a lead into B", refused(await x(runtime, A, insertLead(B, "חדירה", null, "972549998888")), RLS));
  ok("6.4 without a tenant context the runtime sees no lead at all",
    num(await q(runtime, null, `SELECT count(*)::int AS n FROM "Lead"`)) === 0);

  console.log(`\nlead claimedPhone migration battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
