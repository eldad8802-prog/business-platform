/**
 * T4-DB — what the address and sender lifecycles must be able to SAY.
 *
 * Two shapes that the previous schema could not state truthfully:
 *
 *   * a rotated address that is retired but still routable for thirty days
 *   * a revoked sender whose address can be registered again, as a new identity
 *     that has to verify again, without reviving the withdrawn row
 *
 * This is a contract over the datamodel and the migration text. It runs offline.
 * What it can prove is what those files DECLARE; it does not insert rows, and it
 * says so where that matters.
 *
 *   npx tsx lib/inbound-email/inbound-email-t4-db.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const MIGRATION_DIR =
  "prisma/migrations/20260917100000_inbound_address_retirement_and_sender_reregistration";

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const schema = read("prisma/schema.prisma");
const migration = read(path.join(MIGRATION_DIR, "migration.sql"));

/** The migration minus commentary: naming a shape in order to forbid it is not doing it. */
const migrationCode = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

function model(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  assert.ok(start >= 0, `model ${name} is not in the schema`);
  const end = schema.indexOf("\n}", start);
  return schema
    .slice(start, end)
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("///"))
    .join("\n");
}

function enumBody(name: string): string {
  const start = schema.indexOf(`enum ${name} {`);
  assert.ok(start >= 0, `enum ${name} is missing`);
  return schema.slice(start, schema.indexOf("\n}", start));
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

console.log("\nT4-DB — address retirement and sender re-registration\n");

// ── The address lifecycle ────────────────────────────────────────────────────

check("the address has three states, in lifecycle order", () => {
  const body = enumBody("InboundEmailAddressStatus");
  for (const state of ["ACTIVE", "RETIRING", "REVOKED"]) {
    assert.ok(new RegExp(`^\\s{2}${state}$`, "m").test(body), `${state} is missing`);
  }
  assert.ok(
    body.indexOf("ACTIVE") < body.indexOf("RETIRING") &&
      body.indexOf("RETIRING") < body.indexOf("REVOKED"),
    "the states are not declared in lifecycle order"
  );
});

check("grace has its own column and is not overloaded onto revokedAt", () => {
  const m = model("InboundEmailAddress");
  assert.ok(/graceUntil\s+DateTime\?/.test(m), "graceUntil is missing or not nullable");
  assert.ok(/revokedAt\s+DateTime\?/.test(m), "revokedAt disappeared");
  // Two columns, two meanings. Reusing revokedAt as a future deadline would make
  // "this row is revoked" and "this row stops working later" the same statement.
  assert.notEqual(
    m.indexOf("graceUntil"),
    m.indexOf("revokedAt"),
    "grace and revocation are the same field"
  );
});

check("the database enforces the state/timestamp coupling", () => {
  assert.ok(
    /ADD CONSTRAINT "InboundEmailAddress_grace_state_coherent"/.test(migrationCode),
    "no CHECK ties the address status to its grace date"
  );
  const at = migrationCode.indexOf("InboundEmailAddress_grace_state_coherent");
  const clause = migrationCode.slice(at, migrationCode.indexOf(";", at));
  assert.ok(/'ACTIVE'[\s\S]*graceUntil" IS NULL/.test(clause), "ACTIVE may carry a grace date");
  assert.ok(/graceUntil" IS NOT NULL/.test(clause), "the retiring branch permits a missing date");
});

check("the CHECK never names the enum value the same transaction adds", () => {
  // PostgreSQL refuses to USE a new enum value in the transaction that added it,
  // and Prisma runs a migration file as one transaction. Naming RETIRING in the
  // CHECK would fail outright at deploy time rather than in review.
  const addValue = /ALTER TYPE "InboundEmailAddressStatus" ADD VALUE 'RETIRING';/.test(
    migrationCode
  );
  assert.ok(addValue, "the RETIRING value is never added");
  const uses = migrationCode.split("RETIRING").length - 1;
  assert.equal(uses, 1, "RETIRING appears in SQL beyond its own ADD VALUE");
});

check("no existing address row is moved into the new state", () => {
  // History keeps its meaning: an ACTIVE address stays active, a revoked one
  // stays revoked, and no grace date is invented for a rotation that never
  // happened.
  assert.ok(
    !/UPDATE "InboundEmailAddress"/.test(migrationCode),
    "the migration rewrites existing address rows"
  );
  assert.ok(
    !/SET "status"/.test(migrationCode),
    "the migration rewrites a status somewhere"
  );
});

// ── The sender lifecycle ─────────────────────────────────────────────────────

check("uniqueness moved from permanent to current-identity", () => {
  const m = model("InboundEmailAuthorizedSender");
  assert.ok(/activeEmailKey\s+String\?/.test(m), "activeEmailKey is missing or not nullable");
  assert.ok(
    m.includes("@@unique([businessId, activeEmailKey])"),
    "the current-identity unique index is missing"
  );
  assert.ok(
    !m.includes("@@unique([businessId, normalizedEmail])"),
    "permanent uniqueness survives, so a revoked address can never be re-registered"
  );
  assert.ok(
    m.includes("@@index([businessId, normalizedEmail])"),
    "lookup by address lost its index when the unique one was dropped"
  );
});

check("the unique index is in the DATAMODEL, so every database gets it", () => {
  // The rule could have been a PostgreSQL partial unique index, which Prisma
  // cannot declare and which would therefore exist only in migration SQL. That
  // matters here: several CI batteries build their database with `prisma db
  // push` from this datamodel, so such an index would be missing from the lab
  // and the lab would stop reproducing Production on a constraint that decides
  // who may send mail.
  assert.ok(
    schema.includes("@@unique([businessId, activeEmailKey])"),
    "the current-identity rule is not expressed in the datamodel"
  );
  assert.ok(
    !/CREATE UNIQUE INDEX[^;]*WHERE/i.test(migrationCode),
    "a partial unique index was introduced; it would be absent under db push"
  );
});

check("the database enforces the key/status coupling", () => {
  assert.ok(
    /ADD CONSTRAINT "InboundEmailAuthorizedSender_active_key_coherent"/.test(migrationCode),
    "no CHECK ties activeEmailKey to status"
  );
  const at = migrationCode.indexOf("InboundEmailAuthorizedSender_active_key_coherent");
  const clause = migrationCode.slice(at, migrationCode.indexOf(";", at));
  assert.ok(/'REVOKED'[\s\S]*activeEmailKey" IS NULL/.test(clause), "a revoked row may keep its key");
  assert.ok(
    /activeEmailKey" = "normalizedEmail"/.test(clause),
    "a current row may carry a key that is not its own address"
  );
});

check("no sender history is deleted, revived or re-stated", () => {
  assert.ok(!/DELETE FROM/i.test(migrationCode), "the migration deletes rows");
  assert.ok(!/TRUNCATE/i.test(migrationCode), "the migration truncates");
  // The single UPDATE is the backfill, and it may only touch the new column.
  const updates = [...migrationCode.matchAll(/UPDATE "(\w+)"[\s\S]*?;/g)];
  assert.equal(updates.length, 1, `expected exactly one backfill, found ${updates.length}`);
  const backfill = updates[0]![0];
  assert.ok(backfill.includes('"InboundEmailAuthorizedSender"'), "the backfill targets another table");
  assert.ok(
    /SET "activeEmailKey" = "normalizedEmail"/.test(backfill),
    "the backfill writes something other than the new key"
  );
  assert.ok(
    !/"status"/.test(backfill.split("WHERE")[0]!),
    "the backfill rewrites a status, which would revive or re-state history"
  );
  assert.ok(
    /WHERE[\s\S]*"status" <> 'REVOKED'/.test(backfill),
    "the backfill would give revoked rows a current-identity key"
  );
});

check("the backfill cannot collide with the index built after it", () => {
  // The dropped index guaranteed at most one row per (businessId,
  // normalizedEmail), so at most one of them is non-revoked, so the backfill
  // produces at most one non-null key per pair. The new unique index therefore
  // builds cleanly on any database that satisfied the old one.
  const drop = migrationCode.indexOf("DROP INDEX");
  const backfill = migrationCode.indexOf('UPDATE "InboundEmailAuthorizedSender"');
  const create = migrationCode.indexOf("CREATE UNIQUE INDEX");
  assert.ok(backfill < drop, "the backfill runs after the old guarantee is gone");
  assert.ok(backfill < create, "the new index is built before the column is populated");
});

// ── Erasure ──────────────────────────────────────────────────────────────────

check("account erasure still deletes every sender row, revoked history included", () => {
  const adapter = read("lib/services/account/account-deletion.prisma-store.ts");
  const code = adapter
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");
  // Scoped by businessId and by nothing else: no status filter, so the extra
  // revoked rows this migration makes possible are deleted with the rest.
  const line = code
    .split("\n")
    .find((l) => l.includes("tx.inboundEmailAuthorizedSender.deleteMany"));
  assert.ok(line, "the erasure adapter no longer deletes authorized senders");
  assert.ok(
    /deleteMany\(\{\s*where:\s*\{\s*businessId\s*\}\s*\}\)/.test(line!),
    `the delete gained a filter and may now leave rows behind: ${line!.trim()}`
  );
  assert.ok(!/status/.test(line!), "the delete filters on status and would spare revoked history");
});

// ── Scope ────────────────────────────────────────────────────────────────────

check("T4-DB adds no runtime: no service, no route, no rotation, no sender creation", () => {
  const roots = ["app", "components"];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) {
        const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
        for (const d of ["inboundEmailAddress", "inboundEmailAuthorizedSender"]) {
          if (src.includes(`.${d}.`)) offenders.push(`${rel} -> ${d}`);
        }
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, [], "a runtime consumer appeared; T4-DB is schema only");
});

check("the inbound feature is still off and still fails closed", () => {
  const flag = read("lib/inbound-email/inbound-email-flag.ts");
  assert.ok(/=== "true"/.test(flag), "the flag no longer requires the exact string true");
});

// This used to assert that the migration sorted LAST in the whole repository,
// which is a claim about the future rather than about this migration: it held
// only until the next one merged, and payables Phase 2 falsified it on main
// before T5-DB existed. What it was protecting is kept — the migration is
// present exactly once, and nothing else claimed its timestamp, which is the
// collision that would make deploy order ambiguous.
check("the migration exists exactly once, and owns its timestamp", () => {
  const dirs = fs
    .readdirSync(path.join(ROOT, "prisma/migrations"))
    .filter((d) => /^\d{14}_/.test(d))
    .sort();
  const mine = MIGRATION_DIR.split("/").pop()!;
  assert.equal(
    dirs.filter((d) => d === mine).length,
    1,
    "the migration directory is missing or duplicated"
  );
  assert.equal(
    dirs.filter((d) => d.startsWith(mine.slice(0, 14))).length,
    1,
    "another migration already uses this timestamp"
  );
});

check("the migration touches no table outside the inbound family", () => {
  const INBOUND = [
    "InboundEmailAddress",
    "InboundEmailMessage",
    "InboundEmailAttachmentImport",
    "InboundEmailAuthorizedSender",
    "InboundEmailSenderChallenge",
  ];
  const touched = [
    ...migrationCode.matchAll(/(?:ALTER|CREATE|DROP)\s+(?:TABLE|INDEX)\s+"(\w+)"/g),
  ].map((x) => x[1]!);
  const foreign = [...new Set(touched)].filter(
    (t) => !INBOUND.includes(t) && !t.startsWith("InboundEmail")
  );
  assert.deepEqual(foreign, [], "the migration reaches outside the inbound family");
});

/**
 * WHAT THIS FILE DOES NOT PROVE.
 *
 * It asserts what the datamodel and the migration DECLARE. It does not insert
 * rows, so the runtime behaviour of the unique index — many revoked rows
 * allowed, one current row allowed, a second current row refused — rests on
 * PostgreSQL's documented treatment of NULLs as distinct in a unique index,
 * together with the declaration above, rather than on an executed INSERT.
 *
 * Proving it by execution needs PostgreSQL. There is none on this machine, and
 * creating a database branch to get one is a separate authorisation. The
 * migration has therefore NOT been rehearsed against a database, and the report
 * for this increment says so rather than implying otherwise.
 */

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failures.length > 0) console.log(`  failing: ${failures.join(" | ")}`);
console.log("");
process.exit(failed === 0 ? 0 : 1);
