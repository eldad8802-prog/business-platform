/**
 * D2 / STAGE E4.1 — the shipped migration is the reviewed SQL.
 *
 * `.e4/proposed-production-narrowing.sql` is what was audited. This migration is
 * what will actually run against Production. Two files holding the same intent
 * drift, and the drift is invisible: the review would still pass, because the
 * reviewed file is still correct — it just would no longer be the one that runs.
 *
 * So the statements are compared, not the prose. The only difference permitted is
 * the removal of the explicit transaction wrappers: Prisma runs each migration
 * file inside its own transaction, and a nested BEGIN would warn while the COMMIT
 * would close that transaction early — turning the all-or-nothing narrowing into
 * a half-applied one, which is the single failure this whole design exists to
 * prevent.
 *
 * Run: npx tsx prisma/migrations/20260908180000_d2_user_business_privilege_narrowing/equivalence.test.ts
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

const REVIEWED = new URL("../../../.e4/proposed-production-narrowing.sql", import.meta.url);
const SHIPPED = new URL("./migration.sql", import.meta.url);

/**
 * Executable statements only, normalised.
 *
 * Comments and blank lines are dropped because they carry no privilege, and
 * whitespace is collapsed so reformatting is not mistaken for a change. Nothing
 * else is normalised: a different column, a different role or a different
 * privilege keyword must still register as a difference.
 */
function statements(url: URL): string[] {
  return readFileSync(url, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((s) => s + ";");
}

const reviewed = statements(REVIEWED);
const shipped = statements(SHIPPED);
const TRANSACTION_WRAPPERS = new Set(["BEGIN;", "COMMIT;"]);

console.log("== E4.1: reviewed SQL vs shipped migration ==");

test("the migration carries no explicit transaction wrapper", () => {
  const found = shipped.filter((s) => TRANSACTION_WRAPPERS.has(s.toUpperCase()));
  assert.deepEqual(found, [],
    `the migration would close Prisma's own transaction early: ${found.join(" ")}`);
});

test("the reviewed artifact still has its wrappers (it is read standalone)", () => {
  const found = reviewed.filter((s) => TRANSACTION_WRAPPERS.has(s.toUpperCase()));
  assert.deepEqual(found.map((s) => s.toUpperCase()), ["BEGIN;", "COMMIT;"]);
});

test("statement lists are identical once the wrappers are set aside", () => {
  const a = reviewed.filter((s) => !TRANSACTION_WRAPPERS.has(s.toUpperCase()));
  assert.deepEqual(shipped, a,
    "the shipped migration and the reviewed artifact have diverged");
});

test("the migration changes privileges and nothing else", () => {
  // No DDL, no roles, no policies. If any of those appear, the thing that was
  // reviewed as a grant change has quietly become a schema change.
  for (const s of shipped) {
    assert.match(s, /^(GRANT|REVOKE)\b/i,
      `a non-privilege statement is in the migration: ${s.slice(0, 90)}`);
  }
  const forbidden = /\b(CREATE|DROP|ALTER|TRUNCATE|INSERT|UPDATE\s+"|DELETE\s+FROM|ROW LEVEL SECURITY|POLICY|ROLE\s+\w+\s+(LOGIN|PASSWORD))\b/i;
  for (const s of shipped) {
    assert.ok(!forbidden.test(s.replace(/^(GRANT|REVOKE)[^;]*?\bON\b/i, "")),
      `the migration does more than change privileges: ${s.slice(0, 90)}`);
  }
});

test("no privilege is granted to a role outside the two planes", () => {
  const roles = shipped.flatMap((s) => [...s.matchAll(/\b(?:TO|FROM)\s+(\w+)/gi)].map((m) => m[1]));
  const allowed = new Set(["app_runtime", "app_auth"]);
  for (const r of roles) {
    assert.ok(allowed.has(r), `the migration touches an unexpected role: ${r}`);
  }
  assert.ok(roles.length > 0, "the migration names no roles at all");
});

test("DELETE is never granted (Step 1 stays closed)", () => {
  for (const s of shipped) {
    if (/^GRANT\b/i.test(s)) {
      assert.ok(!/\bDELETE\b/i.test(s.split(/\bON\b/i)[0]),
        `the migration grants DELETE: ${s.slice(0, 90)}`);
    }
  }
});

test("sequence UPDATE is never granted (setval stays impossible)", () => {
  for (const s of shipped) {
    if (/^GRANT\b/i.test(s) && /\bON\s+SEQUENCE\b/i.test(s)) {
      assert.ok(!/\bUPDATE\b/i.test(s.split(/\bON\b/i)[0]),
        `the migration grants UPDATE on a sequence: ${s.slice(0, 90)}`);
    }
  }
});

test("every table-level privilege is revoked before its columns are granted", () => {
  // The ordering is the whole design. Column grants applied while a table-level
  // grant still stands change nothing at all, and the revoke would look correct
  // in review while accomplishing exactly nothing.
  for (const table of ['"User"', '"Business"']) {
    for (const role of ["app_runtime", "app_auth"]) {
      const revokeAt = shipped.findIndex(
        (s) => /^REVOKE\b/i.test(s) && s.includes(table) && s.includes(role));
      const firstColumnGrant = shipped.findIndex(
        (s) => /^GRANT\b/i.test(s) && s.includes(table) && s.includes(role) && /\(/.test(s.split(/\bON\b/i)[0]));
      if (firstColumnGrant === -1) continue;
      assert.notEqual(revokeAt, -1, `${role} keeps table-level privileges on ${table}`);
      assert.ok(revokeAt < firstColumnGrant,
        `${role}/${table}: columns are granted before the table-level revoke, so the narrowing is inert`);
    }
  }
});

console.log(`\n[e4.1-equivalence] PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
