/**
 * "Closed Registration / Existing Users Only" — end-to-end against a real
 * database and the real route handlers.
 *
 * Run:
 *   TEST_DATABASE_URL="postgres://…<approved dev/test DB>…" \
 *     npx tsx lib/auth/signup-closed.e2e.test.ts
 *
 * What it proves, with the gate CLOSED:
 *   1. An EXISTING user still logs in and gets a working session token.
 *   2. That session still resolves to the same user + business (nothing broke).
 *   3. A NEW registration through the real API is refused with 403
 *      SIGNUP_DISABLED — and leaves NO User and NO Business row behind.
 * And with the gate OPEN, registration works again with no code change.
 */

// ---------------------------------------------------------------------------
// Database Safety Guard (fail-closed) — MUST run before any DB import/connect.
//
// This test seeds and deletes REAL rows. To make an accidental production
// DATABASE_URL impossible to hit, it refuses to run unless the operator names
// an approved test/dev database in TEST_DATABASE_URL, and forces the Prisma
// singleton onto exactly that URL. No approved target → abort, zero data change.
// (Same guard as lib/services/billing/billing-issue.tenant-isolation.test.ts.)
// ---------------------------------------------------------------------------
const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error(
    "ABORT (DB safety guard): set TEST_DATABASE_URL to an approved, non-production " +
      "test/dev Postgres URL. Refusing to seed/delete against the ambient DATABASE_URL."
  );
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;
if (!process.env.AUTH_TOKEN_SECRET?.trim()) {
  process.env.AUTH_TOKEN_SECRET = "signup-closed-e2e-test-secret";
}

import bcrypt from "bcrypt";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LEGAL_IDENTITY_MIGRATION = fileURLToPath(
  new URL("../../prisma/migrations/20261128090000_signup_legal_identity/migration.sql", import.meta.url)
);

/** Split a migration into top-level statements (dollar quotes, strings and comments respected). */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      cur += "\n";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Signup seeds the legal identity through signup_legal_identity_seed (migration 20261128090000). The security-gate
 * test-db lab builds its schema with `prisma db push`: tables and columns only, none of a migration's functions,
 * triggers or CHECKs. When the function is absent, replay that migration's exact SQL (after dropping the two columns
 * db push already created) so registration runs against the shipped DDL. Where migrations were applied: no-op.
 */
async function ensureLegalIdentityDdl(prisma: {
  $queryRawUnsafe<T>(q: string): Promise<T>;
  $executeRawUnsafe(q: string): Promise<number>;
}): Promise<void> {
  const [{ present }] = await prisma.$queryRawUnsafe<{ present: boolean }[]>(
    `SELECT to_regprocedure('public.signup_legal_identity_seed(integer,text,text,text,text,text,text)') IS NOT NULL AS present`
  );
  if (present) return;
  // The migration REVOKEs from / GRANTs to the application roles; a db-push lab may not have them.
  for (const role of ["app_runtime", "app_auth"]) {
    await prisma.$executeRawUnsafe(
      `DO $r$ BEGIN CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $r$`
    );
  }
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "BusinessProfile" DROP COLUMN IF EXISTS "legalIdentityConfirmedAt", DROP COLUMN IF EXISTS "legalIdentitySource"`
  );
  for (const statement of splitSqlStatements(readFileSync(LEGAL_IDENTITY_MIGRATION, "utf8"))) {
    await prisma.$executeRawUnsafe(statement);
  }
}

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

const RUN = `${Date.now().toString(36)}-${process.pid}`;
const TAG = `signup-gate-e2e-${RUN}`;
const EXISTING_EMAIL = `existing-${RUN}@signup-gate.test`;
const NEW_EMAIL = `newcomer-${RUN}@signup-gate.test`;
const SECOND_EMAIL = `second-${RUN}@signup-gate.test`;
const PASSWORD = "Existing-User-Pass-1";

/** Unique client IP per run so the 3/hour register limiter never interferes. */
const IP = `198.51.100.${(process.pid % 250) + 1}`;

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": IP,
    },
    body: JSON.stringify(body),
  });
}

function setFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.PUBLIC_SIGNUP_ENABLED;
  else process.env.PUBLIC_SIGNUP_ENABLED = value;
}

async function main() {
  // Dynamic imports AFTER the guard, so Prisma binds to TEST_DATABASE_URL.
  const { prisma } = await import("@/lib/prisma");
  const { getCurrentUser, verifyAuthToken } = await import("@/lib/auth");
  const { POST: loginPost } = await import("@/app/api/auth/login/route");
  const { POST: registerPost } = await import("@/app/api/auth/register/route");
  const { GET: meGet } = await import("@/app/api/auth/me/route");
  const { SIGNUP_DISABLED_CODE } = await import("@/lib/auth/signup-gate");

  await ensureLegalIdentityDdl(prisma);

  const createdBusinessIds: number[] = [];

  try {
    // -- Seed one PRE-EXISTING account (as if it registered before the gate) --
    const business = await prisma.business.create({
      data: { name: `${TAG}-existing-business` },
      select: { id: true },
    });
    createdBusinessIds.push(business.id);

    const existing = await prisma.user.create({
      data: {
        email: EXISTING_EMAIL,
        password: await bcrypt.hash(PASSWORD, 10),
        name: "משתמש קיים",
        businessId: business.id,
      },
      select: { id: true, loginCount: true, role: true },
    });

    // ================================================== GATE CLOSED ==========
    setFlag(undefined); // unset == closed (fail-closed default)

    // 1. Existing user logs in normally.
    const loginRes = await loginPost(
      post("https://app.dubiz.test/api/auth/login", {
        email: EXISTING_EMAIL,
        password: PASSWORD,
      })
    );
    const loginBody = await loginRes.json();

    ok("closed: existing user logs in -> 200", loginRes.status === 200);
    ok(
      "closed: login returns a token",
      typeof loginBody.token === "string" && loginBody.token.length > 0
    );
    ok("closed: login returns the right user", loginBody?.user?.email === EXISTING_EMAIL);
    ok("closed: login returns the business", loginBody?.user?.businessId === business.id);

    // 2. The session that login handed out actually works.
    const token: string = loginBody.token;
    ok("closed: token verifies to the same user id", verifyAuthToken(token) === existing.id);

    const sessionUser = await getCurrentUser(
      new Request("https://app.dubiz.test/api/auth/me", {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    ok("closed: session resolves to the user", sessionUser?.id === existing.id);
    ok("closed: session still carries the business", sessionUser?.business?.id === business.id);

    // The session endpoint the app itself calls on every boot must be unaffected.
    const meRes = await meGet(
      new Request("https://app.dubiz.test/api/auth/me", {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    const meBody = await meRes.json();
    ok("closed: GET /api/auth/me -> 200", meRes.status === 200);
    ok("closed: /api/auth/me returns the same user", meBody?.user?.id === existing.id);
    ok("closed: /api/auth/me returns the business", meBody?.user?.businessId === business.id);

    // 3. A brand-new registration through the real API is refused.
    const blockedRes = await registerPost(
      post("https://app.dubiz.test/api/auth/register", {
        email: NEW_EMAIL,
        password: "Newcomer-Pass-1",
        name: "נרשם חדש",
        businessName: `${TAG}-should-never-exist`, businessKind: "AUTHORIZED_DEALER",
        legalName: "דנה כהן", taxId: "000000018", address: "הרצל 1, תל אביב", phone: "0501234567", businessEmail: "biz@lab.invalid",
        acceptTerms: true,
      })
    );
    const blockedBody = await blockedRes.json();

    ok("closed: new registration -> 403", blockedRes.status === 403);
    ok("closed: new registration -> SIGNUP_DISABLED", blockedBody.code === SIGNUP_DISABLED_CODE);
    ok("closed: response is not a 500", blockedRes.status !== 500);

    const leakedUser = await prisma.user.findUnique({ where: { email: NEW_EMAIL } });
    ok("closed: NO User row was created", leakedUser === null);

    const leakedBusiness = await prisma.business.findFirst({
      where: { name: `${TAG}-should-never-exist` },
    });
    ok("closed: NO Business row was created", leakedBusiness === null);

    // 4. The pre-existing account was not touched or disabled by any of this.
    const stillThere = await prisma.user.findUnique({
      where: { email: EXISTING_EMAIL },
      select: { id: true, businessId: true, loginCount: true, role: true },
    });
    ok("closed: existing user still exists", stillThere?.id === existing.id);
    ok("closed: existing user keeps its business", stillThere?.businessId === business.id);
    ok("closed: existing user's role is unchanged", stillThere?.role === existing.role);
    ok(
      "closed: existing login was recorded normally",
      (stillThere?.loginCount ?? 0) > existing.loginCount
    );

    // ================================================== GATE OPEN ============
    setFlag("true");

    const openRes = await registerPost(
      post("https://app.dubiz.test/api/auth/register", {
        email: NEW_EMAIL,
        password: "Newcomer-Pass-1",
        name: "נרשם חדש",
        businessName: `${TAG}-newcomer-business`, businessKind: "AUTHORIZED_DEALER",
        legalName: "דנה כהן", taxId: "000000018", address: "הרצל 1, תל אביב", phone: "0501234567", businessEmail: "biz@lab.invalid",
        // Signup requires accepting the terms (M1); the gate is what is tested.
        acceptTerms: true,
      })
    );
    const openBody = await openRes.json();

    ok("open: registration works again -> 200", openRes.status === 200);
    ok("open: a User was created", typeof openBody.userId === "number");
    ok("open: a Business was created", typeof openBody.businessId === "number");
    if (typeof openBody.businessId === "number") {
      createdBusinessIds.push(openBody.businessId);
    }

    const newLogin = await loginPost(
      post("https://app.dubiz.test/api/auth/login", {
        email: NEW_EMAIL,
        password: "Newcomer-Pass-1",
      })
    );
    ok("open: the new account can log in", newLogin.status === 200);

    // Flip back: closing it again immediately re-blocks, no restart needed.
    setFlag("false");
    const reBlocked = await registerPost(
      post("https://app.dubiz.test/api/auth/register", {
        email: SECOND_EMAIL,
        password: "Newcomer-Pass-2",
        name: "נרשם נוסף",
        businessName: `${TAG}-second-should-never-exist`, businessKind: "AUTHORIZED_DEALER",
        legalName: "דנה כהן", taxId: "000000018", address: "הרצל 1, תל אביב", phone: "0501234567", businessEmail: "biz@lab.invalid",
        acceptTerms: true,
      })
    );
    ok("reversible: closing again re-blocks -> 403", reBlocked.status === 403);
    ok(
      "reversible: still nothing created",
      (await prisma.user.findUnique({ where: { email: SECOND_EMAIL } })) === null
    );
  } finally {
    setFlag(undefined);
    // Delete only what this run made; Business cascade removes its Users.
    await prisma.user
      .deleteMany({ where: { email: { in: [EXISTING_EMAIL, NEW_EMAIL, SECOND_EMAIL] } } })
      .catch(() => {});
    for (const id of createdBusinessIds) {
      await prisma.business.delete({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
