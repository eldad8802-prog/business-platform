/**
 * userAgent column + grant delta — proof, on a real PostgreSQL.
 *
 *   OWNER_URL=postgresql://... npx tsx prisma/migrations/20260913120000_authsession_user_agent/grant-delta.test.ts
 *
 * The claim this migration makes is narrow and easy to get wrong in the
 * direction that matters: ONE new column, ONE new privilege, and nothing else
 * moves. So the privilege matrix is captured BEFORE the migration and again
 * after, and the difference is asserted to be exactly one entry. A battery that
 * only checked the new column would not notice the grant that came along with it.
 *
 * It also proves the negatives that make the column safe rather than merely
 * present: the label cannot be rewritten after the fact, the columns that were
 * withheld before are still withheld, and the tenant plane still holds nothing.
 *
 * Synthetic CI-only credentials. Zero secrets, zero Neon, zero network, zero
 * Production.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const OWNER_URL = process.env.OWNER_URL;
if (!OWNER_URL) {
  console.error("OWNER_URL is required (owner connection to the throwaway lab database).");
  process.exit(2);
}

const ROLE = "app_auth_ua_battery";
const PW = "ua_ci_synthetic_pw";
const AUTH_URL = OWNER_URL.replace(/\/\/[^@]*@/, `//${ROLE}:${PW}@`);
const MIG = (n: string) => join(ROOT, "prisma/migrations", n, "migration.sql");
const THIS_MIGRATION = join(HERE, "migration.sql");

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  - ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const strip = (s: string) => s.replace(/--.*$/gm, "");
/** Semicolons inside a dollar-quoted body are not statement separators. */
function statements(sql: string): string[] {
  const src = strip(sql);
  const out: string[] = [];
  let buf = "";
  let tag: string | null = null;
  for (let i = 0; i < src.length; i++) {
    if (tag) {
      buf += src[i];
      if (src.startsWith(tag, i)) { buf += src.slice(i + 1, i + tag.length); i += tag.length - 1; tag = null; }
      continue;
    }
    const open = src.slice(i).match(/^\$(\w*)\$/);
    if (open) { tag = open[0]; buf += tag; i += tag.length - 1; continue; }
    if (src[i] === ";") { if (buf.trim()) out.push(buf.trim()); buf = ""; continue; }
    buf += src[i];
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fresh = () => sha(randomBytes(32).toString("hex"));

/**
 * Prisma reports a raw-query failure as P2010 with the PostgreSQL code in
 * `meta.code`, not in the message. Reading only the message once made four
 * genuine refusals look like silent successes elsewhere in this programme.
 */
function pgCode(error: unknown): string | null {
  const meta = (error as { meta?: { code?: unknown } })?.meta;
  if (meta && typeof meta.code === "string") return meta.code;
  const text = String(error);
  const m = text.match(/code:\s*"(\w+)"/) ?? text.match(/Code:\s*`(\w+)`/) ?? text.match(/\b42501\b/);
  return m ? (m[1] ?? "42501") : null;
}

async function expectRefused(name: string, run: () => Promise<unknown>): Promise<void> {
  let threw = false;
  let code: string | null = null;
  try {
    await run();
  } catch (e) {
    threw = true;
    code = pgCode(e);
  }
  ok(
    `REFUSED: ${name}`,
    threw && code === "42501",
    threw ? `threw, but the code resolved to ${code}` : "it SUCCEEDED — the contract is not enforced"
  );
}

/** Every column privilege every identity holds on the table, as one sorted list. */
async function privilegeMatrix(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ entry: string }>>(`
    SELECT grantee || ':' || privilege_type || ':' || column_name AS entry
    FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'AuthSession'
    UNION ALL
    SELECT grantee || ':TABLE:' || privilege_type AS entry
    FROM information_schema.table_privileges
    WHERE table_schema = 'public' AND table_name = 'AuthSession'
    ORDER BY 1
  `);
  return rows.map((r) => r.entry);
}

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL, log: ["error"] });

  // ---- the table as Production has it, before this migration ---------------
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "AuthSessionSecret" CASCADE`);
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "AuthSession" CASCADE`);
  for (const s of statements(readFileSync(MIG("20260908120000_persistent_auth_sessions"), "utf8")))
    await owner.$executeRawUnsafe(s);

  for (const sql of [
    `DROP ROLE IF EXISTS ${ROLE}`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_auth') THEN CREATE ROLE app_auth NOLOGIN; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN; END IF; END $$`,
    `CREATE ROLE ${ROLE} LOGIN PASSWORD '${PW}' IN ROLE app_auth`,
    `GRANT USAGE ON SCHEMA public TO app_auth`,
    // The blanket grant Production's default ACL leaves on a freshly created
    // table, so the contract's revokes below are not passing vacuously.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."AuthSession", public."AuthSessionSecret" TO app_auth`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."AuthSession", public."AuthSessionSecret" TO app_runtime`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."User", public."Business" TO app_auth`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_auth`,
  ]) await owner.$executeRawUnsafe(sql);

  for (const f of [
    "20260908180000_d2_user_business_privilege_narrowing",
    "20260908200000_auth_session_privilege_contract",
  ]) for (const s of statements(readFileSync(MIG(f), "utf8"))) await owner.$executeRawUnsafe(s);
  ok("lab built from the shipped DDL and the shipped privilege contract", true);

  // ---- a row that predates the column, so survival is provable -------------
  const biz = await owner.business.create({ data: { name: "UA Lab" }, select: { id: true } });
  const user = await owner.user.create({
    data: { email: `ua-${Date.now()}@lab.invalid`, password: "x", name: "u", businessId: biz.id },
    select: { id: true, tokenVersion: true },
  });
  const now = new Date();
  const legacyHash = fresh();
  await owner.$executeRawUnsafe(
    `INSERT INTO "AuthSession" ("userId","secretHash","tokenVersionAtIssue","createdAt","lastUsedAt","idleExpiresAt","absoluteExpiresAt")
     VALUES ($1,$2,$3,$4,$4,$5,$6)`,
    user.id, legacyHash, user.tokenVersion, now,
    new Date(now.getTime() + 30 * 86_400_000), new Date(now.getTime() + 90 * 86_400_000)
  );
  const beforeCount = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "AuthSession"`);
  ok("a pre-migration row exists", Number(beforeCount[0]?.n) === 1);

  const before = await privilegeMatrix(owner);

  // ---- APPLY THE MIGRATION UNDER TEST -------------------------------------
  for (const s of statements(readFileSync(THIS_MIGRATION, "utf8"))) await owner.$executeRawUnsafe(s);
  ok("the migration applies cleanly", true);

  // Applying it twice must be a no-op, so a lab or a retry cannot break.
  for (const s of statements(readFileSync(THIS_MIGRATION, "utf8"))) await owner.$executeRawUnsafe(s);
  ok("applying it a second time is a no-op", true);

  const after = await privilegeMatrix(owner);

  // ---- the column ---------------------------------------------------------
  const col = await owner.$queryRawUnsafe<Array<{ data_type: string; character_maximum_length: number | null; is_nullable: string; column_default: string | null }>>(`
    SELECT data_type, character_maximum_length, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='AuthSession' AND column_name='userAgent'
  `);
  ok("the column exists", col.length === 1);
  ok("...as varchar(512)", col[0]?.data_type === "character varying" && col[0]?.character_maximum_length === 512);
  ok("...nullable", col[0]?.is_nullable === "YES");
  ok("...with no default", col[0]?.column_default === null);

  const idx = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM pg_indexes WHERE schemaname='public' AND tablename='AuthSession' AND indexdef ILIKE '%userAgent%'`
  );
  ok("...and no index on it", Number(idx[0]?.n) === 0);

  // ---- existing rows survived, untouched ----------------------------------
  const survived = await owner.$queryRawUnsafe<Array<{ n: bigint; nulls: bigint; sameHash: bigint }>>(
    `SELECT count(*)::bigint AS n,
            count(*) FILTER (WHERE "userAgent" IS NULL)::bigint AS nulls,
            count(*) FILTER (WHERE "secretHash" = $1)::bigint AS "sameHash"
     FROM "AuthSession"`,
    legacyHash
  );
  ok("the pre-migration row survived", Number(survived[0]?.n) === 1);
  ok("...with userAgent NULL and no backfill", Number(survived[0]?.nulls) === 1);
  ok("...and its other columns unchanged", Number(survived[0]?.sameHash) === 1);

  // ---- THE GRANT DELTA IS EXACTLY ONE ENTRY ------------------------------
  const added = after.filter((e) => !before.includes(e));
  const removed = before.filter((e) => !after.includes(e));
  console.log(`\n  privilege entries added  : ${added.join(", ") || "(none)"}`);
  console.log(`  privilege entries removed: ${removed.join(", ") || "(none)"}\n`);

  // Two kinds of entry appear for any new column without anyone granting
  // anything, and conflating them with a grant would make this check cry wolf:
  //
  //   * the TABLE OWNER receives every privilege on a column it created;
  //   * a role holding TABLE-level SELECT gains a per-column SELECT row in
  //     information_schema, because that view projects table grants down to
  //     columns. app_auth already held table-level SELECT before this migration,
  //     which is asserted below rather than assumed.
  //
  // What must be exactly one is the privilege granted to a non-owner role.
  const ownerRow = await owner.$queryRawUnsafe<Array<{ tableowner: string }>>(
    `SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='AuthSession'`
  );
  const tableOwner = ownerRow[0]?.tableowner ?? "";
  ok("the table owner was identified", tableOwner.length > 0);

  const addedForOthers = added.filter((e) => e.split(":")[0] !== tableOwner).sort();
  ok(
    "app_auth already held table-level SELECT before this migration",
    before.includes("app_auth:TABLE:SELECT")
  );
  ok(
    "the only privilege GRANTED to a non-owner role is INSERT on userAgent",
    addedForOthers.length === 2 &&
      addedForOthers[0] === "app_auth:INSERT:userAgent" &&
      addedForOthers[1] === "app_auth:SELECT:userAgent",
    addedForOthers.join(", ")
  );
  ok("no new UPDATE, DELETE or REFERENCES reached a non-owner role", !addedForOthers.some((e) => /:(UPDATE|DELETE|REFERENCES|TRUNCATE|TRIGGER):/.test(e)));
  ok("nothing was revoked", removed.length === 0, removed.join(", "));

  // ---- the auth plane, in practice ---------------------------------------
  const auth = new PrismaClient({ datasourceUrl: AUTH_URL, log: [] });
  const mk = (ua: string | null) => {
    const cols = ua === null
      ? `("userId","secretHash","tokenVersionAtIssue","createdAt","lastUsedAt","idleExpiresAt","absoluteExpiresAt")`
      : `("userId","secretHash","tokenVersionAtIssue","createdAt","lastUsedAt","idleExpiresAt","absoluteExpiresAt","userAgent")`;
    const vals = ua === null ? `($1,$2,$3,$4,$4,$5,$6)` : `($1,$2,$3,$4,$4,$5,$6,$7)`;
    const args: unknown[] = [
      user.id, fresh(), user.tokenVersion, now,
      new Date(now.getTime() + 30 * 86_400_000), new Date(now.getTime() + 90 * 86_400_000),
    ];
    if (ua !== null) args.push(ua);
    return auth.$executeRawUnsafe(`INSERT INTO "AuthSession" ${cols} VALUES ${vals}`, ...args);
  };

  {
    let threw: unknown = null;
    try { await mk("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36"); } catch (e) { threw = e; }
    ok("ALLOWED: INSERT WITH userAgent", threw === null, String(threw).slice(0, 160).replace(/\s+/g, " "));
  }
  {
    let threw: unknown = null;
    try { await mk(null); } catch (e) { threw = e; }
    ok("ALLOWED: INSERT WITHOUT userAgent", threw === null, String(threw).slice(0, 160).replace(/\s+/g, " "));
  }
  {
    let threw: unknown = null;
    try { await auth.$queryRawUnsafe(`SELECT "userAgent" FROM "AuthSession" LIMIT 1`); } catch (e) { threw = e; }
    ok("ALLOWED: reading it needs no new grant — table SELECT already covers it", threw === null);
  }

  // The label is written once at login. Immutability is the database's job here,
  // not a comment the code is trusted to honour.
  await expectRefused("UPDATE userAgent", () =>
    auth.$executeRawUnsafe(`UPDATE "AuthSession" SET "userAgent" = 'rewritten' WHERE true`)
  );

  // The columns that were withheld before are still withheld.
  await expectRefused("advancing absoluteExpiresAt (the 90-day ceiling)", () =>
    auth.$executeRawUnsafe(`UPDATE "AuthSession" SET "absoluteExpiresAt" = now() WHERE true`)
  );
  await expectRefused("repointing userId (session hijack)", () =>
    auth.$executeRawUnsafe(`UPDATE "AuthSession" SET "userId" = 1 WHERE true`)
  );
  await expectRefused("rewriting tokenVersionAtIssue", () =>
    auth.$executeRawUnsafe(`UPDATE "AuthSession" SET "tokenVersionAtIssue" = 0 WHERE true`)
  );

  await auth.$disconnect();

  // ---- the tenant plane still holds nothing ------------------------------
  const tenant = await owner.$queryRawUnsafe<Array<{ bad: bigint }>>(`
    SELECT count(*)::bigint AS bad FROM (VALUES ('app_runtime'),('${ROLE}')) v(r)
    WHERE v.r = 'app_runtime' AND (
        has_table_privilege(v.r,'public."AuthSession"','SELECT')
     OR has_table_privilege(v.r,'public."AuthSession"','INSERT')
     OR has_table_privilege(v.r,'public."AuthSession"','UPDATE')
     OR has_table_privilege(v.r,'public."AuthSession"','DELETE')
     OR has_any_column_privilege(v.r,'public."AuthSession"','SELECT')
     OR has_any_column_privilege(v.r,'public."AuthSession"','INSERT')
     OR has_any_column_privilege(v.r,'public."AuthSession"','UPDATE'))
  `);
  ok("the tenant plane holds nothing on the table, including the new column", Number(tenant[0]?.bad) === 0);

  const uaTenant = await owner.$queryRawUnsafe<Array<{ v: boolean }>>(
    `SELECT has_column_privilege('app_runtime','public."AuthSession"','userAgent','INSERT') AS v`
  );
  ok("...and specifically cannot write userAgent", uaTenant[0]?.v === false);

  await owner.$disconnect();
  console.log(`\n[authsession-user-agent-grant-delta] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("BATTERY ERROR:", e);
  process.exit(1);
});
