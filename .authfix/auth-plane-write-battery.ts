/**
 * AUTH-PLANE WRITE BATTERY — the ORM proof, on a real PostgreSQL 17.
 *
 *   OWNER_URL=postgresql://... npx tsx .authfix/auth-plane-write-battery.ts
 *
 * Why this exists and the privilege battery did not catch the outage:
 *
 *   `.tx3a1/exact-grant-battery.mjs` proves what a ROLE may do. Every statement
 *   it issues is one a human chose to write. The statement that broke
 *   Production is the one nobody wrote — Prisma appends `RETURNING <every
 *   scalar column>` to a write that carries no `select`, and RETURNING needs
 *   SELECT on what it returns. A catalog check cannot see that; only running
 *   the ORM against the real grants can.
 *
 * So this lab builds the schema, applies the SHIPPED E4 migration verbatim,
 * attaches a LOGIN role to `app_auth` exactly as every environment does, and
 * then drives the REAL login, logout and signup code paths through it.
 *
 * It also runs the incident itself as a NEGATIVE CONTROL: the same update with
 * the `select` removed must still fail with 42501. If that ever starts passing,
 * the lab has stopped reproducing Production and every result below is worthless.
 *
 * Synthetic CI-only credentials. Zero secrets, zero Neon, zero network, zero
 * Production.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OWNER_URL = process.env.OWNER_URL;
if (!OWNER_URL) {
  console.error("OWNER_URL is required (owner connection to the throwaway lab database).");
  process.exit(2);
}

const AUTH_ROLE = "app_auth_battery";
const AUTH_PW = "authfix_ci_synthetic_pw";
const AUTH_URL = OWNER_URL.replace(/\/\/[^@]*@/, `//${AUTH_ROLE}:${AUTH_PW}@`);

const MIG = (n: string) => join(ROOT, "prisma/migrations", n, "migration.sql");
const E4 = MIG("20260908180000_d2_user_business_privilege_narrowing");
const SESSION_CONTRACT = MIG("20260908200000_auth_session_privilege_contract");
const USER_AGENT = MIG("20260913120000_authsession_user_agent");

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

/** Postgres error code carried by whatever Prisma wrapped around it. */
function pgCode(error: unknown): string | null {
  const text = error instanceof Error ? `${error.message}` : String(error);
  const m = text.match(/code:\s*"(\w+)"/) ?? text.match(/\b(42501)\b/);
  return m ? m[1] : null;
}

/**
 * Dollar-quote-aware statement splitter.
 *
 * The naive split-on-semicolon version this replaces could not survive the
 * privilege-contract migrations, whose statements live inside DO $do$ ... $do$
 * guards: it tore a guard in half and reported a syntax error that said nothing
 * about the real cause.
 */
function dollarTagAt(src: string, i: number): string | null {
  if (src[i] !== "$") return null;
  let j = i + 1;
  while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
  if (src[j] !== "$") return null;
  return src.slice(i, j + 1);
}

function statements(sql: string): string[] {
  const src = sql.replace(/--.*$/gm, "");
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < src.length) {
    const tag = dollarTagAt(src, i);
    if (tag !== null) {
      // Copy the whole quoted body verbatim, semicolons included.
      const close = src.indexOf(tag, i + tag.length);
      const end = close === -1 ? src.length : close + tag.length;
      buf += src.slice(i, end);
      i = end;
      continue;
    }
    if (src[i] === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      i++;
      continue;
    }
    buf += src[i];
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL, log: ["error"] });

  // ---------------------------------------------------------------- lab ----
  // Both group roles, because the shipped migration names both and is ungated.
  // The LOGIN role is attached by membership, which is how every real
  // environment resolves the privilege — Production included.
  for (const sql of [
    `DROP ROLE IF EXISTS ${AUTH_ROLE}`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_auth') THEN CREATE ROLE app_auth NOLOGIN; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN; END IF; END $$`,
    `CREATE ROLE ${AUTH_ROLE} LOGIN PASSWORD '${AUTH_PW}' IN ROLE app_auth`,
    `GRANT USAGE ON SCHEMA public TO app_auth`,
    // Pre-state: the blanket table-level grant these roles held before E4. The
    // migration's first act is to revoke it, so starting without it would let
    // the revoke pass vacuously.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."User", public."Business" TO app_auth`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."User", public."Business" TO app_runtime`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_auth`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime`,
    // Login now fails CLOSED if it cannot create a session, so this lab has to
    // be able to create one or every assertion below would fail for a reason
    // that has nothing to do with the User/Business contract under test.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."AuthSession", public."AuthSessionSecret" TO app_auth`,
  ]) {
    await owner.$executeRawUnsafe(sql);
  }

  // The privilege contract under test is the file that actually ships.
  for (const s of statements(readFileSync(E4, "utf8"))) {
    await owner.$executeRawUnsafe(s);
  }
  // And the rest of the shipped auth surface, so the lab is not behind the
  // schema the Prisma model describes.
  for (const f of [SESSION_CONTRACT, USER_AGENT]) {
    for (const s of statements(readFileSync(f, "utf8"))) await owner.$executeRawUnsafe(s);
  }
  ok("shipped E4 migration applied to the lab", true);

  // ------------------------------------------------------------- fixture ---
  const bcrypt = (await import("bcrypt")).default;
  const PASSWORD = "battery-synthetic-password";
  const hash = await bcrypt.hash(PASSWORD, 10);
  const email = `battery-${Date.now()}@lab.invalid`;

  const business = await owner.business.create({
    data: { name: "Battery Lab" },
    select: { id: true },
  });
  const seeded = await owner.user.create({
    data: { email, password: hash, name: "Battery", businessId: business.id },
    select: { id: true, tokenVersion: true },
  });

  // ------------------------------------------------- the incident, replayed --
  const restricted = new PrismaClient({ datasourceUrl: AUTH_URL, log: [] });

  {
    // NEGATIVE CONTROL. This is verbatim what Production ran at 19:21Z onward.
    let code: string | null = null;
    try {
      await restricted.user.update({
        where: { id: seeded.id },
        data: { lastLoginAt: new Date(), loginCount: { increment: 1 } },
      });
    } catch (e) {
      code = pgCode(e);
    }
    ok(
      "NEGATIVE CONTROL: an update with no select is still refused (42501)",
      code === "42501",
      code === null ? "it SUCCEEDED — the lab no longer reproduces Production" : `got ${code}`
    );
  }

  {
    // The fix, at the ORM level, on the same connection.
    let threw: unknown = null;
    try {
      await restricted.user.update({
        where: { id: seeded.id },
        data: { lastLoginAt: new Date(), loginCount: { increment: 1 } },
        select: { id: true },
      });
    } catch (e) {
      threw = e;
    }
    ok("the same update with select: { id } is permitted", threw === null, String(threw).slice(0, 160));
  }

  {
    // A select naming a column outside the grant must still fail, so the fix is
    // "select what you may read", not "add any select".
    let code: string | null = null;
    try {
      await restricted.user.update({
        where: { id: seeded.id },
        data: { loginCount: { increment: 1 } },
        select: { id: true, createdAt: true },
      });
    } catch (e) {
      code = pgCode(e);
    }
    ok("a select naming an ungranted column is refused", code === "42501", `got ${code}`);
  }

  await restricted.$disconnect();

  // ------------------------------------------------- the real code paths ----
  // Env before import: authDb() resolves the mode and the credential at first
  // use, and the tenant client is constructed at module load.
  process.env.AUTH_PLANE_ENABLED = "true";
  process.env.AUTH_DATABASE_URL = AUTH_URL;
  process.env.DATABASE_URL = OWNER_URL;
  process.env.DIRECT_URL = OWNER_URL;
  process.env.AUTH_TOKEN_SECRET =
    process.env.AUTH_TOKEN_SECRET ?? "battery-synthetic-token-secret-not-a-real-key";
  process.env.RATE_LIMIT_BACKEND = "memory";

  const loginRoute = await import("@/app/api/auth/login/route");
  const logoutRoute = await import("@/app/api/auth/logout/route");
  const { createAccount } = await import("@/lib/auth/signup");

  let token = "";
  {
    const res = await loginRoute.POST(
      new Request("https://lab.invalid/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: PASSWORD }),
      })
    );
    const body = (await res.json()) as { token?: string; error?: string };
    ok("REAL login route returns 200", res.status === 200, `status ${res.status} ${body.error ?? ""}`);
    ok("REAL login route mints a token", typeof body.token === "string" && body.token.length > 0);
    token = body.token ?? "";
  }

  {
    const after = await owner.user.findUnique({
      where: { id: seeded.id },
      select: { lastLoginAt: true, loginCount: true },
    });
    ok("the login stamp was actually written", after?.lastLoginAt !== null && (after?.loginCount ?? 0) > 0);
  }

  {
    const res = await logoutRoute.POST(
      new Request("https://lab.invalid/api/auth/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      })
    );
    const body = (await res.json()) as { success?: boolean; error?: string };
    ok("REAL logout route returns 200", res.status === 200, `status ${res.status} ${body.error ?? ""}`);
    const after = await owner.user.findUnique({
      where: { id: seeded.id },
      select: { tokenVersion: true },
    });
    ok(
      "logout incremented tokenVersion",
      (after?.tokenVersion ?? -1) === seeded.tokenVersion + 1,
      `was ${seeded.tokenVersion}, now ${after?.tokenVersion}`
    );

    // The property that matters, now created DELIBERATELY instead of by accident.
    //
    // The increment above has already signed the user out of every device, so a
    // failure to MARK the rows must not be reported as a failed logout: telling
    // someone who IS signed out that it did not work is the worst lie this
    // endpoint can tell. This used to be proven incidentally, because the lab
    // happened to grant nothing on the table. Login now needs those privileges to
    // exist, so the condition has to be created on purpose.
    {
      const second = await owner.user.create({
        data: {
          email: `logout-${Date.now()}@lab.invalid`,
          password: hash,
          name: "lo",
          businessId: business.id,
        },
        select: { id: true, email: true, tokenVersion: true },
      });
      const loginAgain = await loginRoute.POST(
        new Request("https://lab.invalid/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: second.email, password: PASSWORD }),
        })
      );
      const tok = ((await loginAgain.json()) as { token?: string }).token ?? "";
      await owner.$executeRawUnsafe(`REVOKE UPDATE ON public."AuthSession" FROM app_auth`);
      const out = await logoutRoute.POST(
        new Request("https://lab.invalid/api/auth/logout", {
          method: "POST",
          headers: { authorization: `Bearer ${tok}` },
        })
      );
      const bumped = await owner.user.findUnique({
        where: { id: second.id },
        select: { tokenVersion: true },
      });
      ok("logout reports success even where session revocation is refused", out.status === 200, `${out.status}`);
      ok(
        "...and the generation moved anyway, which is what actually signs them out",
        (bumped?.tokenVersion ?? -1) === second.tokenVersion + 1
      );
      // Restore, and prove the restore worked rather than assuming it.
      for (const f of [SESSION_CONTRACT, USER_AGENT]) {
        for (const st of statements(readFileSync(f, "utf8"))) await owner.$executeRawUnsafe(st);
      }
      const restored = await owner.$queryRawUnsafe<Array<{ v: boolean }>>(
        `SELECT has_column_privilege($$app_auth$$, $$public."AuthSession"$$, $$revokedAt$$, $$UPDATE$$) AS v`
      );
      ok("...and the privilege was restored", restored[0]?.v === true);
    }
  }

  // ------------------------------------------------------------- signup ----
  //
  // Signup is NOT restored by this change, and pretending otherwise would be
  // worse than leaving it broken. An explicit `select` fixes the read back —
  // the captured RETURNING below is correctly narrowed — but Prisma also names
  // every column it has a value for in the INSERT itself, including the ones
  // whose values come from model defaults. E4 granted INSERT on the columns a
  // human would list, which is a strictly smaller set.
  //
  // Closing that needs a GRANT, which is a privilege decision and deliberately
  // out of scope for an incident fix. So the gap is MEASURED instead of
  // assumed, and asserted to be exactly what it is today: this check fails the
  // moment the set changes in either direction, including the day the grant
  // lands and these assertions must be flipped to success.
  {
    const captured: string[] = [];
    const probe = new PrismaClient({
      datasourceUrl: AUTH_URL,
      log: [{ emit: "event", level: "query" }],
    });
    // @ts-expect-error the event overload is not in the generated union
    probe.$on("query", (e: { query: string }) => {
      if (/^INSERT/i.test(e.query.trim())) captured.push(e.query);
    });

    const seedBusiness = await owner.business.create({
      data: { name: "Signup Gap Probe" },
      select: { id: true },
    });
    for (const attempt of [
      () => probe.business.create({ data: { name: "gap" }, select: { id: true, name: true } }),
      () =>
        probe.user.create({
          data: {
            email: `gap-${Date.now()}@lab.invalid`,
            password: hash,
            name: "gap",
            businessId: seedBusiness.id,
          },
          select: { id: true, email: true, tokenVersion: true },
        }),
    ]) {
      try {
        await attempt();
      } catch {
        /* expected while the INSERT grant is short; the SQL is what matters */
      }
    }
    await probe.$disconnect();

    const insertColumns = (sql: string): string[] =>
      [...(sql.match(/INSERT INTO[^(]*\(([^)]*)\)/i)?.[1] ?? "").matchAll(/"(\w+)"/g)].map(
        (m) => m[1]
      );
    const granted = (model: "User" | "Business"): Set<string> => {
      const re = new RegExp(
        `GRANT\\s+INSERT\\s*\\(([^)]*)\\)\\s*\\n?\\s*ON\\s+public\\."${model}"\\s+TO\\s+app_auth\\s*;`,
        "i"
      );
      const m = readFileSync(E4, "utf8").replace(/--.*$/gm, "").match(re);
      return new Set([...(m?.[1] ?? "").matchAll(/"(\w+)"/g)].map((x) => x[1]));
    };

    const bSql = captured.find((s) => s.includes('"Business"')) ?? "";
    const uSql = captured.find((s) => s.includes('"User"')) ?? "";
    ok("captured the INSERT Prisma actually emits for both models", Boolean(bSql && uSql));

    const bMissing = insertColumns(bSql).filter((c) => !granted("Business").has(c)).sort();
    const uMissing = insertColumns(uSql).filter((c) => !granted("User").has(c)).sort();

    ok(
      "Business INSERT gap is exactly createdAt",
      bMissing.join(",") === "createdAt",
      `measured: ${bMissing.join(", ") || "(none)"}`
    );
    ok(
      "User INSERT gap is exactly createdAt, loginCount, role, tokenVersion",
      uMissing.join(",") === "createdAt,loginCount,role,tokenVersion",
      `measured: ${uMissing.join(", ") || "(none)"}`
    );

    // The read back, at least, is fixed: RETURNING now names only granted columns.
    ok(
      "signup's RETURNING is narrowed to granted columns",
      /RETURNING[^;]*"id"/.test(bSql) && !/RETURNING[^;]*"createdAt"/.test(bSql) &&
        !/RETURNING[^;]*"createdAt"/.test(uSql)
    );

    // And the real path still fails, for that reason and no other.
    let code: string | null = null;
    try {
      await createAccount({
        email: `battery-signup-${Date.now()}@lab.invalid`,
        passwordHash: hash,
        name: "Signup Battery",
        businessName: "Signup Lab",
      });
    } catch (e) {
      code = pgCode(e);
    }
    ok(
      "REAL signup still refused (42501) — PENDING an INSERT grant, not a code fix",
      code === "42501",
      code === null
        ? "signup SUCCEEDED — the grant must have landed; flip these assertions to success"
        : `got ${code}`
    );
  }

  await owner.$disconnect();

  console.log(`\n[auth-plane-write-battery] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("BATTERY ERROR:", e);
  process.exit(1);
});
