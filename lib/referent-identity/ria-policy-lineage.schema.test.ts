/**
 * RIA-IMPL-2 — Policy Lineage substrate · structural invariant test. Run: npx tsx.
 *
 * Governance source of truth:
 *   docs/referent-identity-authority-v1.md (§10 RP1/RP5/RP13/RP16/RP19, RATIFIED)
 *   docs/referent-identity-authority-persistence-design-v1.md (§11/§13/§15/§20/§28, Verdict A)
 *
 * Selected atomic boundary: Candidate A = Policy Lineage ONLY (Policy Version deferred to a later
 * additive slice — its RP2/RP6 content, effective applicability, provenance and governed
 * version-identity cannot be represented faithfully now without touching OPENs).
 *
 * STATIC test: reads prisma/schema.prisma and the RIA policy-lineage migration.sql as text and
 * asserts the additive/inert invariants. It touches NO database, opens NO connection, imports NO
 * Prisma client — runs in CI with no env and no DB.
 *
 * What it proves:
 *   - RiaPolicyLineage is a tenant-scoped GOVERNED-IDENTITY anchor, not an applicability decision:
 *     storage-only Int id (RP5: id is never the governed lineage identity), required businessId +
 *     Business relation, a governed `scope` String slot (NOT an enum), recorded-only createdAt.
 *   - NO uniqueness of any kind (RP5/RP19: identity is not a DB key/hash; duplicates legal).
 *   - NO version / current / active / latest / priority / selection field (no latest-wins).
 *   - NO successor/predecessor field (successor ≠ precedence).
 *   - NO effective-time field and NO implicit temporal default (§13/RP14).
 *   - NO relation to RiaCanonicalReferent (§20 — substrates not coupled without a contract).
 *   - NO PII, NO enum, NO Json, NO hash/digest.
 *   - Delete is onDelete: Restrict (never the repo-default Cascade).
 *   - The migration is additive-only; RiaCanonicalReferent / Party / Customer / Supplier untouched.
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

// ── load artifacts as text (no DB, no client); normalize CRLF for line-anchored scans ───────────
const ROOT = join(__dirname, "..", "..");
const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
const migrationRaw = readFileSync(
  join(ROOT, "prisma", "migrations", "20260815120000_add_ria_policy_lineage", "migration.sql"),
  "utf8",
).replace(/\r\n/g, "\n");
// SQL-only view: strip `-- …` comment lines so destructive-keyword scans see executable statements.
const migration = migrationRaw
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

// Extract the RiaPolicyLineage model block.
const modelMatch = schema.match(/\nmodel RiaPolicyLineage \{\n([\s\S]*?)\n\}/);
const model = modelMatch ? modelMatch[1] : "";
const fieldLines = model
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("///"));
const fieldText = fieldLines.join("\n");

// ── Model shape: governed-identity anchor ───────────────────────────────────────
section("Policy Lineage — model shape (tenant-scoped governed-identity anchor)");
check("model RiaPolicyLineage is defined", model.length > 0);
check(
  "id is storage-only Int autoincrement PK (RP5: not the governed lineage identity)",
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
check("scope is a governed String slot", /^scope\s+String$/m.test(fieldText));
check("scope has no default / no allowed-values attribute", !/^scope\s+String\s+@/m.test(fieldText));
check(
  "createdAt is recorded-only DateTime @default(now())",
  /^createdAt\s+DateTime\s+@default\(now\(\)\)$/m.test(fieldText),
);
check("tenant index @@index([businessId]) is present", /@@index\(\[businessId\]\)/.test(model));

// ── Anti-mechanization: identity is not a DB key/hash (RP5/RP19) ─────────────────
section("RP5/RP19 — governed identity is not a DB key/hash; duplicates legal");
check("NO @@unique on the model (no scope-signature key, no 'one per scope')", !/@@unique/.test(model));
check("NO @unique field attribute on the model", !/@unique/.test(model));

// ── No latest-wins / precedence / selection / version semantics (§5/§6/§9/RP13/RP19) ─────────────
section("No latest-wins / precedence / selection / version semantics");
const FORBIDDEN_FIELDS = [
  // version / selection / latest-wins surface
  "version",
  "currentVersion",
  "activeVersion",
  "defaultVersion",
  "current",
  "latest",
  "active",
  "isActive",
  "isCurrent",
  "preferred",
  "selected",
  "enabled",
  // precedence surface
  "priority",
  "rank",
  "weight",
  "precedence",
  "order",
  "sequence",
  "ordinal",
  // successor/supersession (successor ≠ precedence; deferred entirely in Lineage-only)
  "successor",
  "predecessor",
  "supersedes",
  "supersededBy",
  "priorId",
  // mutable semantic state
  "updatedAt",
  "status",
  "confidence",
  "method",
  "source",
  "verified",
  "mergedInto",
  "canonical",
  "metadata",
  // effective / applicability time (§13/RP14 — must be explicit, never defaulted; deferred here)
  "effectiveFrom",
  "effectiveAt",
  "effectiveTo",
  "validFrom",
  "validTo",
  "retiredAt",
  "appliesFrom",
  // coupling to Canonical Referent (§20) / identity truth / PII
  "referentId",
  "canonicalReferentId",
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
  check(`no forbidden field "${f}" on the substrate`, !new RegExp(`^${f}\\b`, "m").test(fieldText));
}

// ── §20 decoupling: no relation to Canonical Referent ───────────────────────────
section("§20 — Policy substrate is NOT coupled to Canonical Referent");
check(
  "model has no relation to RiaCanonicalReferent",
  !/RiaCanonicalReferent/.test(model),
);

// ── Discipline: enum / Json / hash (§24/§25/§26) ────────────────────────────────
section("Enum / JSON / hash discipline");
check("no new policy/scope/version enum defined in schema", !/\benum\s+Ria\w*(Policy|Scope|Version)\w*\b/.test(schema));
check("scope field type is String, not an enum reference", /^scope\s+String$/m.test(fieldText));
check("no Json field on the model", !/\bJson\b/.test(model));
check("no hash/digest/checksum field on the model", !/\b(hash|digest|checksum|sha\d*)\b/i.test(fieldText));

// ── Exactly four scalar fields + one relation ───────────────────────────────────
section("Minimality — exactly the required-info, nothing more");
check(
  "substrate carries exactly four scalar fields (id, businessId, scope, createdAt)",
  fieldLines.filter((l) => /^(id|businessId|scope|createdAt)\b/.test(l)).length === 4,
);
check(
  "substrate carries exactly one relation field (business)",
  fieldLines.filter((l) => /^business\b/.test(l)).length === 1,
);

// ── Migration is additive-only ──────────────────────────────────────────────────
section("Migration — additive only, no mutation of existing tables");
check("creates the RiaPolicyLineage table", /CREATE TABLE "RiaPolicyLineage"/.test(migration));
check("creates the tenant index", /CREATE INDEX "RiaPolicyLineage_businessId_idx"/.test(migration));
check(
  "FK to Business is ON DELETE RESTRICT (not CASCADE)",
  /ADD CONSTRAINT "RiaPolicyLineage_businessId_fkey"[\s\S]*ON DELETE RESTRICT/.test(migration),
);
check("migration contains no ON DELETE CASCADE", !/ON DELETE CASCADE/.test(migration));
check("migration has no DROP statement", !/\bDROP\b/i.test(migration));
check("migration has no DELETE FROM (no data transform)", !/\bDELETE\s+FROM\b/i.test(migration));
check("migration has no UPDATE … SET (no data transform)", !/\bUPDATE\s+"?[A-Za-z_]\w*"?\s+SET\b/i.test(migration));
check("migration has no TRUNCATE (no data transform)", !/\bTRUNCATE\b/i.test(migration));
check("migration has no INSERT (no backfill / seed)", !/\bINSERT\b/i.test(migration));
const alterTargets = [...migration.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]);
check(
  "every ALTER TABLE targets only the new RiaPolicyLineage table",
  alterTargets.length > 0 && alterTargets.every((t) => t === "RiaPolicyLineage"),
);
for (const t of ["Business", "Party", "Customer", "Supplier", "PartyResolutionClaim", "RiaCanonicalReferent"]) {
  check(`migration does not ALTER existing table "${t}"`, !alterTargets.includes(t));
}

// ── Non-interference with adjacent substrates ───────────────────────────────────
section("Non-interference — adjacent substrates untouched");
check("Business gains only the back-relation array (virtual, no column)", /riaPolicyLineages\s+RiaPolicyLineage\[\]/.test(schema));
check("RiaCanonicalReferent (RIA-IMPL-1) still present", /\nmodel RiaCanonicalReferent \{/.test(schema));
check(
  "RiaCanonicalReferent still uses onDelete: Restrict (unchanged)",
  /model RiaCanonicalReferent \{[\s\S]*onDelete:\s*Restrict[\s\S]*?\n\}/.test(schema),
);
check(
  "RiaCanonicalReferent still has no @@unique (unchanged)",
  !/model RiaCanonicalReferent \{[\s\S]*@@unique[\s\S]*?\n\}/.test(schema),
);
check("Customer @@unique([businessId, phone]) preserved", /@@unique\(\[businessId, phone\]\)/.test(schema));
check("Party model still present and untouched by this slice", /\nmodel Party \{/.test(schema));

// ── report ──────────────────────────────────────────────────────────────────────
section("RIA-IMPL-2 structural invariants");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("All RIA-IMPL-2 Policy Lineage invariants hold. Additive + inert. Decides no policy. ✔");
