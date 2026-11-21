/**
 * D2 / AUTH BOUNDARY STAGE B — what happens when the auth plane cannot be used.
 *
 * The dangerous outcome is not an error. It is a request that succeeds anyway,
 * because something quietly reconnected as the tenant identity and the boundary
 * stopped existing with nothing to show for it. So these run the product's own
 * signup against a deliberately unusable auth credential and assert three
 * separate things: that it failed, that nothing was written, and that no
 * connection was opened under the tenant role while it happened.
 *
 * Preview only. No Production credential is referenced.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const owner = new PrismaClient({ datasourceUrl: readFileSync(process.env.OWNER_URL_FILE, "utf8").trim() });
const TAG = `fs${Date.now()}`;

/** Connections currently open under a given role, observed from the owner side. */
async function connectionsAs(role) {
  const r = await owner.$queryRawUnsafe(
    `SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname='neondb' AND usename = $1`, role);
  return r[0].n;
}

async function main() {
  console.log("== auth plane ACTIVE with an unusable credential ==");

  // Valid shape, unreachable host: the plane is configured, so the mode is
  // active and the module must not look elsewhere — it must simply fail.
  process.env.AUTH_PLANE_ENABLED = "true";
  process.env.AUTH_DATABASE_URL =
    "postgresql://app_auth_prev_rehearsal:wrong@unreachable-host.invalid:5432/neondb?sslmode=require";

  const { createAccount, hashSignupPassword } = await import("../lib/auth/signup.ts");
  const { authDb, authPlaneMode } = await import("../lib/prisma-auth.ts");
  const { prisma } = await import("../lib/prisma.ts");

  ok("the mode is ACTIVE, so no legacy behaviour is expected", authPlaneMode() === "active");
  ok("authDb() does NOT return the tenant client while active", authDb() !== prisma);

  const runtimeBefore = await connectionsAs("app_runtime");
  const hash = await hashSignupPassword("StageB!Rehearsal9");

  let threw = null;
  try {
    await createAccount({
      email: `${TAG}@example.invalid`,
      passwordHash: hash,
      name: `${TAG}`,
      businessName: `${TAG}-biz`,
    });
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  ok("signup FAILED rather than succeeding through another identity", threw !== null,
    "createAccount returned success while the auth plane was unusable");
  if (threw) console.log(`     failure: ${threw.split("\n").filter(Boolean)[0].slice(0, 110)}`);

  // The decisive check. A fallback would have written the rows.
  const rows = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "User" WHERE email=$1) u,
            (SELECT count(*)::int FROM "Business" WHERE name=$2) b`,
    `${TAG}@example.invalid`, `${TAG}-biz`);
  ok("nothing was written — no retry succeeded through DATABASE_URL",
    rows[0].u === 0 && rows[0].b === 0, JSON.stringify(rows[0]));

  const runtimeAfter = await connectionsAs("app_runtime");
  ok("no new connection was opened under app_runtime during the failure",
    runtimeAfter <= runtimeBefore, `before=${runtimeBefore} after=${runtimeAfter}`);

  // ---- a missing credential in ACTIVE mode ---------------------------------
  console.log("\n== auth plane ACTIVE with NO credential ==");
  delete process.env.AUTH_DATABASE_URL;
  delete globalThis.prismaAuth;
  let missingThrew = null;
  try { authDb(); } catch (e) { missingThrew = String(e?.message ?? e); }
  ok("a missing credential throws instead of returning any client", missingThrew !== null);
  ok("the error names the cause rather than reading as an outage",
    /AUTH_DATABASE_URL is not configured/.test(missingThrew ?? ""), (missingThrew ?? "").slice(0, 120));

  console.log(`\n[failure-semantics] PASS=${pass} FAIL=${fail}`);
  await owner.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", String(e?.message ?? e).slice(0, 300));
  await owner.$disconnect().catch(() => {});
  process.exit(1);
});
