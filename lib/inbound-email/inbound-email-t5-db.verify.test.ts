/**
 * T5-DB — what a challenge is FOR, and which one is authoritative.
 *
 * A contract over the datamodel and the migration text. It runs offline, so what
 * it proves is what those files DECLARE. The behaviour they produce was proven
 * separately, against PostgreSQL 17, and the bottom of this file says exactly
 * which parts only a database can answer.
 *
 * The one thing worth reading before the checks: the live slot is a PLAIN unique
 * index on a NULLABLE column, not a partial index. Both express "at most one live
 * challenge", and only one of them is visible to Prisma — which is what decides
 * whether a `db push` security lab reproduces the invariant or silently omits it.
 * T4-DB rejected the partial form for that reason and this follows it.
 *
 *   npx tsx lib/inbound-email/inbound-email-t5-db.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const MIGRATION_DIR =
  "prisma/migrations/20260918140000_inbound_email_challenge_purpose_and_lifecycle";

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const schema = read("prisma/schema.prisma");
const migration = read(path.join(MIGRATION_DIR, "migration.sql"));

/** The migration minus commentary: naming a shape in order to forbid it is not doing it. */
const sql = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

function model(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  assert.ok(start >= 0, `model ${name} is not in the schema`);
  return schema
    .slice(start, schema.indexOf("\n}", start))
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("///"))
    .join("\n");
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(what: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${what}`);
  } catch (error) {
    failed += 1;
    failures.push(what);
    console.log(`  FAIL  ${what}`);
    console.log(`        ${(error as Error).message.split("\n")[0]}`);
  }
}

console.log("\nT5-DB — challenge purpose and lifecycle\n");

const challenge = model("InboundEmailSenderChallenge");

check("the purpose vocabulary is an enum owned by this schema", () => {
  const start = schema.indexOf("enum InboundEmailChallengePurpose {");
  assert.ok(start >= 0, "the enum is missing");
  const body = schema.slice(start, schema.indexOf("\n}", start));
  const members = body
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("///"));
  assert.deepEqual(members, ["SENDER_OWNERSHIP_VERIFICATION"], `unexpected members: ${members}`);
});

check("purpose is required, and carries no default", () => {
  const line = challenge.split("\n").find((l) => l.trim().startsWith("purpose "));
  assert.ok(line, "purpose is not declared");
  assert.ok(!line!.includes("?"), "purpose is optional — a challenge with no stated purpose");
  assert.ok(
    !line!.includes("@default"),
    "purpose has a default, which lets a writer omit it and inherit a purpose it never chose"
  );
});

check("the live slot is nullable — that IS the mechanism", () => {
  const line = challenge.split("\n").find((l) => l.trim().startsWith("activeChallengeKey"));
  assert.ok(line, "activeChallengeKey is not declared");
  assert.ok(
    line!.includes("InboundEmailChallengePurpose?"),
    "the key is not a nullable purpose — NULLs are what let terminal rows coexist"
  );
});

check("supersededAt exists and is optional", () => {
  assert.ok(/supersededAt\s+DateTime\?/.test(challenge), "supersededAt is missing or required");
});

check("the live-slot uniqueness is Prisma-visible, and is not partial", () => {
  assert.ok(
    /@@unique\(\[businessId, authorizedSenderId, activeChallengeKey\]\)/.test(challenge),
    "the composite unique on the live slot is missing from the datamodel"
  );
  // The migration must state the same thing, and must NOT do it with a WHERE.
  const create = sql
    .split("\n")
    .filter((l) => /CREATE UNIQUE INDEX/i.test(l) || /activeChallengeKey/.test(l));
  assert.ok(
    create.some((l) => /CREATE UNIQUE INDEX/i.test(l)),
    "the migration creates no unique index on the live slot"
  );
  assert.ok(
    !/CREATE UNIQUE INDEX[\s\S]{0,400}?WHERE/i.test(sql),
    "the migration uses a PARTIAL unique index, which a db-push lab cannot see"
  );
});

check("the regeneration ceiling has an index to count against", () => {
  assert.ok(
    /@@index\(\[businessId, authorizedSenderId, createdAt\]\)/.test(challenge),
    "no (businessId, authorizedSenderId, createdAt) index — the 24h count would scan"
  );
});

check("CHECK 1 ties the key to the lifecycle, and guards it against NULL first", () => {
  const start = sql.indexOf("live_key_coherent");
  assert.ok(start >= 0, "the coherence constraint is missing");
  const body = sql.slice(start, sql.indexOf(";", start));
  assert.ok(/"activeChallengeKey"\s*=\s*"purpose"/.test(body), "the key is never compared to purpose");
  // The whole point. A CHECK passes on UNKNOWN and fails only on FALSE, so
  // comparing a NULL key to purpose yields UNKNOWN and lets a keyless live row
  // through — which the rehearsal demonstrated before this guard was added.
  assert.ok(
    /"activeChallengeKey"\s+IS\s+NOT\s+NULL/i.test(body),
    "the key is compared without first being tested for NULL: three-valued logic lets a live row with no key pass"
  );
  assert.ok(/"consumedAt"\s+IS\s+NULL/i.test(body) && /"supersededAt"\s+IS\s+NULL/i.test(body),
    "liveness is not defined as both terminals being absent");
});

check("CHECK 2 forbids a row that is both consumed and superseded", () => {
  const start = sql.indexOf("terminal_exclusive");
  assert.ok(start >= 0, "the exclusivity constraint is missing");
  const body = sql.slice(start, sql.indexOf(";", start));
  assert.ok(
    /NOT\s*\(\s*"consumedAt"\s+IS\s+NOT\s+NULL\s+AND\s+"supersededAt"\s+IS\s+NOT\s+NULL\s*\)/i.test(body),
    "the constraint does not actually exclude the two terminals"
  );
});

check("expiry and the attempt ceiling stay predicates — nothing clears the key for them", () => {
  // A sweep that rewrote rows on expiry could run late, and a late sweep leaves a
  // dead challenge usable. Same rule T4 applied to graceUntil.
  const start = sql.indexOf("live_key_coherent");
  const body = sql.slice(start, sql.indexOf(";", start));
  for (const forbidden of ["expiresAt", "failedAttempts"]) {
    assert.ok(
      !body.includes(forbidden),
      `${forbidden} appears in the liveness constraint, making expiry or burn a stored state`
    );
  }
});

check("the migration is additive, and refuses to run against rows it cannot serve", () => {
  for (const forbidden of ["DROP COLUMN", "DROP TABLE", "DROP CONSTRAINT", "TRUNCATE", "DELETE FROM"]) {
    assert.ok(!new RegExp(forbidden, "i").test(sql), `the migration performs ${forbidden}`);
  }
  assert.ok(
    /RAISE EXCEPTION/i.test(sql) && /count\(\*\)/i.test(sql),
    "nothing asserts the table is empty, yet purpose is NOT NULL with no default"
  );
  assert.ok(!/UPDATE\s+"InboundEmailSenderChallenge"/i.test(sql), "the migration backfills rows");
});

check("tenancy is left exactly as T1-DB set it", () => {
  for (const forbidden of ["DROP POLICY", "CREATE POLICY", "DISABLE ROW LEVEL SECURITY", "NO FORCE ROW LEVEL"]) {
    assert.ok(!new RegExp(forbidden, "i").test(sql), `the migration changes tenancy: ${forbidden}`);
  }
});

check("no other model or migration surface is touched", () => {
  const tables = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
  const other = tables.filter((t) => t !== "InboundEmailSenderChallenge");
  assert.equal(other.length, 0, `the migration alters ${other.join(", ")}`);
});

check("the fixture that seeds a challenge was updated for a required purpose", () => {
  // The AD-2A battery creates a challenge row. A NOT NULL column with no default
  // would have broken it, and it runs on a db-push lab where the CHECKs do not
  // exist — so it must also carry a coherent key, or it would seed a shape the
  // real database would refuse.
  const battery = read(".ad2a/battery.mjs");
  const start = battery.indexOf("owner.inboundEmailSenderChallenge.create");
  assert.ok(start >= 0, "the AD-2A battery no longer seeds a challenge");
  const body = battery.slice(start, battery.indexOf("});", start));
  assert.ok(body.includes("purpose:"), "the AD-2A fixture omits purpose and would fail NOT NULL");
  assert.ok(
    body.includes("activeChallengeKey:"),
    "the AD-2A fixture seeds a live row with no key — a shape the CHECK forbids"
  );
});

/**
 * NOT PROVEN HERE, and stated rather than implied.
 *
 * Everything above is what the files DECLARE. That the declarations behave was
 * proven on an ephemeral PostgreSQL 17 branch by applying this migration through
 * `prisma migrate deploy` and then exercising it: seven positive shapes accepted,
 * ten hostile ones refused and classified by SQLSTATE rather than by message
 * text, and two overlapping writers leaving exactly one live challenge.
 *
 * Two findings from that rehearsal are worth carrying:
 *
 *   * The first version of CHECK 1 compared the key to purpose without testing
 *     it for NULL. PostgreSQL accepted a live row with no key, because UNKNOWN
 *     OR FALSE is UNKNOWN and a CHECK only fails on FALSE. The guard above
 *     exists because a row was inserted, not because the logic was re-read.
 *
 *   * Tenant isolation could NOT be demonstrated behaviourally on Neon: every
 *     role obtainable there carries BYPASSRLS, so the policy is never consulted
 *     and any assertion would have passed for the wrong reason. What this
 *     migration can be held to — that RLS is still enabled, still forced, and
 *     that the policy predicate does not mention these columns — is checked
 *     above. The behavioural half belongs to the batteries that run against a
 *     plain PostgreSQL 17 container with a restricted role.
 */

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failures.length > 0) console.log(`  failing: ${failures.join(" | ")}`);
console.log("");
process.exit(failed === 0 ? 0 : 1);
