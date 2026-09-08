/**
 * PERSISTENT LOGIN — the shipped migration is the reviewed SQL.
 *
 * `.auth-session-privileges/correction.sql` is what was audited and what was
 * executed against Production by hand. This migration is what will run against
 * every other environment. Two files holding the same intent drift, and the
 * drift is invisible: the review still passes, because the reviewed file is
 * still correct — it just is no longer the one that runs.
 *
 * So the statements are compared, not the prose.
 *
 * WHY THIS CANNOT BE THE E4 TEST VERBATIM
 *
 * The E4 migration is ungated, so its statements sit at the top level and a
 * flat comparison works. This one must run on databases that have neither role,
 * so every statement lives inside a `DO $do$ ... $do$` guard. A flat comparison
 * would see two opaque DO statements and prove nothing at all. The guard bodies
 * are therefore parsed and the statements inside them compared — which is also
 * what makes "is anything ungated?" a question worth asking below.
 *
 * Run: npx tsx prisma/migrations/20260908200000_auth_session_privilege_contract/equivalence.test.ts
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
    console.log(`  [FAIL] ${name} — ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  }
}

const REVIEWED = new URL("../../../.auth-session-privileges/correction.sql", import.meta.url);
const SHIPPED = new URL("./migration.sql", import.meta.url);

const TABLES = ['"AuthSession"', '"AuthSessionSecret"'];
const GROUP_ROLES = ["app_runtime", "app_auth"];

/** Comments carry no privilege; whitespace differences are not changes. Nothing
 *  else is normalised, so a different column, role, table or privilege keyword
 *  still registers. */
const decomment = (s: string) =>
  s.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");

const split = (s: string) =>
  s.split(";").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).map((x) => x + ";");

const reviewedRaw = decomment(readFileSync(REVIEWED, "utf8"));
const shippedRaw = decomment(readFileSync(SHIPPED, "utf8"));

const TRANSACTION_WRAPPERS = new Set(["BEGIN;", "COMMIT;"]);
const reviewed = split(reviewedRaw).filter((s) => !TRANSACTION_WRAPPERS.has(s.toUpperCase()));

/**
 * The guarded blocks, and the statements inside each.
 *
 * The scaffolding is removed by shape rather than by line number: the DO/`$do$`
 * delimiters, the PL/pgSQL BEGIN and END, and the `IF EXISTS (...) THEN` /
 * `END IF` pair. What is left is the SQL the block would execute.
 */
function guardedBlocks(src: string): { role: string; statements: string[] }[] {
  const bodies = [...src.matchAll(/DO\s+\$do\$([\s\S]*?)\$do\$\s*;/g)].map((m) => m[1]);
  return bodies.map((body) => {
    const role = body.match(/rolname\s*=\s*'([a-z_]+)'/i)?.[1] ?? "(ungated)";
    const inner = body
      .replace(/^\s*BEGIN\b/i, "")
      .replace(/IF\s+EXISTS\s*\((?:[^()]|\([^()]*\))*\)\s*THEN/i, "")
      .replace(/END\s+IF\s*;/i, "")
      .replace(/\bEND\s*$/i, "");
    return { role, statements: split(inner) };
  });
}

const blocks = guardedBlocks(shippedRaw);
const shipped = blocks.flatMap((b) => b.statements);

console.log("== persistent login: reviewed SQL vs shipped migration ==");

test("the migration carries no explicit transaction wrapper", () => {
  // Prisma runs each migration inside its own transaction. A nested COMMIT would
  // close it early and turn all-or-nothing into half-applied.
  const found = split(shippedRaw).filter((s) => TRANSACTION_WRAPPERS.has(s.toUpperCase()));
  assert.deepEqual(found, [], `would close Prisma's own transaction early: ${found.join(" ")}`);
});

test("the reviewed artifact still has its wrappers (it is read standalone)", () => {
  const found = split(reviewedRaw).filter((s) => TRANSACTION_WRAPPERS.has(s.toUpperCase()));
  assert.deepEqual(found.map((s) => s.toUpperCase()), ["BEGIN;", "COMMIT;"]);
});

test("statement lists are identical once wrappers and guards are set aside", () => {
  assert.deepEqual(shipped, reviewed,
    "the shipped migration and the reviewed artifact have diverged");
});

test("every privilege statement is inside a role guard", () => {
  // The failure this prevents is a statement drifting outside the guard, where it
  // runs unconditionally and raises 42704 on a database without that role.
  const outside = split(shippedRaw.replace(/DO\s+\$do\$[\s\S]*?\$do\$\s*;/g, ""))
    .filter((s) => /^(GRANT|REVOKE)\b/i.test(s));
  assert.deepEqual(outside, [], `ungated privilege statement: ${outside.join(" ")}`);
});

test("there are exactly two guards, one per group role", () => {
  assert.equal(blocks.length, 2, `expected 2 guarded blocks, found ${blocks.length}`);
  assert.deepEqual(blocks.map((b) => b.role), GROUP_ROLES,
    "the guards do not gate on app_runtime then app_auth");
});

test("each guard only touches the role it gates on", () => {
  for (const b of blocks) {
    for (const s of b.statements) {
      const named = [...s.matchAll(/\b(?:TO|FROM)\s+(\w+)/gi)].map((m) => m[1]);
      for (const r of named) {
        assert.equal(r, b.role,
          `the ${b.role} guard touches ${r}, which would run unguarded for that role`);
      }
    }
  }
});

test("no environment-specific login role is named anywhere", () => {
  // Naming app_runtime_prod, app_auth_prod or a preview role would bind the
  // migration history to one environment. Membership resolves it instead.
  const named = shipped.flatMap((s) => [...s.matchAll(/\b(?:TO|FROM)\s+(\w+)/gi)].map((m) => m[1]));
  for (const r of named) {
    assert.ok(GROUP_ROLES.includes(r), `the migration names a non-group role: ${r}`);
  }
  assert.ok(named.length > 0, "the migration names no roles at all");
  assert.ok(!/app_(runtime|auth|admin)_\w+/i.test(shippedRaw),
    "an environment-specific role name appears in the migration");
});

test("the migration changes privileges and nothing else", () => {
  for (const s of shipped) {
    assert.match(s, /^(GRANT|REVOKE)\b/i, `a non-privilege statement is in a guard: ${s.slice(0, 90)}`);
  }
  const forbidden =
    /\b(CREATE|DROP|ALTER|TRUNCATE\s+TABLE|INSERT\s+INTO|DELETE\s+FROM|ROW LEVEL SECURITY|POLICY|DEFAULT PRIVILEGES)\b/i;
  for (const s of shipped) {
    assert.ok(!forbidden.test(s.replace(/^(GRANT|REVOKE)[^;]*?\bON\b/i, "")),
      `the migration does more than change privileges: ${s.slice(0, 90)}`);
  }
});

test("it touches only the two persistent-login tables", () => {
  for (const s of shipped) {
    const on = s.split(/\bON\b/i)[1] ?? "";
    assert.ok(TABLES.some((t) => on.includes(t)),
      `a statement targets something else: ${s.slice(0, 90)}`);
  }
});

test("no sequence privilege is granted", () => {
  // Both primary keys are UUID; neither table has a sequence. A sequence grant
  // here would mean the key type changed underneath this contract.
  for (const s of shipped) {
    assert.ok(!/\bON\s+SEQUENCE\b/i.test(s), `a sequence privilege appears: ${s.slice(0, 90)}`);
  }
});

test("app_runtime is granted nothing, only revoked", () => {
  for (const s of shipped) {
    if (/\bTO\s+app_runtime\b/i.test(s)) {
      assert.fail(`the tenant plane is granted something: ${s.slice(0, 90)}`);
    }
  }
  const revokes = shipped.filter((s) => /^REVOKE\b/i.test(s) && /\bFROM\s+app_runtime\b/i.test(s));
  assert.equal(revokes.length, 2, "app_runtime is not revoked on both tables");
  for (const t of TABLES) {
    assert.ok(revokes.some((s) => s.includes(t)), `app_runtime keeps privileges on ${t}`);
  }
});

test("the withheld AuthSession columns are never granted UPDATE", () => {
  // These three are the design's load-bearing columns: the 90-day ceiling, the
  // global logout switch, and which account a session belongs to. createdAt and
  // id have no writer.
  const withheld = ["absoluteExpiresAt", "tokenVersionAtIssue", "userId", "createdAt", "id"];
  const updates = shipped.filter((s) => /^GRANT\s+UPDATE\b/i.test(s));
  for (const s of updates) {
    const cols = s.split(/\bON\b/i)[0];
    for (const c of withheld) {
      assert.ok(!cols.includes(`"${c}"`),
        `UPDATE is granted on the withheld column ${c}: ${s.slice(0, 110)}`);
    }
  }
});

test("AuthSession UPDATE is granted on exactly the five rotation/revocation columns", () => {
  const s = shipped.find((x) => /^GRANT\s+UPDATE\b/i.test(x) && x.includes('"AuthSession"'));
  assert.ok(s, "no UPDATE grant on AuthSession");
  const cols = [...(s as string).split(/\bON\b/i)[0].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(cols.sort(),
    ["idleExpiresAt", "lastUsedAt", "revokedAt", "revokedReason", "secretHash"].sort());
});

test("AuthSessionSecret is never granted UPDATE, at table level or by column", () => {
  // A rotation record is written once with graceUntil already final. Withholding
  // UPDATE is what makes that deadline unforgeable after the fact.
  for (const s of shipped) {
    if (/^GRANT\b/i.test(s) && s.includes('"AuthSessionSecret"')) {
      assert.ok(!/\bUPDATE\b/i.test(s.split(/\bON\b/i)[0]),
        `UPDATE is granted on AuthSessionSecret: ${s.slice(0, 110)}`);
    }
  }
});

test("revokedAt and revokedReason are never granted INSERT", () => {
  // A session is never born revoked.
  const inserts = shipped.filter((s) => /^GRANT\s+INSERT\b/i.test(s) && s.includes('"AuthSession"'));
  for (const s of inserts) {
    const cols = s.split(/\bON\b/i)[0];
    for (const c of ["revokedAt", "revokedReason"]) {
      assert.ok(!cols.includes(`"${c}"`), `INSERT is granted on ${c}: ${s.slice(0, 110)}`);
    }
  }
});

test("every table-level privilege is revoked before its columns are granted", () => {
  // Column grants are inert while a table-level privilege stands. Reversed, the
  // revoke would look correct in review and accomplish nothing.
  for (const table of TABLES) {
    const revokeAt = shipped.findIndex(
      (s) => /^REVOKE\b/i.test(s) && s.includes(table) && s.includes("app_auth"));
    const firstColumnGrant = shipped.findIndex(
      (s) => /^GRANT\b/i.test(s) && s.includes(table) && s.includes("app_auth")
             && /\(/.test(s.split(/\bON\b/i)[0]));
    if (firstColumnGrant === -1) continue;
    assert.notEqual(revokeAt, -1, `app_auth keeps table-level privileges on ${table}`);
    assert.ok(revokeAt < firstColumnGrant,
      `${table}: columns are granted before the table-level revoke, so the narrowing is inert`);
  }
});

console.log(`\n[auth-session-privilege-equivalence] PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
