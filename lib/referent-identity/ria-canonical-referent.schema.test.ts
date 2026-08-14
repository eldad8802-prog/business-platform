/**
 * RIA-IMPL-1 — Canonical Referent substrate · structural invariant test. Run: npx tsx.
 *
 * Governance source of truth:
 *   docs/referent-identity-authority-v1.md (RIA-1 §4 Canonical Referent, RATIFIED)
 *   docs/referent-identity-authority-persistence-design-v1.md (§6, Verdict A)
 *
 * This is a STATIC test: it reads prisma/schema.prisma and the RIA migration.sql as text
 * and asserts the additive/inert invariants of the substrate. It touches NO database, opens
 * NO connection, and imports NO Prisma client — it can run in CI with no env and no DB.
 *
 * What it proves:
 *   - The Canonical Referent is an opaque, tenant-scoped ANCHOR, not a truth container:
 *     storage-only Int id, required businessId + Business relation, a governed referentType
 *     String slot (NOT an enum), recorded-only createdAt, and NOTHING else.
 *   - NO uniqueness on any identity signal (duplicate referents are legal).
 *   - NO mutable semantic state and NO PII field on the substrate.
 *   - Delete is onDelete: Restrict (never the repo-default Cascade).
 *   - The migration is additive-only: it CREATEs the new table and touches no existing table.
 *   - Adjacent identity surfaces (Party, Customer phone-uniqueness) are untouched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── tiny harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}`);
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

// ── load artifacts as text (no DB, no client) ───────────────────────────────────
const ROOT = join(__dirname, "..", "..");
// Normalize CRLF→LF: on Windows checkouts (core.autocrlf) the working-tree files are CRLF,
// so line-anchored (^…$/m) scans must not depend on the checkout's line endings.
const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
const migrationRaw = readFileSync(
  join(ROOT, "prisma", "migrations", "20260814120000_add_ria_canonical_referent", "migration.sql"),
  "utf8",
).replace(/\r\n/g, "\n");
// SQL-only view of the migration: strip `-- …` comment lines so destructive-keyword scans see
// executable statements only (the header comment legitimately mentions DROP/ALTER prose).
const migration = migrationRaw
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

// Extract the RiaCanonicalReferent model block only.
const modelMatch = schema.match(/\nmodel RiaCanonicalReferent \{\n([\s\S]*?)\n\}/);
const model = modelMatch ? modelMatch[1] : "";
// Field lines only (drop /// doc-comments and blank lines) so text scans mean "a real field".
const fieldLines = model
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("///"));
const fieldText = fieldLines.join("\n");

// ── Model shape: opaque tenant-scoped anchor ────────────────────────────────────
section("Canonical Referent — model shape (opaque, tenant-scoped anchor)");
check("model RiaCanonicalReferent is defined", model.length > 0);
check(
  "id is storage-only Int autoincrement PK (not real-world identity)",
  /^id\s+Int\s+@id\s+@default\(autoincrement\(\)\)$/m.test(fieldText),
);
check("businessId is a required Int (tenant scope, non-nullable)", /^businessId\s+Int$/m.test(fieldText));
check(
  "business relation is RESTRICT on delete (never repo-default Cascade)",
  /^business\s+Business\s+@relation\(fields:\s*\[businessId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)$/m.test(
    fieldText,
  ),
);
check("business relation does NOT use onDelete: Cascade", !/onDelete:\s*Cascade/.test(model));
check("referentType is a governed String slot", /^referentType\s+String$/m.test(fieldText));
check(
  "referentType is NOT an enum (no enum RiaReferentType / RiaCanonicalReferentType in schema)",
  !/\benum\s+Ria\w*ReferentType\b/.test(schema),
);
check("referentType has no default / no allowed-values validation", !/^referentType\s+String\s+@/m.test(fieldText));
check(
  "createdAt is recorded-only DateTime @default(now())",
  /^createdAt\s+DateTime\s+@default\(now\(\)\)$/m.test(fieldText),
);
check("tenant index @@index([businessId]) is present", /@@index\(\[businessId\]\)/.test(model));

// ── Anchor, not truth container: no uniqueness on identity signals ───────────────
section("Anchor, not truth container — duplicate referents are legal");
check("NO @@unique on the model (no uniqueness on any identity signal)", !/@@unique/.test(model));
check("NO @unique field attribute on the model", !/@unique/.test(model));

// ── No mutable semantic state, no identity truth, no PII ─────────────────────────
section("Inert substrate — no mutable semantic state, no identity truth, no PII");
const FORBIDDEN_FIELDS = [
  "updatedAt",
  "status",
  "active",
  "isActive",
  "confidence",
  "method",
  "source",
  "verified",
  "mergedInto",
  "supersededBy",
  "canonical",
  "preferred",
  "priority",
  "metadata",
  "effectiveFrom",
  "effectiveAt",
  "validFrom",
  // identity-truth / PII signals that must never live on the anchor
  "name",
  "displayName",
  "phone",
  "email",
  "taxId",
  "nationalId",
  "companyId",
  "customerId",
  "supplierId",
  "partyId",
];
for (const f of FORBIDDEN_FIELDS) {
  check(
    `no forbidden field "${f}" on the substrate`,
    !new RegExp(`^${f}\\b`, "m").test(fieldText),
  );
}
// The substrate carries EXACTLY four fields + one relation + one index.
check(
  "substrate carries exactly four scalar fields (id, businessId, referentType, createdAt)",
  fieldLines.filter((l) => /^(id|businessId|referentType|createdAt)\b/.test(l)).length === 4,
);
check(
  "substrate carries exactly one relation field (business)",
  fieldLines.filter((l) => /^business\b/.test(l)).length === 1,
);

// ── Migration is additive-only ──────────────────────────────────────────────────
section("Migration — additive only, no mutation of existing tables");
check("creates the RiaCanonicalReferent table", /CREATE TABLE "RiaCanonicalReferent"/.test(migration));
check("creates the tenant index", /CREATE INDEX "RiaCanonicalReferent_businessId_idx"/.test(migration));
check(
  "FK to Business is ON DELETE RESTRICT (not CASCADE)",
  /ADD CONSTRAINT "RiaCanonicalReferent_businessId_fkey"[\s\S]*ON DELETE RESTRICT/.test(migration),
);
check("migration contains no ON DELETE CASCADE", !/ON DELETE CASCADE/.test(migration));
check("migration has no DROP statement", !/\bDROP\b/i.test(migration));
// Match destructive DML precisely so the legitimate `ON DELETE RESTRICT` FK clause is not a hit.
check("migration has no DELETE FROM (no data transform)", !/\bDELETE\s+FROM\b/i.test(migration));
check("migration has no UPDATE … SET (no data transform)", !/\bUPDATE\s+"?[A-Za-z_]\w*"?\s+SET\b/i.test(migration));
check("migration has no TRUNCATE (no data transform)", !/\bTRUNCATE\b/i.test(migration));
check("migration has no INSERT (no backfill / seed)", !/\bINSERT\b/i.test(migration));
// The only ALTER TABLE permitted is on the NEW table (adding its own FK).
const alterTargets = [...migration.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]);
check(
  "every ALTER TABLE targets only the new RiaCanonicalReferent table",
  alterTargets.length > 0 && alterTargets.every((t) => t === "RiaCanonicalReferent"),
);
for (const t of ["Business", "Party", "Customer", "Supplier", "PartyResolutionClaim"]) {
  check(`migration does not ALTER existing table "${t}"`, !alterTargets.includes(t));
}

// ── Non-interference with adjacent identity surfaces ────────────────────────────
section("Non-interference — adjacent identity surfaces untouched");
check("Business model still present", /\nmodel Business \{/.test(schema));
check(
  "Business gains only the back-relation array (virtual, no column)",
  /riaCanonicalReferents\s+RiaCanonicalReferent\[\]/.test(schema),
);
check("Customer @@unique([businessId, phone]) preserved", /@@unique\(\[businessId, phone\]\)/.test(schema));
check("Party model still present and untouched by this slice", /\nmodel Party \{/.test(schema));

// ── report ──────────────────────────────────────────────────────────────────────
section("RIA-IMPL-1 structural invariants");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("All RIA-IMPL-1 substrate invariants hold. Additive + inert. ✔");
