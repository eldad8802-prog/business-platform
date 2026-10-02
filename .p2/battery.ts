/**
 * P2 (#601) — what migration 20261004090000_p2_business_identity does to a Production-shaped
 * database, measured with the real tenant runtime (lab: .p2/lab.sh <db> --with-p2).
 *
 *   1. tenant isolation on both new tables: the runtime reads/writes only the business named by
 *      app.current_business_id; no context → nothing; a row cannot be moved to another business;
 *   2. the runtime cannot DELETE or TRUNCATE (history is never erased by the app);
 *   3. no other role (app_auth, app_ctlplane, app_admin, PUBLIC) reaches the new tables;
 *   4. the CHECK constraints and the partial unique indexes hold (value shape, public-use only for
 *      claim text, one ACTIVE per single dimension / fact, adopted suggestions name their source);
 *   5. nothing that existed changes: the runtime's Business privileges are the same before/after,
 *      Business still has no RLS (P2 does not touch it), the FK cascades with the business.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network.
 */
import { PrismaClient } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

/** One runtime transaction with an optional tenant context; returns rows or the error message. */
async function rt(guc: number | null, sql: string): Promise<unknown[] | string> {
  return runtime.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return tx.$queryRawUnsafe(sql) as Promise<unknown[]>;
  }).catch((e: Error) => e.message);
}
const count = (r: unknown[] | string) => (typeof r === "string" ? -1 : Number((r[0] as { n: number }).n));
const denied = (r: unknown[] | string) => typeof r === "string" && /permission denied/i.test(r);
const rlsRefused = (r: unknown[] | string) => typeof r === "string" && /row-level security/i.test(r);
async function ownerErr(sql: string) { return owner.$executeRawUnsafe(sql).then(() => "ok", (e: Error) => e.message); }

const S = `"BusinessIdentityStatement"`;
const F = `"BusinessIdentityFactAuthority"`;
const insS = (biz: number, dim: string, val: string) =>
  `WITH i AS (INSERT INTO ${S} ("businessId","dimension",${/^'/.test(val) ? `"text"` : `"code"`},"source","updatedAt")
     VALUES (${biz}, '${dim}', ${/^'/.test(val) ? val : `'${val}'`}, 'OWNER_INPUT', now()) RETURNING id) SELECT count(*)::int n FROM i`;
const hash = "a".repeat(64);

async function businessPrivileges() {
  return owner.$queryRawUnsafe(`
    SELECT string_agg(a.attname || ':' || v, ',' ORDER BY a.attname, v) s
    FROM pg_attribute a CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE']) v
    WHERE a.attrelid = '"Business"'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND has_column_privilege('app_runtime', a.attrelid, a.attname, v)`) as Promise<Array<{ s: string }>>;
}

async function main() {
  const [{ p2 }] = (await owner.$queryRawUnsafe(
    `SELECT count(*)::int p2 FROM "_prisma_migrations" WHERE migration_name = '20261004090000_p2_business_identity' AND finished_at IS NOT NULL`
  )) as Array<{ p2: number }>;
  ok("P2 is applied in this lab (by prisma migrate deploy)", p2 === 1);

  const tag = `p2-${Date.now()}`;
  const A = await owner.business.create({ data: { name: `${tag}-A` } });
  const B = await owner.business.create({ data: { name: `${tag}-B` } });
  // B's statement, written by the owner (BYPASSRLS) — the runtime must never see it from A.
  await owner.$executeRawUnsafe(insS(B.id, "DESCRIPTION", "'B describes itself'"));

  console.log("\n-- 1. tenant isolation --");
  ok("GUC = A: the runtime inserts A's statement", count(await rt(A.id, insS(A.id, "DESCRIPTION", "'A describes itself'"))) === 1);
  ok("GUC = A: inserting a statement for B is refused (RLS WITH CHECK)", rlsRefused(await rt(A.id, insS(B.id, "SPECIALIZATION", "'x'"))));
  ok("no context: inserting anything is refused", rlsRefused(await rt(null, insS(A.id, "SPECIALIZATION", "'x'"))));
  ok("GUC = A: sees exactly its own statement, none of B's", count(await rt(A.id, `SELECT count(*)::int n FROM ${S}`)) === 1);
  ok("GUC = B: sees exactly B's statement", count(await rt(B.id, `SELECT count(*)::int n FROM ${S} WHERE "businessId" = ${B.id}`)) === 1);
  ok("no context: sees 0 statements", count(await rt(null, `SELECT count(*)::int n FROM ${S}`)) === 0);
  ok("GUC = A: changing B's statement touches 0 rows",
    count(await rt(A.id, `WITH u AS (UPDATE ${S} SET "text" = 'hijack', "updatedAt" = now() WHERE "businessId" = ${B.id} RETURNING 1) SELECT count(*)::int n FROM u`)) === 0);
  ok("GUC = A: moving A's statement to B is refused (WITH CHECK)",
    rlsRefused(await rt(A.id, `UPDATE ${S} SET "businessId" = ${B.id} WHERE "businessId" = ${A.id} RETURNING 1`)));
  ok("GUC = A: the runtime inserts and reads a fact authority for A",
    count(await rt(A.id, `WITH i AS (INSERT INTO ${F} ("businessId","fact","sourceField","valueHash","updatedAt") VALUES (${A.id}, 'CITY', 'BusinessProfile.city', '${hash}', now()) RETURNING 1) SELECT count(*)::int n FROM i`)) === 1);
  ok("GUC = B: A's fact authority is invisible", count(await rt(B.id, `SELECT count(*)::int n FROM ${F}`)) === 0);
  ok("GUC = A: a fact authority for B is refused",
    rlsRefused(await rt(A.id, `INSERT INTO ${F} ("businessId","fact","sourceField","valueHash","updatedAt") VALUES (${B.id}, 'CITY', 'BusinessProfile.city', '${hash}', now()) RETURNING 1`)));

  console.log("\n-- 2. no erasure by the runtime --");
  ok("runtime DELETE on statements: permission denied", denied(await rt(A.id, `DELETE FROM ${S} RETURNING 1`)));
  ok("runtime DELETE on fact authorities: permission denied", denied(await rt(A.id, `DELETE FROM ${F} RETURNING 1`)));
  ok("runtime TRUNCATE: permission denied", denied(await rt(A.id, `TRUNCATE ${S}`)));

  console.log("\n-- 3. nobody else reaches the new tables --");
  const [others] = (await owner.$queryRawUnsafe(`
    SELECT count(*)::int n FROM (VALUES ('app_auth'), ('app_ctlplane'), ('app_admin')) r(role)
    CROSS JOIN (VALUES ('"BusinessIdentityStatement"'), ('"BusinessIdentityFactAuthority"')) t(tbl)
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role) AND has_table_privilege(r.role, t.tbl, v)`)) as Array<{ n: number }>;
  ok("app_auth / app_ctlplane / app_admin hold no privilege on either table", others.n === 0, String(others.n));
  const [pub] = (await owner.$queryRawUnsafe(`
    SELECT count(*)::int n FROM pg_class c, aclexplode(c.relacl) x
    WHERE c.relname IN ('BusinessIdentityStatement','BusinessIdentityFactAuthority','BusinessIdentityStatement_id_seq','BusinessIdentityFactAuthority_id_seq') AND x.grantee = 0`)) as Array<{ n: number }>;
  ok("PUBLIC holds nothing on the tables or their sequences", pub.n === 0);

  console.log("\n-- 4. constraints --");
  ok("a coded dimension with free text is refused", /value_shape/.test(await ownerErr(insS(A.id, "TONE", "'warm'"))));
  ok("a text dimension with a code is refused", /value_shape/.test(await ownerErr(insS(A.id, "DESCRIPTION", "WARM"))));
  ok("public-use approval of an internal directive (TONE) is refused",
    /public_use/.test(await ownerErr(`INSERT INTO ${S} ("businessId","dimension","code","source","publicUseApproved","publicUseApprovedAt","updatedAt") VALUES (${A.id}, 'TONE', 'WARM', 'OWNER_INPUT', true, now(), now())`)));
  ok("an adopted suggestion without its source is refused",
    /provenance/.test(await ownerErr(`INSERT INTO ${S} ("businessId","dimension","text","source","updatedAt") VALUES (${A.id}, 'SPECIALIZATION', 'x', 'OWNER_ADOPTED_SUGGESTION', now())`)));
  const dup = await ownerErr(insS(A.id, "DESCRIPTION", "'again'"));
  ok("a second ACTIVE description for A is refused (partial unique, 23505)", /23505|duplicate key|Unique constraint/i.test(dup), dup);
  await owner.$executeRawUnsafe(`UPDATE ${S} SET "status" = 'RETIRED', "retiredAt" = now() WHERE "businessId" = ${A.id} AND "dimension" = 'DESCRIPTION'`);
  ok("after retiring it, a new ACTIVE description is accepted (history kept)", (await ownerErr(insS(A.id, "DESCRIPTION", "'again'"))) === "ok");
  ok("a fact authority bound to the wrong column is refused",
    /source_field/.test(await ownerErr(`INSERT INTO ${F} ("businessId","fact","sourceField","valueHash","updatedAt") VALUES (${A.id}, 'PUBLIC_PHONE', 'Business.name', '${hash}', now())`)));
  ok("a fact authority holding anything but a sha256 is refused",
    /value_hash/.test(await ownerErr(`INSERT INTO ${F} ("businessId","fact","sourceField","valueHash","updatedAt") VALUES (${A.id}, 'BUSINESS_NAME', 'Business.name', '050-1234567', now())`)));
  const dupFact = await ownerErr(`INSERT INTO ${F} ("businessId","fact","sourceField","valueHash","updatedAt") VALUES (${A.id}, 'CITY', 'BusinessProfile.city', '${hash}', now())`);
  ok("a second ACTIVE authority for the same fact is refused (partial unique, 23505)", /23505|duplicate key|Unique constraint/i.test(dupFact), dupFact);

  console.log("\n-- 5. nothing that existed changes --");
  const [biz] = (await owner.$queryRawUnsafe(`SELECT relrowsecurity r, (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) p FROM pg_class c WHERE relname = 'Business'`)) as Array<{ r: boolean; p: number }>;
  ok("Business itself is untouched by P2 (no RLS, no policy)", !biz.r && biz.p === 0);
  const [priv] = await businessPrivileges();
  ok("the runtime's Business column privileges are exactly D2 E4's (5 SELECT + 5 UPDATE, no INSERT)",
    priv.s === "archivedAt:UPDATE,archivedByUserId:UPDATE,createdAt:SELECT,deletedAt:SELECT,deletedAt:UPDATE,deletionRequestedAt:SELECT,deletionRequestedAt:UPDATE,id:SELECT,name:SELECT,updatedAt:UPDATE", priv.s);
  await owner.business.delete({ where: { id: B.id } });
  const [gone] = (await owner.$queryRawUnsafe(`SELECT count(*)::int n FROM ${S} WHERE "businessId" = ${B.id}`)) as Array<{ n: number }>;
  ok("deleting a business cascades to its statements (erasure follows the business)", gone.n === 0);

  console.log(`\nP2 battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
