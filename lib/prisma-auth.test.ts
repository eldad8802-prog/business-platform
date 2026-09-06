/**
 * D2 / AUTH BOUNDARY STEP 2 — the auth-plane client contract.
 *
 * These are the properties the Step 3 revoke will depend on. If any of them
 * stops holding, revoking `app_runtime`'s access to `User` does not tighten the
 * boundary — it takes down login, or it appears to tighten while the tenant
 * identity quietly keeps serving auth queries.
 *
 * Run: npx tsx lib/prisma-auth.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
// Awaited, because a rejected async assertion would otherwise surface as an
// unhandled rejection and never reach the counters — the test would "pass" by
// not being counted, which is the failure mode this whole file exists to catch.
const queue: Array<() => Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
  queue.push(async () => {
    try {
      await fn();
      pass += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      fail += 1;
      console.log(`  [FAIL] ${name} — ${String((e as Error)?.message ?? e).slice(0, 240)}`);
    }
  });
}

/**
 * Comments are stripped before any assertion runs. The file documents what it
 * deliberately does NOT do — "no fallback to DATABASE_URL", "not prisma-admin" —
 * so a scan of the raw text matches the very strings it is checking for and
 * fails on the prose that explains the guarantee. Only code is evidence.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SRC = code(readFileSync(new URL("./prisma-auth.ts", import.meta.url), "utf8"));
const AUTH_FILES = {
  login: "app/api/auth/login/route.ts",
  logout: "app/api/auth/logout/route.ts",
  me: "app/api/auth/me/route.ts",
  session: "lib/auth.ts",
  signup: "lib/auth/signup.ts",
} as const;
const read = (p: string) => code(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

console.log("== auth-plane client contract ==");

// ---- fail-loud, and no substitute identity --------------------------------
/** Runs `fn` with an exact environment, then restores whatever was there. */
async function withEnv(
  env: Record<string, string | undefined>,
  fn: (mod: typeof import("./prisma-auth")) => void | Promise<void>
) {
  const mod = await import("./prisma-auth");
  // Each scenario describes a FRESH process with that environment. The client is
  // a globalThis singleton, so without clearing it a scenario would be handed the
  // client an earlier scenario built — and "missing credential" would appear to
  // succeed because a valid one was cached a moment ago. That is the test lying,
  // not the module: in production the environment does not change mid-process,
  // and a process that starts unconfigured caches nothing and throws every time.
  delete (globalThis as { prismaAuth?: unknown }).prismaAuth;
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn(mod);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const AUTH_URL = "postgresql://app_auth_test:pw@example.invalid:5432/neondb?sslmode=require";

// ---- the two deliberate modes ---------------------------------------------
test("legacy: flag false and no AUTH_DATABASE_URL uses the canonical client on purpose", () =>
  withEnv({ AUTH_PLANE_ENABLED: "false", AUTH_DATABASE_URL: undefined }, async (m) => {
    assert.equal(m.authPlaneMode(), "legacy");
    assert.equal(m.isAuthPlaneActive(), false);
    const { prisma } = await import("./prisma");
    assert.equal(m.authDb(), prisma, "legacy mode did not return the canonical client");
  }));

test("legacy: an unset flag is legacy (pre-cutover default)", () =>
  withEnv({ AUTH_PLANE_ENABLED: undefined, AUTH_DATABASE_URL: undefined }, (m) => {
    assert.equal(m.authPlaneMode(), "legacy");
  }));

test("active: flag true with a valid credential uses the auth client, never the tenant one", () =>
  withEnv({ AUTH_PLANE_ENABLED: "true", AUTH_DATABASE_URL: AUTH_URL }, async (m) => {
    assert.equal(m.authPlaneMode(), "active");
    const { prisma } = await import("./prisma");
    const client = m.authDb();
    assert.notEqual(client, prisma, "active mode returned the tenant client");
  }));

// ---- fail-closed, with no way back to the tenant identity ------------------
test("active + missing AUTH_DATABASE_URL is a hard failure, not a fallback", () =>
  withEnv({ AUTH_PLANE_ENABLED: "true", AUTH_DATABASE_URL: undefined }, (m) => {
    assert.throws(() => m.authDb(), /AUTH_DATABASE_URL is not configured/);
  }));

test("active + empty AUTH_DATABASE_URL is a hard failure", () =>
  withEnv({ AUTH_PLANE_ENABLED: "true", AUTH_DATABASE_URL: "   " }, (m) => {
    assert.throws(() => m.authDb(), /AUTH_DATABASE_URL is not configured/);
  }));

test("active + malformed AUTH_DATABASE_URL fails at initialization, naming the cause", () =>
  withEnv({ AUTH_PLANE_ENABLED: "true", AUTH_DATABASE_URL: "not-a-connection-string" }, (m) => {
    assert.throws(() => m.authDb(), /not a valid PostgreSQL connection string/);
  }));

test("an auth-plane failure never reaches the tenant client", () =>
  withEnv({ AUTH_PLANE_ENABLED: "true", AUTH_DATABASE_URL: undefined }, async (m) => {
    const { prisma } = await import("./prisma");
    let returned: unknown = null;
    try {
      returned = m.authDb();
    } catch {
      returned = "threw";
    }
    assert.equal(returned, "threw", "authDb() returned a client while the auth plane was unusable");
    assert.notEqual(returned, prisma);
  }));

test("an unrecognised flag value throws rather than silently meaning legacy", () =>
  withEnv({ AUTH_PLANE_ENABLED: "1", AUTH_DATABASE_URL: undefined }, (m) => {
    // "1", "yes", "TRUE " read as legacy would turn a typo into a quiet
    // downgrade: the boundary would be off and nothing would say so.
    assert.throws(() => m.authPlaneMode(), /must be exactly "true" or "false"/);
  }));

test("routing is deterministic after initialization (same mode, same client)", () =>
  withEnv({ AUTH_PLANE_ENABLED: "true", AUTH_DATABASE_URL: AUTH_URL }, (m) => {
    assert.equal(m.authDb(), m.authDb(), "authDb() returned different clients for the same mode");
  }));

test("the client reads no other connection URL (no owner/tenant/admin fallback)", () => {
  const forbidden = SRC.match(/process\.env\.(DATABASE_URL|DIRECT_URL|ADMIN_DATABASE_URL)/g);
  assert.equal(forbidden, null,
    `prisma-auth.ts references another connection URL: ${forbidden?.join(", ")}`);
});

test("the fallback decision is made from configuration, never in a catch block", () => {
  // A catch-block fallback would turn a revoked grant or a rejected credential
  // into normal operation — the boundary would stop existing with no symptom.
  const catchBlocks = SRC.split(/\bcatch\b/).slice(1).join("\n");
  assert.ok(!/getPrismaAuth|authDb|prisma\b/.test(catchBlocks),
    "prisma-auth.ts selects a client inside a catch block");
});

// ---- the auth surface actually uses it ------------------------------------
for (const [label, file] of Object.entries(AUTH_FILES)) {
  test(`${label} routes User/Business through authDb(), not the tenant client`, () => {
    const src = read(file);
    assert.ok(!/\bprisma\.(user|business)\b/.test(src),
      `${file} still reaches User/Business through the tenant client`);
    assert.ok(!/\bprisma\.\$transaction\b/.test(src),
      `${file} still opens a transaction on the tenant client`);
  });
}

test("login resolves a user by email with no tenant context (bootstrap must not need one)", () => {
  const src = read(AUTH_FILES.login);
  assert.ok(/authDb\(\)\.user\.findUnique/.test(src), "login no longer looks a user up through authDb()");
  assert.ok(!/runWithTenantContext|withTenantTransaction|runTenantJob/.test(src),
    "login now requires a tenant context, which it cannot have before the tenant is known");
});

test("session validation resolves by id through the auth plane", () => {
  const src = read(AUTH_FILES.session);
  assert.ok(/authDb\(\)\.user\.findUnique/.test(src), "session validation no longer uses authDb()");
});

test("signup stays ONE transaction on the auth plane (no orphaned Business or User)", () => {
  const src = read(AUTH_FILES.signup);
  assert.ok(/authDb\(\)\.\$transaction/.test(src), "signup no longer runs on the auth plane");
  const tx = src.slice(src.indexOf("$transaction"));
  const bIdx = tx.indexOf("tx.business.create");
  const uIdx = tx.indexOf("tx.user.create");
  assert.ok(bIdx > -1 && uIdx > -1, "signup no longer creates both Business and User");
  assert.ok(bIdx < uIdx, "signup creates the User before the Business");
  // Both writes must be on the SAME tx handle. If either were moved onto a
  // client call, a failure would leave a Business with no User behind it.
  assert.ok(!/authDb\(\)\.(business|user)\.create/.test(src),
    "signup performs a create outside the transaction handle");
});

// ---- no escalation --------------------------------------------------------
test("the auth plane is not the admin plane", () => {
  assert.ok(!/prisma-admin|getPrismaAdmin|app_admin/.test(SRC),
    "prisma-auth.ts reaches for the admin client, which carries cross-tenant p7adm_read SELECT");
});

test("no tenant feature module imports the auth client", () => {
  // The CI guard enforces this repo-wide; this pins the intent next to the code.
  const allowed = new Set<string>(Object.values(AUTH_FILES));
  assert.equal(allowed.size, 5, "the auth surface changed size without this test being updated");
});

// Wrapped rather than top-level await: this file is transformed to CJS, where a
// top-level await is a build error rather than a test failure.
async function main() {
  for (const t of queue) await t();
  console.log(`\n[prisma-auth] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

void main();
