/**
 * Business Memory IMPL-1 — Derivation Policy substrate · structural invariant test. Run: npx tsx.
 *
 * Source of truth:
 *   docs/business-brain-evidence-memory-contract-v1.md (RATIFIED — INV-2 policy versioning; INV-8/9)
 *   docs/business-brain-memory-architecture-v1.md (§7 Derivation Policy)
 *   docs/business-brain-memory-persistence-design-v1.md (§9)
 *
 * STATIC test: reads prisma/schema.prisma and the substrate migration.sql as text and asserts the
 * additive / inert / GLOBAL / immutable invariants. It touches NO database, opens NO connection,
 * imports NO Prisma client — runs in CI with no env and no DB.
 *
 * What it proves:
 *   - DerivationPolicy + DerivationPolicyVersion exist; Version links to Policy (INV-2).
 *   - GLOBAL: neither model has businessId or a Business relation (the derivation algorithm is
 *     platform-authored; INV-9 tenant-locality governs learned knowledge, not the algorithm).
 *   - (policyId, version) uniqueness is IDENTITY only — no precedence.
 *   - No current/latest/active/selected/preferred/default/priority/precedence/order/effective fields.
 *   - No Claim, confidence, selector, policy-content JSON, RIA/C1 coupling.
 *   - Immutable-by-representation (no updatedAt / status / mutable semantic state).
 *   - Delete: onDelete Restrict (never Cascade).
 *   - Migration additive-only; RiaPolicyLineage / RiaCanonicalReferent untouched.
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

// ── load artifacts (normalize CRLF for line-anchored scans) ──────────────────────
const ROOT = join(__dirname, "..", "..");
const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
const migrationRaw = readFileSync(
  join(ROOT, "prisma", "migrations", "20260817120000_add_derivation_policy_substrate", "migration.sql"),
  "utf8",
).replace(/\r\n/g, "\n");
// SQL-only view: strip `-- …` comments so destructive-keyword scans see executable statements only.
const migration = migrationRaw
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

function modelBlock(name: string): string {
  const m = schema.match(new RegExp(`\\nmodel ${name} \\{\\n([\\s\\S]*?)\\n\\}`));
  return m ? m[1] : "";
}
function fieldLines(block: string): string {
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("///"))
    .join("\n");
}

const policy = modelBlock("DerivationPolicy");
const version = modelBlock("DerivationPolicyVersion");
const policyF = fieldLines(policy);
const versionF = fieldLines(version);

// ── Presence + versioning ───────────────────────────────────────────────────────
section("Presence + versioning (INV-2)");
check("model DerivationPolicy is defined", policy.length > 0);
check("model DerivationPolicyVersion is defined", version.length > 0);
check("Policy id is storage-only Int autoincrement PK", /^id\s+Int\s+@id\s+@default\(autoincrement\(\)\)$/m.test(policyF));
check("Version id is storage-only Int autoincrement PK", /^id\s+Int\s+@id\s+@default\(autoincrement\(\)\)$/m.test(versionF));
check("Policy has a governed String `name`", /^name\s+String$/m.test(policyF));
check("Version links to Policy via policyId + relation", /^policyId\s+Int$/m.test(versionF) && /policy\s+DerivationPolicy\s+@relation/.test(version));
check("Version carries an identity `version` String label", /^version\s+String$/m.test(versionF));
check("Policy exposes versions back-relation", /versions\s+DerivationPolicyVersion\[\]/.test(policy));

// ── GLOBAL (no tenant) — INV-9 is about knowledge, not the algorithm ─────────────
section("GLOBAL / platform-authored — no tenant on the algorithm");
check("DerivationPolicy has NO businessId", !/^businessId\b/m.test(policyF));
check("DerivationPolicyVersion has NO businessId", !/^businessId\b/m.test(versionF));
check("DerivationPolicy has NO Business relation", !/\bBusiness\b/.test(policy));
check("DerivationPolicyVersion has NO Business relation", !/\bBusiness\b/.test(version));

// ── Identity uniqueness (NOT precedence) ─────────────────────────────────────────
section("Version identity uniqueness — NOT precedence");
check("@@unique([policyId, version]) present (identity uniqueness)", /@@unique\(\[policyId,\s*version\]\)/.test(version));
check("@@index([policyId]) present", /@@index\(\[policyId\]\)/.test(version));

// ── Anti-precedence / no selection / no currentness ──────────────────────────────
section("Anti-precedence / no selection / no currentness (INV-8)");
const FORBIDDEN = [
  "current", "currentVersion", "latest", "latestVersion", "active", "isActive", "isCurrent",
  "selected", "preferred", "default", "defaultVersion", "priority", "rank", "weight", "precedence",
  "order", "ordinal", "sequence",
  // effective/temporal beyond recorded-createdAt
  "effectiveFrom", "effectiveAt", "effectiveTo", "validFrom", "retiredAt", "activatedAt", "supersededBy",
  // mutable state / behavior / content
  "updatedAt", "status", "state", "confidence", "selector", "content", "policyContent", "definition",
  "serialized", "fn", "expression", "claim",
];
for (const f of [["DerivationPolicy", policyF], ["DerivationPolicyVersion", versionF]] as const) {
  for (const bad of FORBIDDEN) {
    check(`${f[0]} has no forbidden field "${bad}"`, !new RegExp(`^${bad}\\b`, "m").test(f[1]));
  }
}

// ── No behavior / no coupling ────────────────────────────────────────────────────
section("No behavior · no Claim · no RIA/C1 coupling");
check("no Json/policy-content field on Policy", !/\bJson\b/.test(policy));
check("no Json/policy-content field on Version", !/\bJson\b/.test(version));
check("no Claim / confidence in either model", !/\b(Claim|confidence)\b/i.test(policy + version));
check("no RIA coupling (no Ria* relation)", !/\bRia[A-Z]\w*/.test(policy + version));
check("no Detection/Equality coupling", !/\b(Detection|Equality|detection-grammar)\b/i.test(policy + version));

// ── Immutability (representation tier) ───────────────────────────────────────────
section("Immutability — representational");
check("Policy has no updatedAt", !/^updatedAt\b/m.test(policyF));
check("Version has no updatedAt", !/^updatedAt\b/m.test(versionF));
check("Policy createdAt is recorded-only DateTime @default(now())", /^createdAt\s+DateTime\s+@default\(now\(\)\)$/m.test(policyF));
check("Version createdAt is recorded-only DateTime @default(now())", /^createdAt\s+DateTime\s+@default\(now\(\)\)$/m.test(versionF));

// ── Delete safety ─────────────────────────────────────────────────────────────────
section("Delete safety — RESTRICT, never Cascade");
check("Version→Policy relation is onDelete: Restrict", /policy\s+DerivationPolicy\s+@relation\([^)]*onDelete:\s*Restrict\)/.test(version));
check("no onDelete: Cascade in either model", !/onDelete:\s*Cascade/.test(policy + version));

// ── Migration additive-only ──────────────────────────────────────────────────────
section("Migration — additive only, global");
check("creates DerivationPolicy table", /CREATE TABLE "DerivationPolicy"/.test(migration));
check("creates DerivationPolicyVersion table", /CREATE TABLE "DerivationPolicyVersion"/.test(migration));
check("FK is ON DELETE RESTRICT", /ADD CONSTRAINT "DerivationPolicyVersion_policyId_fkey"[\s\S]*ON DELETE RESTRICT/.test(migration));
check("no ON DELETE CASCADE", !/ON DELETE CASCADE/.test(migration));
check("no businessId column in migration (global)", !/"businessId"/.test(migration));
check("no DROP", !/\bDROP\b/i.test(migration));
check("no DELETE FROM / UPDATE … SET / TRUNCATE / INSERT (no data transform)",
  !/\bDELETE\s+FROM\b/i.test(migration) && !/\bUPDATE\s+"?[A-Za-z_]\w*"?\s+SET\b/i.test(migration) &&
  !/\bTRUNCATE\b/i.test(migration) && !/\bINSERT\b/i.test(migration));
const alterTargets = [...migration.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]);
check("every ALTER TABLE targets only DerivationPolicyVersion (its own FK)",
  alterTargets.length > 0 && alterTargets.every((t) => t === "DerivationPolicyVersion"));

// ── Non-interference: existing RIA / VendorLearning untouched ─────────────────────
section("Non-interference — existing substrates untouched");
check("RiaPolicyLineage still present (RIA untouched)", /\nmodel RiaPolicyLineage \{/.test(schema));
check("RiaCanonicalReferent still present (RIA untouched)", /\nmodel RiaCanonicalReferent \{/.test(schema));
check("VendorLearning still present + unchanged key", /\nmodel VendorLearning \{[\s\S]*@@unique\(\[businessId, vendorName\]\)/.test(schema));
check("migration does not touch VendorLearning / Ria* / ReviewEvent", !alterTargets.some((t) => /VendorLearning|Ria|ReviewEvent|ExtractionSnapshot|SliceDecision/.test(t)));

// ── report ──────────────────────────────────────────────────────────────────────
section("Business Memory IMPL-1 structural invariants");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("All IMPL-1 Derivation Policy invariants hold. Additive + inert + global + immutable. ✔");
