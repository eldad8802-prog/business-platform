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
const RUNTIME_URL = OWNER_URL.replace(/\/\/[^@]*@/, `//app_runtime_battery:authfix_ci_synthetic_runtime_pw@`);
const ROGUE_URL = OWNER_URL.replace(/\/\/[^@]*@/, `//rogue_battery:authfix_ci_synthetic_rogue_pw@`);

const MIG = (n: string) => join(ROOT, "prisma/migrations", n, "migration.sql");
const E4 = MIG("20260908180000_d2_user_business_privilege_narrowing");
const SESSION_CONTRACT = MIG("20260908200000_auth_session_privilege_contract");
const USER_AGENT = MIG("20260913120000_authsession_user_agent");
// The two grants Production has applied since E4. Without them this lab models
// a database that no longer exists, and signup "fails" here for a reason it
// does not fail for in Production.
const SEC_C = MIG("20260926110300_sec_c_explicit_identity_grants");
const B4 = MIG("20261006090000_business_tenant_write_rls");
// M1: setup state on BusinessProfile, signup consent (app_auth INSERT on three
// User columns) + tenant-pinned rename (runtime UPDATE Business.name), and the
// case-folded email index.
const M1_STATE = MIG("20261011090000_onboarding_setup_state");
const M1_CONSENT = MIG("20261011090100_signup_consent_business_rename");
const M1_CASEFOLD = MIG("20261011090200_user_email_casefold_unique");
// Transactional email: signup records the WELCOME it owes in the account transaction, so the
// signup plane's INSERT on TransactionalEmail is part of the signup contract this lab proves.
const TE = MIG("20261015090000_transactional_email_foundation");

const RUNTIME_ROLE = "app_runtime_battery";
const RUNTIME_PW = "authfix_ci_synthetic_runtime_pw";
const ROGUE_ROLE = "rogue_battery";
const ROGUE_PW = "authfix_ci_synthetic_rogue_pw";

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
    `DROP ROLE IF EXISTS ${RUNTIME_ROLE}`,
    `DROP ROLE IF EXISTS ${ROGUE_ROLE}`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_auth') THEN CREATE ROLE app_auth NOLOGIN; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN; END IF; END $$`,
    `CREATE ROLE ${AUTH_ROLE} LOGIN PASSWORD '${AUTH_PW}' IN ROLE app_auth`,
    `CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PW}' IN ROLE app_runtime`,
    // A login that is NOT in app_auth but holds a direct INSERT grant: the role
    // the B4 preflight hunts for. Only row-level security can stop it.
    `CREATE ROLE ${ROGUE_ROLE} LOGIN PASSWORD '${ROGUE_PW}'`,
    `GRANT USAGE ON SCHEMA public TO app_auth`,
    `GRANT USAGE ON SCHEMA public TO app_runtime`,
    `GRANT USAGE ON SCHEMA public TO ${ROGUE_ROLE}`,
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
  // Then what Production applied after it, in ledger order: sec_c's identity
  // INSERT grants, and B4's row-level security on Business.
  // db push built the M1 columns from the models. Remove them so the shipped
  // M1 migrations run verbatim against the shape Production has before them.
  for (const sql of [
    `ALTER TABLE "BusinessProfile" DROP COLUMN IF EXISTS "onboardingCompletedAt", DROP COLUMN IF EXISTS "onboardingGoal", DROP COLUMN IF EXISTS "onboardingGoalSource"`,
    `ALTER TABLE "User" DROP COLUMN IF EXISTS "termsAcceptedAt", DROP COLUMN IF EXISTS "termsVersion", DROP COLUMN IF EXISTS "signupAttribution"`,
  ]) {
    await owner.$executeRawUnsafe(sql);
  }
  for (const f of [SEC_C, B4, M1_STATE, M1_CONSENT, M1_CASEFOLD]) {
    for (const s of statements(readFileSync(f, "utf8"))) await owner.$executeRawUnsafe(s);
  }
  // db push built TransactionalEmail from the model, without the migration's RLS and grants.
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "TransactionalEmail" CASCADE`);
  for (const s of statements(readFileSync(TE, "utf8"))) await owner.$executeRawUnsafe(s);
  {
    const te = await owner.$queryRawUnsafe<Array<{ r: boolean; f: boolean }>>(
      `SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname = 'TransactionalEmail'`
    );
    ok("transactional email migration applied: TransactionalEmail under FORCED row-level security", te[0]?.r === true && te[0]?.f === true);
  }
  {
    const rls = await owner.$queryRawUnsafe<Array<{ r: boolean; f: boolean }>>(
      `SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname = 'Business'`
    );
    ok("sec_c + B4 applied: Business is under FORCED row-level security", rls[0]?.r === true && rls[0]?.f === true);
  }
  await owner.$executeRawUnsafe(`GRANT INSERT ("name", "createdAt", "updatedAt") ON public."Business" TO ${ROGUE_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SEQUENCE public."Business_id_seq" TO ${ROGUE_ROLE}`);

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
  process.env.PUBLIC_SIGNUP_ENABLED = "true";
  const registerRoute = await import("@/app/api/auth/register/route");
  const refreshRoute = await import("@/app/api/auth/refresh/route");
  const { createAccount } = await import("@/lib/auth/signup");
  const { getAuthContext } = await import("@/lib/auth");
  const { verifyAuthTokenPayload } = await import("@/lib/auth-token");
  const { issueRefreshSession } = await import("@/lib/auth/refresh-session");

  /** The same three writes createAccount makes, on a caller-chosen client. */
  async function createAccountVia(db: InstanceType<typeof PrismaClient>, address: string) {
    await db.$transaction(async (tx) => {
      const b = await tx.business.create({ data: { name: "probe" }, select: { id: true, name: true } });
      const u = await tx.user.create({
        data: { email: address, password: hash, name: "probe", businessId: b.id },
        select: { id: true, email: true, tokenVersion: true },
      });
      await issueRefreshSession(tx, { userId: u.id, tokenVersion: u.tokenVersion, now: new Date() });
    });
  }

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
  // Signup under the grants Production actually holds: E4's narrowing, sec_c's
  // explicit identity INSERT grants, and B4's forced row-level security on
  // Business. This section used to assert that signup FAILED (42501), because
  // the lab stopped at E4. That modelled a database that no longer exists.
  //
  // What is proven here, through a LOGIN role attached to app_auth exactly as
  // Production's auth login is:
  //   1. Prisma's INSERT names no column outside the granted set.
  //   2. The REAL createAccount and the REAL register route succeed.
  //   3. Signup ends where login ends: an AuthSession row, a token that names
  //      it, the refresh cookie — and that token resolves, refreshes and revokes.
  //   4. Duplicates, double submits and a failed session leave nothing behind.
  //   5. No signup can reach another tenant, and Business can be created by
  //      app_auth only — not the runtime, not a role with a stray INSERT grant.
  const tableCount = async (sql: string): Promise<number> =>
    Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]?.n ?? 0);
  const businessCount = () => tableCount(`SELECT count(*)::bigint AS n FROM "Business"`);
  const userCount = (address: string) =>
    tableCount(`SELECT count(*)::bigint AS n FROM "User" WHERE email = '${address.replace(/'/g, "''")}'`);
  const sessionCount = (userId: number) =>
    tableCount(`SELECT count(*)::bigint AS n FROM "AuthSession" WHERE "userId" = ${Number(userId)}`);

  // 1 — the INSERT Prisma emits, against the union of every shipped grant.
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
    await createAccountVia(probe, `probe-${Date.now()}@lab.invalid`);
    await probe.$disconnect();

    const insertColumns = (sql: string): string[] =>
      [...(sql.match(/INSERT INTO[^(]*\(([^)]*)\)/i)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
    const granted = (model: "User" | "Business"): Set<string> => {
      const out = new Set<string>();
      const re = new RegExp(
        `GRANT\\s+INSERT\\s*\\(([^)]*)\\)\\s*\\n?\\s*ON\\s+(?:public\\.)?"${model}"\\s+TO\\s+app_auth\\s*;`,
        "gi"
      );
      for (const f of [E4, SEC_C, M1_CONSENT]) {
        for (const m of readFileSync(f, "utf8").replace(/--.*$/gm, "").matchAll(re)) {
          for (const c of m[1].matchAll(/"(\w+)"/g)) out.add(c[1]);
        }
      }
      return out;
    };
    const bSql = captured.find((x) => x.includes('"Business"')) ?? "";
    const uSql = captured.find((x) => x.includes('"User"')) ?? "";
    const sSql = captured.find((x) => x.includes('"AuthSession"')) ?? "";
    ok("captured the INSERTs signup emits (Business, User, AuthSession)", Boolean(bSql && uSql && sSql));
    const bMissing = insertColumns(bSql).filter((c) => !granted("Business").has(c));
    const uMissing = insertColumns(uSql).filter((c) => !granted("User").has(c));
    ok("Business INSERT names only granted columns", bMissing.length === 0, `ungranted: ${bMissing.join(", ")}`);
    ok("User INSERT names only granted columns", uMissing.length === 0, `ungranted: ${uMissing.join(", ")}`);
    ok(
      "signup's RETURNING is narrowed to granted columns",
      /RETURNING[^;]*"id"/.test(bSql) && !/RETURNING[^;]*"createdAt"/.test(bSql) &&
        !/RETURNING[^;]*"createdAt"/.test(uSql)
    );
  }

  // 2 — the real account transaction, on the auth plane.
  {
    const address = `battery-signup-${Date.now()}@lab.invalid`;
    let threw: unknown = null;
    let account: Awaited<ReturnType<typeof createAccount>> | null = null;
    try {
      account = await createAccount({
        email: address,
        passwordHash: hash,
        name: "Signup Battery",
        businessName: "Signup Lab",
        now: new Date(),
        userAgent: "battery",
      });
    } catch (e) {
      threw = e;
    }
    ok("REAL createAccount succeeds under E4 + sec_c + B4", threw === null, String(threw).slice(0, 200));
    ok(
      "...and writes exactly one session for the new owner",
      account !== null && (await sessionCount(account.userId)) === 1
    );
  }

  // 3 — the real route, end to end, compared with what login gives.
  let ipSeq = 0;
  const register = async (address: string, businessName: string) =>
    registerRoute.POST(
      new Request("https://lab.invalid/api/auth/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "battery-browser",
          // A fresh address per call: the 3-per-hour limit is not under test.
          "x-forwarded-for": `198.51.100.${++ipSeq}`,
        },
        body: JSON.stringify({
          email: address,
          password: PASSWORD,
          name: "בעלת עסק",
          businessName,
          acceptTerms: true,
          attribution: { utm_source: "facebook", utm_medium: "<b>", referrer: "https://www.google.com/search?q=private" },
        }),
      })
    );
  type RegisterBody = { token?: string; user?: { id: number; businessId: number }; code?: string; error?: string };

  const emailA = `owner-a-${Date.now()}@lab.invalid`;
  const emailB = `owner-b-${Date.now()}@lab.invalid`;
  const resA = await register(emailA, "עסק א");
  const bodyA = (await resA.json()) as RegisterBody;
  ok("REAL register route returns 200 with the gate open", resA.status === 200, `status ${resA.status} ${bodyA.error ?? ""}`);
  const resB = await register(emailB, "עסק ב");
  const bodyB = (await resB.json()) as RegisterBody;
  ok("a second owner registers too", resB.status === 200, `status ${resB.status} ${bodyB.error ?? ""}`);

  const tokenA = bodyA.token ?? "";
  const tokenB = bodyB.token ?? "";
  const claims = verifyAuthTokenPayload(tokenA);
  ok("signup token names a session (sid)", claims !== null && typeof claims.sessionId === "string");
  {
    const row = claims?.sessionId
      ? await owner.authSession.findUnique({
          where: { id: claims.sessionId },
          select: { userId: true, tokenVersionAtIssue: true, revokedAt: true, userAgent: true },
        })
      : null;
    ok("...and that AuthSession row exists and belongs to the new owner", row !== null && row.userId === bodyA.user?.id);
    ok("...issued at the owner's current generation, unrevoked", row?.tokenVersionAtIssue === 0 && row?.revokedAt === null);
    ok("...carrying the device label, as login's does", row?.userAgent === "battery-browser");
  }
  const cookieA = resA.headers.get("set-cookie") ?? "";
  ok("signup sets the httpOnly refresh cookie", /^dubiz_rt=/.test(cookieA) && /httponly/i.test(cookieA));
  ok(
    "...scoped exactly as login's cookie (Path=/api/auth/refresh, SameSite=Strict)",
    /path=\/api\/auth\/refresh/i.test(cookieA) && /samesite=strict/i.test(cookieA)
  );

  const bearer = (t: string) =>
    new Request("https://lab.invalid/api/x", { headers: { authorization: `Bearer ${t}` } });
  const ctxA = await getAuthContext(bearer(tokenA));
  const ctxB = await getAuthContext(bearer(tokenB));
  ok("signup token authenticates through every gate", ctxA !== null && ctxA.sessionId === claims?.sessionId);
  ok("owner A resolves to their own new business", ctxA?.user.businessId === bodyA.user?.businessId);
  ok("owner B resolves to a different business", ctxB !== null && ctxB.user.businessId !== ctxA?.user.businessId);

  // Refresh: the signup cookie is a real refresh credential.
  {
    const credential = decodeURIComponent(cookieA.split(";")[0].slice("dubiz_rt=".length));
    const res = await refreshRoute.POST(
      new Request("https://lab.invalid/api/auth/refresh", {
        method: "POST",
        headers: {
          cookie: `dubiz_rt=${credential}`,
          origin: "https://lab.invalid",
          host: "lab.invalid",
          "sec-fetch-site": "same-origin",
        },
      })
    );
    const body = (await res.json()) as { token?: string };
    ok(
      "the signup refresh credential rotates like login's",
      res.status === 200 && typeof body.token === "string",
      `status ${res.status}`
    );
    ok("...and the refreshed token authenticates", (await getAuthContext(bearer(body.token ?? ""))) !== null);
  }

  // Revocation: the signup device can be signed out on its own.
  {
    await owner.authSession.update({
      where: { id: claims?.sessionId ?? "" },
      data: { revokedAt: new Date(), revokedReason: "battery" },
      select: { id: true },
    });
    ok("revoking the signup session cuts that device off", (await getAuthContext(bearer(tokenA))) === null);
    ok("...and only that owner (B unaffected)", (await getAuthContext(bearer(tokenB))) !== null);
  }

  // 4 — duplicates, double submits and a failed session.
  {
    const before = await businessCount();
    const dup = await register(emailB, "עסק כפול");
    const dupBody = (await dup.json()) as RegisterBody;
    ok(
      "a duplicate email is a 409 EMAIL_ALREADY_REGISTERED",
      dup.status === 409 && dupBody.code === "EMAIL_ALREADY_REGISTERED"
    );
    ok("...leaving no orphan Business", (await businessCount()) === before);
    ok("...and still exactly one account for that address", (await userCount(emailB)) === 1);
    const upper = await register(emailB.toUpperCase(), "עסק כפול");
    ok("a different spelling of the same address is the same account (409)", upper.status === 409);
  }
  {
    const address = `double-${Date.now()}@lab.invalid`;
    const before = await businessCount();
    const [r1, r2] = await Promise.all([register(address, "כפול 1"), register(address, "כפול 2")]);
    const statuses = [r1.status, r2.status].sort();
    ok(
      "a simultaneous double submit: exactly one 200 and one 409",
      statuses[0] === 200 && statuses[1] === 409,
      `${statuses}`
    );
    ok("...one Business", (await businessCount()) === before + 1);
    ok("...one User", (await userCount(address)) === 1);
    const winner = (await owner.user.findUnique({ where: { email: address }, select: { id: true } }))?.id ?? -1;
    ok("...one session", (await sessionCount(winner)) === 1);
  }
  {
    // The session is part of the account: if it cannot be written, neither is
    // the account — so the visitor can simply try again.
    const address = `nosession-${Date.now()}@lab.invalid`;
    const before = await businessCount();
    await owner.$executeRawUnsafe(`REVOKE INSERT ON public."AuthSession" FROM app_auth`);
    const res = await register(address, "בלי סשן");
    ok("a refused session insert fails the signup", res.status === 500, `status ${res.status}`);
    ok("...and rolls back the Business", (await businessCount()) === before);
    ok("...and the User", (await userCount(address)) === 0);
    for (const f of [SESSION_CONTRACT, USER_AGENT]) {
      for (const st of statements(readFileSync(f, "utf8"))) await owner.$executeRawUnsafe(st);
    }
    const retry = await register(address, "בלי סשן");
    ok("...so the same visitor can simply sign up again", retry.status === 200, `status ${retry.status}`);
  }

  // 5 — tenant boundaries around account creation.
  {
    const runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL, log: [] });
    const rogue = new PrismaClient({ datasourceUrl: ROGUE_URL, log: [] });
    const auth = new PrismaClient({ datasourceUrl: AUTH_URL, log: [] });
    const businessA = bodyA.user?.businessId ?? -1;
    const businessB = bodyB.user?.businessId ?? -1;

    const refused = async (fn: () => Promise<unknown>): Promise<string | null> => {
      try {
        await fn();
        return null;
      } catch (e) {
        return pgCode(e) ?? "error";
      }
    };
    const insertBusiness = `INSERT INTO "Business" (name, "updatedAt") VALUES ('x', now())`;

    ok(
      "the runtime cannot create a Business (no INSERT grant)",
      (await refused(() => runtime.$executeRawUnsafe(insertBusiness))) === "42501"
    );
    ok(
      "a login outside app_auth holding a stray INSERT grant is stopped by B4 RLS",
      (await refused(() => rogue.$executeRawUnsafe(insertBusiness))) === "42501"
    );
    ok(
      "the auth plane cannot UPDATE any Business",
      (await refused(() =>
        auth.$executeRawUnsafe(`UPDATE "Business" SET "archivedAt" = now() WHERE id = ${businessB}`)
      )) === "42501"
    );
    const inTenant = <T,>(tenant: number, fn: (tx: Parameters<Parameters<typeof runtime.$transaction>[0]>[0]) => Promise<T>) =>
      runtime.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', '${tenant}', true)`);
        return fn(tx);
      });
    // The runtime, pinned to tenant A, tries to touch tenant B's lifecycle.
    const touched = await inTenant(businessA, (tx) =>
      tx.$executeRawUnsafe(`UPDATE "Business" SET "archivedAt" = now() WHERE id = ${businessB}`)
    );
    ok("tenant A's context cannot update tenant B's Business (B4: 0 rows)", touched === 0, `${touched} rows`);
    const own = await inTenant(businessA, (tx) =>
      tx.$executeRawUnsafe(`UPDATE "Business" SET "archivedAt" = NULL WHERE id = ${businessA}`)
    );
    ok("...while its own row is reachable (the policy is not simply closed)", own === 1, `${own} rows`);
    // M1: the owner may rename THEIR business — and only theirs.
    const renamedOwn = await inTenant(businessA, (tx) =>
      tx.$executeRawUnsafe(`UPDATE "Business" SET name = 'עסק א חדש' WHERE id = ${businessA}`)
    );
    ok("the runtime renames its own tenant's Business (1 row)", renamedOwn === 1, `${renamedOwn} rows`);
    const renamedOther = await inTenant(businessA, (tx) =>
      tx.$executeRawUnsafe(`UPDATE "Business" SET name = 'hijack' WHERE id = ${businessB}`)
    );
    ok("...but tenant A's context renames 0 rows of tenant B (B4)", renamedOther === 0, `${renamedOther} rows`);
    const renamedNoTenant = await runtime.$executeRawUnsafe(`UPDATE "Business" SET name = 'nobody' WHERE id = ${businessA}`);
    ok("...and with no tenant context renames nothing", renamedNoTenant === 0, `${renamedNoTenant} rows`);
    ok(
      "the rename grant is the name column only (createdAt still refused)",
      (await refused(() =>
        inTenant(businessA, (tx) => tx.$executeRawUnsafe(`UPDATE "Business" SET "createdAt" = now() WHERE id = ${businessA}`))
      )) === "42501"
    );
    {
      const names = await owner.business.findMany({
        where: { id: { in: [businessA, businessB] } },
        select: { id: true, name: true },
      });
      ok(
        "...and the stored names are exactly A renamed, B untouched",
        names.find((b) => b.id === businessA)?.name === "עסק א חדש" &&
          names.find((b) => b.id === businessB)?.name === "עסק ב"
      );
    }
    ok(
      "the auth plane writes consent but cannot read it back",
      (await refused(() => auth.$queryRawUnsafe(`SELECT "termsAcceptedAt" FROM "User" LIMIT 1`))) === "42501"
    );
    // A token for B never authenticates as A, whatever the request claims.
    const spoof = new Request(`https://lab.invalid/api/x?businessId=${businessA}`, {
      headers: { authorization: `Bearer ${tokenB}`, "x-business-id": String(businessA) },
    });
    ok("tenant comes from the user row, never the request", (await getAuthContext(spoof))?.user.businessId === businessB);

    await Promise.all([runtime.$disconnect(), rogue.$disconnect(), auth.$disconnect()]);
  }

  // 6 — consent and identity recorded with the account (M1).
  {
    const { CURRENT_TERMS_VERSION } = await import("@/lib/legal/consent-version");
    const row = await owner.user.findUnique({
      where: { email: emailA },
      select: { termsAcceptedAt: true, termsVersion: true, signupAttribution: true, createdAt: true },
    });
    ok("signup records when the terms were accepted", row?.termsAcceptedAt instanceof Date);
    ok("...and which text", row?.termsVersion === CURRENT_TERMS_VERSION, String(row?.termsVersion));
    ok(
      "...and only sanitised attribution (labels + referrer host)",
      JSON.stringify(row?.signupAttribution) === JSON.stringify({ utm_source: "facebook", referrerHost: "www.google.com" }),
      JSON.stringify(row?.signupAttribution)
    );
    const before = await businessCount();
    const noConsent = await registerRoute.POST(
      new Request("https://lab.invalid/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.250" },
        body: JSON.stringify({ email: `noconsent-${Date.now()}@lab.invalid`, password: PASSWORD, name: "x y", businessName: "עסק" }),
      })
    );
    ok("no consent → 400 and nothing created", noConsent.status === 400 && (await businessCount()) === before);

    // The database itself now refuses a second account that differs only by case,
    // even from a writer that skips the application's folding.
    let code: string | null = null;
    try {
      await owner.user.create({
        data: { email: emailB.toUpperCase(), password: hash, name: "case", businessId: bodyB.user?.businessId ?? -1 },
        select: { id: true },
      });
    } catch (e) {
      code = (e as { code?: string }).code ?? pgCode(e);
    }
    ok("lower(email) is unique in the database (case variant refused)", code === "P2002", `got ${code}`);
  }

  // 7 — setup for a brand-new business, through the real service: one screen,
  //     answers stored as OWNER_INPUT identity statements, no goal written.
  {
    const { loadSetupState, completeSetup, saveAbout } = await import("@/lib/services/onboarding/setup.service");
    const businessA = bodyA.user?.businessId ?? -1;
    const userA = bodyA.user?.id ?? -1;
    const fresh = await loadSetupState(businessA);
    ok("a new business needs setup, with nothing said yet", fresh.needsSetup === true && fresh.description === null && fresh.audience === null);

    await saveAbout({ businessId: businessA, userId: userA }, { description: "סטודיו קטן לטיפוח ציפורניים" });
    const resumed = await loadSetupState(businessA);
    ok("a saved description resumes (still needs setup)", resumed.needsSetup === true && resumed.description === "סטודיו קטן לטיפוח ציפורניים");

    await saveAbout({ businessId: businessA, userId: userA }, { audience: "BOTH" });
    await saveAbout({ businessId: businessA, userId: userA }, { audience: "INDIVIDUALS" });
    const afterSwitch = await loadSetupState(businessA);
    ok("switching the audience keeps exactly the chosen code", afterSwitch.audience === "INDIVIDUALS");

    const rows = await owner.businessIdentityStatement.findMany({
      where: { businessId: businessA, status: "ACTIVE" },
      select: { dimension: true, code: true, source: true, sourceRef: true, confirmedByUserId: true, publicUseApproved: true },
    });
    ok(
      "answers are OWNER_INPUT statements from setup, confirmed by the owner, never public",
      rows.length === 2 &&
        rows.every((r) => r.source === "OWNER_INPUT" && r.sourceRef === "setup" && r.confirmedByUserId === userA && r.publicUseApproved === false),
      JSON.stringify(rows)
    );

    let refused = false;
    try {
      await saveAbout({ businessId: businessA, userId: userA }, { description: "התקשרו 050-1234567 או www.example.co.il" });
    } catch (e) {
      refused = (e as Error).name === "IdentityInputError";
    }
    ok("contact details in the description are refused by the identity writer", refused);

    await completeSetup(businessA);
    const profile = await owner.businessProfile.findUnique({
      where: { businessId: businessA },
      select: { onboardingCompletedAt: true, onboardingGoal: true, onboardingGoalSource: true, category: true },
    });
    ok("completing stamps the business once", (await loadSetupState(businessA)).needsSetup === false && profile?.onboardingCompletedAt instanceof Date);
    ok("no goal and no category are written", profile?.onboardingGoal === null && profile?.onboardingGoalSource === null && profile?.category === null);
    await completeSetup(businessA);
    const again = await owner.businessProfile.findUnique({ where: { businessId: businessA }, select: { onboardingCompletedAt: true } });
    ok("...and re-completing keeps the first completion time", again?.onboardingCompletedAt?.getTime() === profile?.onboardingCompletedAt?.getTime());
  }

  // 8 — Home history: every flag is a past business event, never "0 today",
  //     and every predicate is pinned to its own business.
  {
    const { loadHomeHistory } = await import("@/lib/services/home/home-history.service");
    const a = bodyA.user?.businessId ?? -1;
    const bId = bodyB.user?.businessId ?? -1;
    const flags = (h: Record<string, unknown>) =>
      Object.entries(h)
        .filter(([k]) => k !== "whatsapp")
        .filter(([, v]) => v === true)
        .map(([k]) => k)
        .sort()
        .join(",");

    const freshB = await loadHomeHistory(bId);
    ok("a brand-new business has no history at all", flags(freshB) === "" && freshB.whatsapp === "NEVER", `got ${flags(freshB)} / ${freshB.whatsapp}`);

    // Activity on business A must never show up as history on B.
    await owner.lead.create({ data: { businessId: a }, select: { id: true } });
    await owner.inventoryItem.create({ data: { businessId: a, name: "לק ג׳ל", unitType: "UNIT" }, select: { id: true } });
    const reqA = await owner.paymentRequest.create({ data: { businessId: a, provider: "TRANZILA", amount: 180, status: "EXPIRED" }, select: { id: true } });
    await owner.paymentTransaction.create({ data: { paymentRequestId: reqA.id, provider: "TRANZILA", amount: 180, status: "PAID" }, select: { id: true } });
    await owner.payment.create({
      data: { businessId: a, payeeNameSnapshot: "ספק", amount: 300, paidAt: new Date(), method: "BANK_TRANSFER" },
      select: { id: true },
    });
    const afterA = await loadHomeHistory(a);
    const stillB = await loadHomeHistory(bId);
    ok(
      "business A's events are history for A",
      afterA.leads && afterA.inventory && afterA.collection && afterA.income && afterA.expenses && afterA.identityDescription,
      flags(afterA)
    );
    ok("...and never for business B (explicit businessId in every predicate)", flags(stillB) === "", `B got ${flags(stillB)}`);
    ok("an EXPIRED payment request still counts as collection history", afterA.collection === true);

    // Documents: only a document that was really received counts.
    await owner.document.create({ data: { businessId: bId, fileUrl: "lab://p", source: "upload", mimeType: "image/png", status: "processing" }, select: { id: true } });
    await owner.document.create({ data: { businessId: bId, fileUrl: "lab://f", source: "upload", mimeType: "image/png", status: "failed" }, select: { id: true } });
    ok("processing / failed uploads are not document history", (await loadHomeHistory(bId)).documents === false);
    await owner.document.create({ data: { businessId: bId, fileUrl: "lab://r", source: "upload", mimeType: "image/png", status: "needs_review" }, select: { id: true } });
    ok("a received document (needs_review) is document history", (await loadHomeHistory(bId)).documents === true);

    // Income: a refund reversal (PAID, negative) is not money in; a VOID payment is not an expense.
    const reqB = await owner.paymentRequest.create({ data: { businessId: bId, provider: "TRANZILA", amount: 90, status: "CANCELLED" }, select: { id: true } });
    await owner.paymentTransaction.create({ data: { paymentRequestId: reqB.id, provider: "TRANZILA", amount: -90, status: "PAID" }, select: { id: true } });
    await owner.payment.create({
      data: { businessId: bId, payeeNameSnapshot: "ספק", amount: 50, paidAt: new Date(), method: "CASH", status: "VOID" },
      select: { id: true },
    });
    const b2 = await loadHomeHistory(bId);
    ok("a refund reversal is not income history", b2.income === false);
    ok("a VOID payment is not expense history", b2.expenses === false);
    ok("a CANCELLED request is still collection history", b2.collection === true);

    // An approved expense document counts as expense history without any Payment.
    const doc = await owner.document.create({ data: { businessId: bId, fileUrl: "lab://e", source: "upload", mimeType: "image/png", status: "approved" }, select: { id: true } });
    await owner.financialRecord.create({
      data: { documentId: doc.id, businessId: bId, amount: 86, date: new Date(), vendorName: "סופר-פארם", direction: "expense", category: "office" },
      select: { id: true },
    });
    ok("an approved expense document is expense history", (await loadHomeHistory(bId)).expenses === true);

    // WhatsApp semantics.
    await owner.whatsAppConnection.create({
      data: {
        businessId: bId,
        status: "REVOKED_BY_META",
        phoneNumberId: "lab",
        displayPhoneNumber: "+972500000000",
        wabaId: "lab",
        accessTokenEncrypted: "x",
        accessTokenIv: "x",
        accessTokenTag: "x",
      },
      select: { id: true },
    });
    ok("REVOKED_BY_META reads as needs-attention, not disconnected", (await loadHomeHistory(bId)).whatsapp === "ATTENTION");
    await owner.whatsAppConnection.update({ where: { businessId: bId }, data: { status: "DISCONNECTED" }, select: { id: true } });
    ok("DISCONNECTED reads as reconnect", (await loadHomeHistory(bId)).whatsapp === "DISCONNECTED");
    await owner.whatsAppConnection.update({ where: { businessId: bId }, data: { status: "CONNECTED" }, select: { id: true } });
    ok("CONNECTED reads as connected", (await loadHomeHistory(bId)).whatsapp === "CONNECTED");

    // The plan: one statement, and no sequential scan of Conversation.
    const { homeHistorySql } = await import("@/lib/services/home/home-history.service");
    const sql = homeHistorySql(bId);
    const plan = (await owner.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN ${sql.text}`,
      ...sql.values
    ))
      .map((r) => r["QUERY PLAN"])
      .join("\n");
    ok("the history plan never touches Conversation", !/Conversation/.test(plan));
  }

  await owner.$disconnect();

  console.log(`\n[auth-plane-write-battery] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("BATTERY ERROR:", e);
  process.exit(1);
});
