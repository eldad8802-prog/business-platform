/**
 * D2 / STAGE E2 — what the auth and runtime paths are allowed to read.
 *
 * Stage E3 narrows `app_runtime` and `app_auth` from table-level privileges to
 * column-level ones. That narrowing is only safe while every query names its
 * columns: under PostgreSQL, a table-level SELECT cannot be partially revoked,
 * so the grant can only be tightened once nothing depends on the default
 * all-scalars selection. These tests hold that property in place.
 *
 * The `password` assertions are the point of the exercise. Session resolution
 * runs on every authenticated request and used to load the hash for no reason,
 * simply because `include` selects all scalars. Asserting on the response shape
 * would not have caught it — the route already returned five fields. What
 * matters is which columns leave the database, so these read the query itself.
 *
 * Run: npx tsx lib/auth/select-contract.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  [FAIL] ${name} — ${String((e as Error)?.message ?? e).slice(0, 240)}`);
  }
}

/** Comments stripped: these files explain what they deliberately do not select,
 *  and a raw scan matches the prose rather than the query. */
const read = (p: string) =>
  readFileSync(new URL(`../../${p}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const LOGIN = read("app/api/auth/login/route.ts");
const SESSION = read("lib/auth.ts");
const ME = read("app/api/auth/me/route.ts");
const LOGOUT = read("app/api/auth/logout/route.ts");
const SIGNUP = read("lib/auth/signup.ts");
const UNIFORM = read("lib/services/billing/uniform/uniform-export-loader.ts");

/** The model reads in a file, as `model.operation` pairs. */
function modelReads(src: string, model: "user" | "business"): string[] {
  return src.match(
    new RegExp(`\\.${model}\\.(findUnique|findFirst|findMany|count|aggregate)`, "g")
  ) ?? [];
}

console.log("== D2 Stage E2: explicit-select contract ==");

// ---- no read may fall back to all-scalars selection -------------------------
for (const [label, src] of [
  ["login", LOGIN], ["session resolution", SESSION], ["/api/auth/me", ME],
  ["uniform export", UNIFORM],
] as const) {
  test(`${label}: every User/Business read names its columns`, () => {
    const reads = [...modelReads(src, "user"), ...modelReads(src, "business")];
    if (reads.length === 0) return;
    // `include: { business: true }` is the shape that pulls all scalars of both
    // sides. A nested `select` inside a relation is fine and is not this.
    assert.ok(!/include:\s*\{\s*business:\s*true/.test(src),
      `${label} still uses include: { business: true }, which selects every scalar`);
    assert.ok(!/include:\s*\{\s*profile:\s*true/.test(src),
      `${label} still uses include: { profile: true }`);
  });
}

// ---- the password column, path by path -------------------------------------
test("login DOES select password (bcrypt needs the hash)", () => {
  assert.ok(/password:\s*true/.test(LOGIN), "login no longer selects password — it cannot verify a credential");
  assert.ok(/bcrypt\.compare/.test(LOGIN), "login no longer compares the hash");
});

test("session resolution does NOT select password", () => {
  assert.ok(!/password:\s*true/.test(SESSION),
    "lib/auth.ts selects password; it runs on every authenticated request and never reads it");
});

test("/api/auth/me does NOT select password", () => {
  assert.ok(!/password:\s*true/.test(ME), "/api/auth/me selects password and does not use it");
});

test("logout does not read User at all", () => {
  assert.equal(modelReads(LOGOUT, "user").length, 0,
    "logout performs a User read; it only needs to increment tokenVersion");
});

// ---- the semantics the selects must not have broken -------------------------
test("session resolution still selects the lifecycle gate's inputs", () => {
  // Checking deletedAt alone left the whole quarantine window authenticated,
  // so deletionRequestedAt is load-bearing, not decorative.
  assert.ok(/deletionRequestedAt:\s*true/.test(SESSION), "the quarantine window would stop being gated");
  assert.ok(/deletedAt:\s*true/.test(SESSION));
  assert.ok(/acceptsNormalWrites/.test(SESSION), "the lifecycle gate is gone");
});

test("session resolution still selects tokenVersion (revocation boundary)", () => {
  assert.ok(/tokenVersion:\s*true/.test(SESSION), "session revocation would stop working");
  assert.ok(/verified\.tokenVersion !== user\.tokenVersion/.test(SESSION), "the generation check is gone");
});

test("session resolution selects the fields callers read off it", () => {
  // /api/home reads user.business.id and .name; other callers read id, email,
  // name, businessId and role.
  for (const f of ["id: true", "email: true", "name: true", "businessId: true", "role: true"]) {
    assert.ok(SESSION.includes(f), `session select is missing ${f}`);
  }
});

test("login still selects everything its response and token need", () => {
  for (const f of ["id: true", "email: true", "name: true", "businessId: true", "tokenVersion: true"]) {
    assert.ok(LOGIN.includes(f), `login select is missing ${f}`);
  }
  assert.ok(/business:\s*\{\s*select:\s*\{\s*name:\s*true/.test(LOGIN),
    "login no longer resolves the business name it returns");
});

test("both login lookups share one select (the fallback cannot drift)", () => {
  const uses = LOGIN.match(/select:\s*LOGIN_USER_SELECT/g) ?? [];
  assert.equal(uses.length, 2, `expected both lookups to use the shared select, found ${uses.length}`);
});

// ---- writes: unchanged, and still the minimum ------------------------------
test("signup still creates Business and User in one transaction on the auth plane", () => {
  assert.ok(/authDb\(\)\.\$transaction/.test(SIGNUP));
  const tx = SIGNUP.slice(SIGNUP.indexOf("$transaction"));
  assert.ok(tx.indexOf("tx.business.create") < tx.indexOf("tx.user.create"),
    "the Business is no longer created before the User");
});

test("logout writes only tokenVersion", () => {
  const data = LOGOUT.match(/data:\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.ok(/tokenVersion/.test(data), "logout no longer increments tokenVersion");
  for (const forbidden of ["password", "email", "role", "businessId"]) {
    assert.ok(!data.includes(forbidden), `logout writes ${forbidden}`);
  }
});

test("login writes only the login counters", () => {
  const update = LOGIN.slice(LOGIN.indexOf("user.update"));
  const data = update.match(/data:\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.ok(/lastLoginAt/.test(data) && /loginCount/.test(data));
  for (const forbidden of ["password:", "email:", "role:", "businessId:"]) {
    assert.ok(!data.includes(forbidden), `login writes ${forbidden}`);
  }
});

console.log(`\n[select-contract] PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
