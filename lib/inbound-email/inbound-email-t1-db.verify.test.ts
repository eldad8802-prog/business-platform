/**
 * T1-DB — what the database foundation for authorised senders must say, and what
 * it must never say.
 *
 * This is a CONTRACT over the schema and the migration text. It runs offline: it
 * reads `prisma/schema.prisma` and the migration SQL and asserts on them. It
 * deliberately does not connect to a database, because the properties that matter
 * here are properties of the DECLARATION — a plaintext column that does not exist
 * cannot be found by querying, only by reading.
 *
 * The rename is the one exception worth explaining. `prisma migrate diff` writes
 * a column rename as DROP + ADD, which discards every existing value in silence.
 * The assertions below hold the migration to a real RENAME, which is a catalogue
 * operation: PostgreSQL rewrites the column's name in `pg_attribute` and touches
 * no heap tuple, so the stored timestamps are the same bytes before and after.
 * That is the preservation argument, and it is checked by forbidding the shape
 * that would break it rather than by trusting that nobody re-generates the file.
 *
 *   npx tsx lib/inbound-email/inbound-email-t1-db.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { MODEL_COVERAGE } from "../../scripts/ci/erasure/erasure-model-coverage";

const ROOT = path.resolve(__dirname, "../..");
const MIGRATION_DIR = "prisma/migrations/20260916090000_inbound_email_authorized_senders";

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const schema = read("prisma/schema.prisma");
const migration = read(path.join(MIGRATION_DIR, "migration.sql"));

/**
 * The migration minus its `--` commentary. The header explains at length why the
 * rename is not a DROP, and naming a shape in order to forbid it must not read as
 * performing it. Every assertion about what the migration DOES is made here.
 */
const migrationCode = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/** The body of one `model X { ... }` block, comments stripped. */
function model(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  assert.ok(start >= 0, `model ${name} is not in the schema`);
  const end = schema.indexOf("\n}", start);
  return schema
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("///"))
    .join("\n");
}

let passed = 0;
let failed = 0;
function check(what: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}`);
    console.log(`        ${(error as Error).message.split("\n")[0]}`);
  }
}

console.log("\nT1-DB — inbound email authorised senders\n");

// ── 1. The claim list ────────────────────────────────────────────────────────

check("an authorised sender is unique per tenant, not globally", () => {
  const m = model("InboundEmailAuthorizedSender");
  assert.ok(
    m.includes("@@unique([businessId, normalizedEmail])"),
    "a tenant may not list the same address twice"
  );
  assert.ok(
    !/normalizedEmail\s+String\s+@unique/.test(m),
    "a global unique would stop a bookkeeper being listed by two of their clients"
  );
});

check("the same address may be listed by two different businesses", () => {
  const m = model("InboundEmailAuthorizedSender");
  const uniques = [...m.matchAll(/@@unique\(\[([^\]]+)\]\)/g)].map((x) => x[1]!.trim());
  for (const u of uniques) {
    assert.ok(
      u.startsWith("businessId"),
      `@@unique([${u}]) is not tenant-scoped, so it would be global across businesses`
    );
  }
});

check("a sender carries its own lifecycle, and the status names the three states", () => {
  const m = model("InboundEmailAuthorizedSender");
  for (const field of ["businessId", "normalizedEmail", "status", "verifiedAt", "revokedAt", "createdAt", "createdByUserId"]) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(m), `${field} is missing`);
  }
  const e = schema.slice(schema.indexOf("enum InboundEmailSenderStatus {"));
  const body = e.slice(0, e.indexOf("}"));
  for (const state of ["PENDING_VERIFICATION", "VERIFIED", "REVOKED"]) {
    assert.ok(body.includes(state), `${state} is missing from InboundEmailSenderStatus`);
  }
});

// ── 2. The challenge, and the column that must never exist ───────────────────

check("the challenge is stored ONLY as a hash — no plaintext column, by any name", () => {
  const m = model("InboundEmailSenderChallenge");
  assert.ok(m.includes("challengeHash"), "challengeHash is missing");
  // Scanned over COLUMN NAMES rather than the block text. The model is itself
  // called ...Challenge, so matching raw source would flag its own header line.
  // Each name below is one somebody would reach for when putting the plaintext
  // back; they are listed individually so a failure says which one appeared.
  const columns = [...m.matchAll(/^\s{2}(\w+)\s+\w/gm)].map((x) => x[1]!);
  for (const forbidden of [
    "challenge",
    "challengeValue",
    "challengePlaintext",
    "token",
    "plaintextCode",
    "verificationCode",
    "code",
    "secret",
    "otp",
  ]) {
    assert.ok(
      !columns.some((c) => c.toLowerCase() === forbidden.toLowerCase()),
      `InboundEmailSenderChallenge appears to hold a plaintext challenge: "${forbidden}"`
    );
  }
  const hashy = columns.filter((c) => /challenge/i.test(c));
  assert.deepEqual(hashy, ["challengeHash"], "the only challenge column may be the hash");
});

check("the challenge persists expiry, single use and failed attempts", () => {
  const m = model("InboundEmailSenderChallenge");
  assert.ok(/expiresAt\s+DateTime\b/.test(m), "expiresAt is missing or nullable");
  assert.ok(/consumedAt\s+DateTime\?/.test(m), "consumedAt must be nullable — unconsumed is the normal state");
  assert.ok(/failedAttempts\s+Int\s+@default\(0\)/.test(m), "failedAttempts must start at zero");
});

check("a challenge cannot reference a sender in another tenant", () => {
  const m = model("InboundEmailSenderChallenge");
  assert.ok(
    m.includes("fields: [businessId, authorizedSenderId], references: [businessId, id]"),
    "the sender reference must be the tenant composite"
  );
});

// ── 3. The rename, and why it is not a drop ──────────────────────────────────

check("the address records firstMessageAt, and no longer claims verifiedAt", () => {
  const m = model("InboundEmailAddress");
  assert.ok(/firstMessageAt\s+DateTime\?/.test(m), "firstMessageAt is missing");
  assert.ok(!/^\s*verifiedAt\b/m.test(m), "verifiedAt still exists on InboundEmailAddress");
});

check("the migration RENAMES the column instead of dropping and re-adding it", () => {
  assert.ok(
    /ALTER TABLE "InboundEmailAddress" RENAME COLUMN "verifiedAt" TO "firstMessageAt";/.test(migrationCode),
    "the rename statement is missing"
  );
  assert.ok(
    !/DROP COLUMN "verifiedAt"/.test(migrationCode),
    "DROP COLUMN would discard every stored timestamp"
  );
  assert.ok(
    !/ADD COLUMN\s+"firstMessageAt"/.test(migrationCode),
    "ADD COLUMN alongside a rename would mean the values were not carried over"
  );
});

check("nothing else in the migration rewrites or narrows an existing column", () => {
  assert.ok(!/\bDROP\b/.test(migrationCode), "the migration drops something");
  assert.ok(!/\bTRUNCATE\b/.test(migrationCode), "the migration truncates something");
  assert.ok(!/DELETE\s+FROM/i.test(migrationCode), "the migration deletes rows");
  assert.ok(!/SET\s+NOT\s+NULL/i.test(migrationCode), "the migration narrows a column to NOT NULL");
  assert.ok(!/ALTER COLUMN\s+"\w+"\s+TYPE/i.test(migrationCode), "the migration changes a column type");
});

// ── 4. Message provenance, recorded without asserting what it is worth ───────

check("the message records the provenance the contract named", () => {
  const m = model("InboundEmailMessage");
  for (const field of [
    "providerMessageId",
    "messageIdHeader",
    "receivedAt",
    "addressId",
    "authorizationOutcome",
    "authorizedSenderId",
    "authorizationMatchedValue",
    "authorizationMatchedSource",
    "fromEmail",
    "subject",
    "spfVerdict",
    "dkimVerdict",
    "dmarcVerdict",
    "spamVerdict",
    "virusVerdict",
    "rawObjectKey",
    "rawDeletedAt",
  ]) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(m), `${field} is missing from InboundEmailMessage`);
  }
});

check("no enum member declares a matching mechanism to be authoritative", () => {
  const e = schema.slice(schema.indexOf("enum InboundEmailAuthorizationOutcome {"));
  const body = e.slice(0, e.indexOf("}"));
  const members = [...body.matchAll(/^\s{2}([A-Z_]+)$/gm)].map((x) => x[1]!);
  assert.deepEqual(
    members.slice().sort(),
    ["AUTHORIZED", "INDETERMINATE", "NOT_EVALUATED", "UNAUTHORIZED"],
    "the outcome enum gained a member"
  );
  // The specific failure this guards: a member like RFC5322_FROM_MATCH would bake
  // "matching this header authorises the sender" into the schema, before the
  // matcher has been measured against a real forwarded delivery.
  for (const member of members) {
    for (const mechanism of ["FROM", "HEADER", "ENVELOPE", "SPF", "DKIM", "DMARC", "RFC"]) {
      assert.ok(
        !member.includes(mechanism),
        `${member} names a mechanism, which asserts that matching it is sufficient`
      );
    }
  }
});

check("the default outcome is the honest one while no evaluator exists", () => {
  const m = model("InboundEmailMessage");
  assert.ok(
    /authorizationOutcome\s+InboundEmailAuthorizationOutcome\s+@default\(NOT_EVALUATED\)/.test(m),
    "a message must not default to any evaluated state"
  );
});

check("the forbidden mailbox metadata is still absent", () => {
  for (const name of ["InboundEmailMessage", "InboundEmailAttachmentImport", "InboundEmailAddress"]) {
    const m = model(name).toLowerCase();
    for (const forbidden of ["replyto", "returnpath", "receivedchain", "headers", "rawmime", "bodytext", "bodyhtml"]) {
      assert.ok(!m.includes(forbidden), `${name} appears to store ${forbidden}`);
    }
  }
});

// ── 5. Attachment provenance ─────────────────────────────────────────────────

check("an attachment records its position, and cannot be imported into it twice", () => {
  const m = model("InboundEmailAttachmentImport");
  assert.ok(/attachmentIndex\s+Int\?/.test(m), "attachmentIndex is missing or not nullable");
  assert.ok(
    m.includes("@@unique([businessId, messageId, attachmentIndex])"),
    "the same part position could be imported twice"
  );
  assert.ok(m.includes("contentHashSha256"), "the content hash concept was lost");
  assert.ok(m.includes("filename"), "the declared filename concept was lost");
});

check("the Document reference is still the plain one that I-8A requires", () => {
  const m = model("InboundEmailAttachmentImport");
  assert.ok(
    m.includes("@relation(fields: [documentId], references: [id])"),
    "the Document reference changed shape"
  );
  assert.ok(
    !/references:\s*\[businessId,\s*id\]\)/.test(m.slice(m.indexOf("document "))),
    "a composite Document FK would break the I-8A battery with 2BP01"
  );
});

// ── 6. Tenancy ───────────────────────────────────────────────────────────────

const NEW_TENANT_TABLES = ["InboundEmailAuthorizedSender", "InboundEmailSenderChallenge"];

check("every new tenant table has row-level security ENABLED and FORCED", () => {
  for (const table of NEW_TENANT_TABLES) {
    assert.ok(
      migrationCode.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`),
      `${table} does not enable row-level security`
    );
    assert.ok(
      migrationCode.includes(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`),
      `${table} does not FORCE it, so the table owner would bypass the policy`
    );
  }
});

check("each policy keys both read and write on the tenant GUC", () => {
  for (const table of NEW_TENANT_TABLES) {
    // Matched as whole statements. Scanning backwards from the first mention of
    // the table name would land on an index or a grant, not on its policy.
    const found = [...migrationCode.matchAll(/CREATE POLICY\s+\w+\s+ON\s+"(\w+)"([\s\S]*?);/g)].filter(
      (x) => x[1] === table
    );
    assert.equal(found.length, 1, `${table} must have exactly one policy`);
    const policy = found[0]![2]!;
    assert.ok(policy.includes("USING"), `${table} policy has no USING clause`);
    assert.ok(policy.includes("WITH CHECK"), `${table} policy has no WITH CHECK, so a write could cross tenants`);
    const guc = (policy.match(/current_setting\('app\.current_business_id', true\)/g) ?? []).length;
    assert.equal(guc, 2, `${table} policy must read the tenant GUC in both clauses`);
  }
});

check("every new table carries its own businessId, so the policy has something to key on", () => {
  for (const table of NEW_TENANT_TABLES) {
    assert.ok(/businessId\s+Int\b/.test(model(table)), `${table} has no businessId`);
  }
});

check("grants are least-privilege, role-guarded, and reach no admin role", () => {
  assert.ok(
    migrationCode.includes("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')"),
    "the grants are not guarded on the role existing, so this breaks a fresh database"
  );
  for (const table of NEW_TENANT_TABLES) {
    assert.ok(
      migrationCode.includes(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO app_runtime;`),
      `${table} has no explicit runtime grant`
    );
  }
  for (const forbidden of ["TO app_admin", "TO PUBLIC", "GRANT ALL", "WITH GRANT OPTION", "ALTER ROLE", "SUPERUSER", "BYPASSRLS"]) {
    assert.ok(!migrationCode.includes(forbidden), `the migration grants too much: ${forbidden}`);
  }
});

// ── 7. Erasure ───────────────────────────────────────────────────────────────

check("every inbound model has an explicit erasure disposition", () => {
  const declared = Object.keys(MODEL_COVERAGE);
  const inbound = [...schema.matchAll(/^model (InboundEmail\w+) \{/gm)].map((x) => x[1]!);
  assert.ok(inbound.length >= 5, "expected at least five inbound models");
  for (const m of inbound) {
    assert.ok(declared.includes(m), `${m} has no erasure disposition`);
  }
});

check("no new model claims an erasure that no adapter performs", () => {
  // T1-DB adds no account-deletion code. A model claiming ERASURE_MANAGED here
  // would be a promise with nothing behind it; the honest answer is the
  // transitional one, recorded as debt that T1-ERASURE closes.
  for (const m of NEW_TENANT_TABLES) {
    const coverage = MODEL_COVERAGE[m];
    assert.ok(coverage, `${m} is unclassified`);
    assert.notEqual(
      coverage.disposition,
      "ERASURE_MANAGED",
      `${m} claims managed erasure while no adapter touches it`
    );
  }
});

// ── 8. Still inert ───────────────────────────────────────────────────────────

check("nothing in the application reads or writes the new models", () => {
  const roots = ["app", "components", "lib"];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      // This file names them in order to forbid consumers; the erasure registry
      // names them in order to classify them. Neither holds a client.
      if (rel.endsWith("inbound-email-t1-db.verify.test.ts")) continue;
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      for (const m of NEW_TENANT_TABLES) {
        const delegate = m[0]!.toLowerCase() + m.slice(1);
        if (src.includes(`.${delegate}.`) || src.includes(`prisma.${delegate}`)) offenders.push(`${rel} -> ${m}`);
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, [], "a runtime consumer of a T1-DB model appeared");
});

check("the migration touches no table outside the inbound family", () => {
  // Stated as an allow-list rather than a list of tables to avoid. A deny-list
  // only catches the foreign tables somebody thought of, and naming another
  // feature's model here would make this file a consumer of that model in the
  // eyes of the contract that pins them — billing, documents and the fiscal
  // firewall each have one. So the assertion names only what T1-DB owns, and
  // anything else at all fails.
  const INBOUND_TABLES = [
    "InboundEmailAddress",
    "InboundEmailMessage",
    "InboundEmailAttachmentImport",
    "InboundEmailAuthorizedSender",
    "InboundEmailSenderChallenge",
  ];
  const touched = [...migrationCode.matchAll(/(?:ALTER|CREATE|DROP)\s+TABLE\s+"(\w+)"/g)].map((x) => x[1]!);
  const foreign = [...new Set(touched)].filter((t) => !INBOUND_TABLES.includes(t));
  assert.deepEqual(foreign, [], "the migration reaches outside the inbound family");
});

check("the feature flag still defaults to off", () => {
  const flag = read("lib/inbound-email/inbound-email-flag.ts");
  assert.ok(flag.includes("INBOUND_EMAIL_ENABLED"), "the flag module changed name");
  assert.ok(/=== "true"/.test(flag), "the flag must enable on the exact string true and nothing else");
});

// ── 9. Deploy ordering ───────────────────────────────────────────────────────

check("exactly one new migration, and it sorts after every applied one", () => {
  const dirs = fs
    .readdirSync(path.join(ROOT, "prisma/migrations"))
    .filter((d) => /^\d{14}_/.test(d))
    .sort();
  const mine = MIGRATION_DIR.split("/").pop()!;
  assert.equal(dirs.filter((d) => d === mine).length, 1, "the migration directory is not unique");
  assert.equal(dirs[dirs.length - 1], mine, "the migration does not sort last, so deploy order is ambiguous");
  // Scoped to THIS timestamp. Two migrations dated 2026-07-16 already share one,
  // which predates this work by two months and is not T1-DB's to rewrite.
  const myStamp = mine.slice(0, 14);
  assert.equal(
    dirs.filter((d) => d.startsWith(myStamp)).length,
    1,
    "another migration already uses this timestamp"
  );
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
