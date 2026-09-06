/**
 * D2 / AUTH BOUNDARY STAGE B — signup through the real implementation.
 *
 * Public signup is frozen and stays frozen. This calls the SAME `createAccount`
 * the register route calls, with `AUTH_PLANE_ENABLED=true` and the Preview auth
 * credential, so the code path, the transaction and the database identity are
 * the real ones — only the HTTP entrypoint is absent.
 *
 * Rewriting the insert by hand would have proven nothing about signup: the
 * property under test is that the product's own bootstrap transaction works
 * under an identity that cannot UPDATE Business and cannot DELETE anything.
 *
 * The password hash is written and never read back or printed. Synthetic
 * Preview data only; the rows are removed afterwards through the owner path,
 * because the auth identity deliberately cannot delete them.
 */
import { readFileSync } from "node:fs";

process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = readFileSync(process.env.AUTH_URL_FILE, "utf8").trim();

const { createAccount, hashSignupPassword } = await import("../lib/auth/signup.ts");
const { authDb, authPlaneMode } = await import("../lib/prisma-auth.ts");

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const TAG = process.env.STAGEB_STAMP ?? `h${Date.now()}`;
const email = `${TAG}@example.invalid`;
const PASSWORD = "StageB!Rehearsal9";

console.log("== signup through the product's own bootstrap ==");
ok("harness runs with the auth plane ACTIVE", authPlaneMode() === "active");

const who = await authDb().$queryRawUnsafe(`SELECT current_user::text u`);
console.log(`  identity: ${who[0].u}`);
ok("createAccount will run as the restricted auth identity",
  who[0].u === "app_auth_prev_rehearsal", who[0].u);

const hash = await hashSignupPassword(PASSWORD);
ok("password is hashed before it reaches the database", hash !== PASSWORD && hash.length > 20);

let account = null;
try {
  account = await createAccount({
    email,
    passwordHash: hash,
    name: `Stage B ${TAG}`,
    businessName: `Stage B Tenant ${TAG}`,
  });
  ok("createAccount succeeded under the auth identity", true);
} catch (e) {
  ok("createAccount succeeded under the auth identity", false,
    String(e?.message ?? e).split("\n").slice(-2).join(" ").slice(0, 220));
}

if (account) {
  // The function returned. That is not evidence — read both rows back.
  const rows = await authDb().$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "Business" WHERE id=$1) b,
            (SELECT count(*)::int FROM "User" WHERE "businessId"=$1) u,
            (SELECT count(*)::int FROM "User" WHERE email=$2 AND password IS NOT NULL) hashed`,
    account.businessId, email);
  ok("Business row persisted", rows[0].b === 1, JSON.stringify(rows[0]));
  ok("User row persisted and carries a stored hash", rows[0].u === 1 && rows[0].hashed === 1,
    JSON.stringify(rows[0]));
  ok("ids came from the sequences through the auth role",
    Number.isInteger(account.businessId) && Number.isInteger(account.userId));
  console.log(`  created businessId=${account.businessId} userId=${account.userId} (credentials not printed)`);
}

// ---- atomicity: the second write failing must leave no Business behind ------
console.log("\n== atomicity: a failing User insert must roll the Business back ==");
const beforeCount = (await authDb().$queryRawUnsafe(
  `SELECT count(*)::int n FROM "Business" WHERE name LIKE $1`, `Stage B Atomic ${TAG}%`))[0].n;
let duplicateRejected = false;
try {
  // Same email as the account above. User.email is unique, so the User insert
  // fails INSIDE the transaction that has already created the Business — the
  // real failure mode, triggered by the product's own constraint rather than a
  // simulated error.
  await createAccount({
    email,
    passwordHash: hash,
    name: `Stage B Atomic ${TAG}`,
    businessName: `Stage B Atomic ${TAG}`,
  });
} catch {
  duplicateRejected = true;
}
ok("the duplicate signup was rejected (no false success)", duplicateRejected);
const afterCount = (await authDb().$queryRawUnsafe(
  `SELECT count(*)::int n FROM "Business" WHERE name LIKE $1`, `Stage B Atomic ${TAG}%`))[0].n;
ok("no orphaned Business remains from the failed signup",
  afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);

// ---- the identity's limits still hold from inside the app's own client -----
console.log("\n== the auth identity's limits, via the same client ==");
async function refused(fn) {
  try { await fn(); return null; } catch (e) { return String(e?.message ?? e); }
}
const denied = (m) => m !== null && /permission denied/i.test(m);
ok("UPDATE on Business is refused (signup needs none)",
  denied(await refused(() => authDb().$executeRawUnsafe(
    `UPDATE "Business" SET name=name WHERE id=-1`))));
ok("DELETE on User is refused",
  denied(await refused(() => authDb().$executeRawUnsafe(`DELETE FROM "User" WHERE id=-1`))));
ok("DELETE on Business is refused",
  denied(await refused(() => authDb().$executeRawUnsafe(`DELETE FROM "Business" WHERE id=-1`))));

console.log(`\n[signup-harness] PASS=${pass} FAIL=${fail}`);
console.log(`[signup-harness] LOGIN_EMAIL=${email}`);
await authDb().$disconnect();
process.exit(fail > 0 ? 1 : 0);
