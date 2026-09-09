/**
 * AUTH SESSION — ORM behaviour under the shipped privilege contract (PG17).
 *
 *   OWNER_URL=postgresql://... npx tsx .authfix/auth-session-orm-battery.ts
 *
 * WHY THIS EXISTS
 *
 * On 2026-09-08 Production login returned 500 on a correct password for six
 * hours. Every column the write SET was granted. The statement that was refused
 * is the one nobody wrote: Prisma appends `RETURNING <every scalar column>` to a
 * write that carries no `select`, and RETURNING needs SELECT on what it returns.
 *
 * A privilege battery cannot catch that. `.tx3a1/exact-grant-battery.mjs` proves
 * what a ROLE may do, and every statement it issues is one a human chose to
 * write — which is exactly why it passed straight through the outage. The gap is
 * in the statement the ORM adds. So this drives the real Prisma client against
 * the real grants and reports the SQL verbatim.
 *
 * WHAT IT LOCKS
 *
 * The nine operations the refresh design needs, each proven allowed or proven
 * refused, plus the measured INSERT and RETURNING shapes. The refusals are the
 * half that matters: the 90-day ceiling, session ownership, an unforgeable
 * grace deadline and "never born revoked" are all DB-enforced, and a battery
 * that only proved the happy path would not notice if they stopped being.
 *
 * Synthetic CI-only credentials. Zero secrets, zero Neon, zero network, zero
 * Production.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OWNER_URL = process.env.OWNER_URL;
if (!OWNER_URL) {
  console.error("OWNER_URL is required (owner connection to the throwaway lab database).");
  process.exit(2);
}

const ROLE = "app_auth_session_battery";
const PW = "auth_session_ci_synthetic_pw";
const AUTH_URL = OWNER_URL.replace(/\/\/[^@]*@/, `//${ROLE}:${PW}@`);

const MIG = (name: string) => join(ROOT, "prisma/migrations", name, "migration.sql");
const TABLES = MIG("20260908120000_persistent_auth_sessions");
const E4 = MIG("20260908180000_d2_user_business_privilege_narrowing");
const CONTRACT = MIG("20260908200000_auth_session_privilege_contract");

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

const strip = (sql: string) => sql.replace(/--.*$/gm, "");

/**
 * Split on semicolons, but not the ones inside a dollar-quoted body: the
 * privilege contract wraps its statements in `DO $do$ ... $do$`, and a naive
 * split tears a guard in half and fails with a syntax error that looks nothing
 * like the real cause.
 */
function statements(sql: string): string[] {
  const src = strip(sql);
  const out: string[] = [];
  let buf = "";
  let tag: string | null = null;
  for (let i = 0; i < src.length; i++) {
    if (tag) {
      buf += src[i];
      if (src.startsWith(tag, i)) {
        buf += src.slice(i + 1, i + tag.length);
        i += tag.length - 1;
        tag = null;
      }
      continue;
    }
    const open = src.slice(i).match(/^\$(\w*)\$/);
    if (open) {
      tag = open[0];
      buf += tag;
      i += tag.length - 1;
      continue;
    }
    if (src[i] === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += src[i];
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * The PostgreSQL code behind whatever Prisma wrapped around it.
 *
 * Prisma reports a raw-query failure as P2010 with the code in `meta.code`, NOT
 * in the message. An extractor that read only the message text once made four
 * genuine refusals look like silent successes, which is the single most
 * dangerous way for a negative control to fail. Hence `expectRefused` below
 * asserts that something was thrown AND that the code resolves — never one
 * without the other.
 */
function pgCode(error: unknown): string | null {
  const meta = (error as { meta?: { code?: unknown } })?.meta;
  if (meta && typeof meta.code === "string") return meta.code;
  const text = String(error);
  const m =
    text.match(/code:\s*"(\w+)"/) ??
    text.match(/Code:\s*`(\w+)`/) ??
    text.match(/\b(42501)\b/);
  return m ? m[1] : null;
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
    threw ? `threw, but the code resolved to ${code}` : "it SUCCEEDED — the contract is not being enforced"
  );
}

async function expectAllowed(name: string, run: () => Promise<unknown>): Promise<void> {
  let threw: unknown = null;
  try {
    await run();
  } catch (e) {
    threw = e;
  }
  ok(`ALLOWED: ${name}`, threw === null, String(threw).slice(0, 200).replace(/\s+/g, " "));
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const freshHash = () => sha256(randomBytes(32).toString("hex"));

const insertColumns = (sql: string): string[] =>
  [...(sql.match(/INSERT INTO[^(]*\(([^)]*)\)/i)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);

const returningColumns = (sql: string): string[] => {
  const tail = sql.split(/\bRETURNING\b/i)[1];
  if (!tail) return [];
  return [...tail.matchAll(/"(\w+)"/g)]
    .map((m) => m[1])
    .filter((c) => c !== "public" && c !== "AuthSession" && c !== "AuthSessionSecret");
};

const setColumns = (sql: string): string[] => {
  const mid = sql.split(/\bSET\b/i)[1]?.split(/\bWHERE\b/i)[0] ?? "";
  return [...mid.matchAll(/"(\w+)"\s*=/g)].map((m) => m[1]);
};

/** The grant lists the SHIPPED contract gives app_auth, parsed not retyped. */
function grantedColumns(kind: "INSERT" | "UPDATE", model: string): Set<string> {
  const re = new RegExp(
    `GRANT\\s+${kind}\\s*\\(([^)]*)\\)[\\s\\S]{0,120}?ON\\s+public\\."${model}"\\s+TO\\s+app_auth`,
    "i"
  );
  const m = strip(readFileSync(CONTRACT, "utf8")).match(re);
  return new Set([...(m?.[1] ?? "").matchAll(/"(\w+)"/g)].map((x) => x[1]));
}

const captured: string[] = [];
const lastMatching = (re: RegExp, table: string) =>
  [...captured].reverse().find((q) => re.test(q.trim()) && q.includes(`"${table}"`)) ?? "";

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL, log: ["error"] });

  // ------------------------------------------------------------------ lab ---
  // The tables come from the SHIPPED DDL, not from `db push`, so the defaults,
  // types and CHECK constraints are the ones Production actually has.
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "AuthSessionSecret" CASCADE`);
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "AuthSession" CASCADE`);
  for (const s of statements(readFileSync(TABLES, "utf8"))) await owner.$executeRawUnsafe(s);

  for (const sql of [
    `DROP ROLE IF EXISTS ${ROLE}`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_auth') THEN CREATE ROLE app_auth NOLOGIN; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN; END IF; END $$`,
    `CREATE ROLE ${ROLE} LOGIN PASSWORD '${PW}' IN ROLE app_auth`,
    `GRANT USAGE ON SCHEMA public TO app_auth`,
    // Pre-state: the blanket table grant Production's default ACL leaves behind,
    // so the contract's revokes are not passing vacuously.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."AuthSession", public."AuthSessionSecret" TO app_auth`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."AuthSession", public."AuthSessionSecret" TO app_runtime`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."User", public."Business" TO app_auth`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_auth`,
  ]) {
    await owner.$executeRawUnsafe(sql);
  }
  for (const file of [E4, CONTRACT]) {
    for (const s of statements(readFileSync(file, "utf8"))) await owner.$executeRawUnsafe(s);
  }
  ok("shipped table DDL + E4 + privilege contract applied to the lab", true);

  // The extractor is proven before anything depends on it. A negative control
  // that passes because its error reader is broken is worse than no control.
  {
    ok(
      "pgCode reads a Prisma P2010 meta.code",
      pgCode({ code: "P2010", meta: { code: "42501" } }) === "42501"
    );
    ok("pgCode returns null when there is no code", pgCode(new Error("boom")) === null);
  }

  // -------------------------------------------------------------- fixture ---
  const business = await owner.business.create({ data: { name: "Auth Session Lab" }, select: { id: true } });
  const user = await owner.user.create({
    data: {
      email: `auth-session-${Date.now()}@lab.invalid`,
      password: "x",
      name: "Battery",
      businessId: business.id,
    },
    select: { id: true, tokenVersion: true },
  });

  const auth = new PrismaClient({ datasourceUrl: AUTH_URL, log: [{ emit: "event", level: "query" }] });
  // @ts-expect-error the event overload is not in the generated union
  auth.$on("query", (e: { query: string }) => captured.push(e.query));

  const now = new Date();
  const plus = (ms: number) => new Date(now.getTime() + ms);
  const firstSecret = freshHash();

  // --------------------------------------------------------- 1. issuance ---
  let sessionId = "";
  await expectAllowed("AuthSession.create with an explicit minimal select", async () => {
    const row = await auth.authSession.create({
      data: {
        userId: user.id,
        secretHash: firstSecret,
        tokenVersionAtIssue: user.tokenVersion,
        createdAt: now,
        lastUsedAt: now,
        idleExpiresAt: plus(30 * 86_400_000),
        absoluteExpiresAt: plus(90 * 86_400_000),
      },
      select: { id: true },
    });
    sessionId = row.id;
  });

  {
    const sql = lastMatching(/^INSERT/i, "AuthSession");
    const cols = insertColumns(sql);
    const allowed = grantedColumns("INSERT", "AuthSession");
    console.log(`\n  [measured] AuthSession INSERT names: ${cols.join(", ")}`);
    console.log(`  [measured] RETURNING with select   : ${returningColumns(sql).join(", ")}\n`);
    ok("every INSERT column is inside the granted set", cols.every((c) => allowed.has(c)), cols.join(","));
    ok(
      "a session cannot be born revoked — Prisma never names those columns",
      !cols.includes("revokedAt") && !cols.includes("revokedReason")
    );
    ok("an explicit select narrows RETURNING to it", returningColumns(sql).join(",") === "id");
  }

  // ------------------------------- 2. the implicit RETURNING, as measured ---
  //
  // Documented rather than relied upon. It is permitted here ONLY because this
  // table keeps table-level SELECT; the User outage happened because that table
  // does not. Every write in this plane still names its columns.
  await expectAllowed("AuthSession.create with NO select (documented, not endorsed)", () =>
    auth.authSession.create({
      data: {
        userId: user.id,
        secretHash: freshHash(),
        tokenVersionAtIssue: user.tokenVersion,
        createdAt: now,
        lastUsedAt: now,
        idleExpiresAt: plus(30 * 86_400_000),
        absoluteExpiresAt: plus(90 * 86_400_000),
      },
    })
  );
  {
    const ret = returningColumns(lastMatching(/^INSERT/i, "AuthSession"));
    console.log(`\n  [measured] RETURNING with NO select: ${ret.length} columns — ${ret.join(", ")}\n`);
    ok("with no select, RETURNING names every scalar column", ret.length === 10, `${ret.length}`);
  }

  // ---------------------------------------------------------- 3. rotation ---
  await expectAllowed("AuthSessionSecret.create (a rotated secret is recorded)", () =>
    auth.authSessionSecret.create({
      data: { sessionId, secretHash: firstSecret, rotatedAt: now, graceUntil: plus(120_000) },
      select: { id: true },
    })
  );
  {
    const sql = lastMatching(/^INSERT/i, "AuthSessionSecret");
    const cols = insertColumns(sql);
    const allowed = grantedColumns("INSERT", "AuthSessionSecret");
    console.log(`\n  [measured] AuthSessionSecret INSERT names: ${cols.join(", ")}\n`);
    ok("every INSERT column is inside the granted set", cols.every((c) => allowed.has(c)), cols.join(","));
  }

  await expectAllowed("AuthSession rotation update", () =>
    auth.authSession.update({
      where: { id: sessionId },
      data: { secretHash: freshHash(), lastUsedAt: now, idleExpiresAt: plus(30 * 86_400_000) },
      select: { id: true },
    })
  );
  {
    const cols = setColumns(lastMatching(/^UPDATE/i, "AuthSession"));
    const allowed = grantedColumns("UPDATE", "AuthSession");
    console.log(`\n  [measured] rotation SET names: ${cols.join(", ")}\n`);
    ok("every SET column is granted UPDATE", cols.every((c) => allowed.has(c)), cols.join(","));
    ok("no updatedAt is smuggled in — these models have no such column", !cols.includes("updatedAt"));
  }

  // ---------------------------------------------------------- 4. revocation -
  await expectAllowed("AuthSession revoke update", () =>
    auth.authSession.update({
      where: { id: sessionId },
      data: { revokedAt: now, revokedReason: "refresh_chain_divergence" },
      select: { id: true },
    })
  );

  // --------------------------------------------------- 5. reads and sweeps --
  await expectAllowed("select and delete on both tables", async () => {
    await auth.authSession.findFirst({ where: { userId: user.id }, select: { id: true } });
    await auth.authSessionSecret.findMany({ where: { sessionId }, select: { id: true } });
  });

  // ---------------------------------------------- NEGATIVE CONTROLS ---------
  //
  // Each of these is a design guarantee that must be enforced by the database
  // rather than by the code remembering to ask nicely.
  await expectRefused("advancing absoluteExpiresAt (the 90-day ceiling)", () =>
    auth.$executeRawUnsafe(`UPDATE "AuthSession" SET "absoluteExpiresAt" = now() WHERE true`)
  );
  await expectRefused("repointing userId at another account (session hijack)", () =>
    auth.$executeRawUnsafe(`UPDATE "AuthSession" SET "userId" = 1 WHERE true`)
  );
  await expectRefused("rewriting tokenVersionAtIssue (reviving a logged-out session)", () =>
    auth.$executeRawUnsafe(`UPDATE "AuthSession" SET "tokenVersionAtIssue" = 0 WHERE true`)
  );
  await expectRefused("moving graceUntil after the fact", () =>
    auth.$executeRawUnsafe(`UPDATE "AuthSessionSecret" SET "graceUntil" = now() WHERE true`)
  );
  await expectRefused("rewriting a stored rotated secret", () =>
    auth.$executeRawUnsafe(`UPDATE "AuthSessionSecret" SET "secretHash" = "secretHash" WHERE true`)
  );
  await expectRefused("inserting a session that is born revoked", () =>
    auth.$executeRawUnsafe(
      `INSERT INTO "AuthSession" ("userId","secretHash","tokenVersionAtIssue","createdAt","lastUsedAt","idleExpiresAt","absoluteExpiresAt","revokedAt")
       VALUES (${user.id},'${"a".repeat(64)}',0,now(),now(),now(),now(),now())`
    )
  );

  // Cleanup runs last so the sweep path is exercised after the refusals.
  await expectAllowed("delete on both tables (expiry sweep and cap eviction)", async () => {
    await auth.authSessionSecret.deleteMany({ where: { sessionId } });
    await auth.authSession.deleteMany({ where: { userId: user.id } });
  });

  await auth.$disconnect();
  await owner.$disconnect();

  console.log(`\n[auth-session-orm-battery] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("BATTERY ERROR:", e);
  process.exit(1);
});
