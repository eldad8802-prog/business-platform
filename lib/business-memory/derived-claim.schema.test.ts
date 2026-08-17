/**
 * Business Memory IMPL-4 — Derived Claim substrate · structural invariant test. Run: npx tsx.
 *
 * Source of truth:
 *   docs/business-brain-evidence-memory-contract-v1.md            (INV-6/7/8/9/10/13)
 *   docs/business-brain-memory-claim-persistence-preimplementation-v2.md (§24 conceptual minimum; verdict A / M1)
 *
 * STATIC test: reads prisma/schema.prisma + the substrate migration.sql as text and asserts the
 * additive / inert / derived / droppable / policy-pinned / evidence-linked / tenant-local invariants.
 * Touches NO database, opens NO connection, imports NO Prisma client.
 *
 * Proves: 3 models (Projection + Candidate + EvidenceLink); state NOT stored (no state/status column);
 * NO confidence; policy FK RESTRICT; Cascade only INSIDE the derived hierarchy; EvidenceLink has NO FK
 * to ReviewEvent (scalar ref); precedence-free identities; no truth/current/latest/preferred/updatedAt/
 * isGlobal/Json; migration additive-only; VendorLearning / RIA / policy substrate untouched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const ROOT = join(__dirname, "..", "..");
const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
const migrationRaw = readFileSync(
  join(ROOT, "prisma", "migrations", "20260818120000_add_derived_claim_substrate", "migration.sql"),
  "utf8",
).replace(/\r\n/g, "\n");
const migration = migrationRaw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

function modelBlock(name: string): string {
  const m = schema.match(new RegExp(`\\nmodel ${name} \\{\\n([\\s\\S]*?)\\n\\}`));
  return m ? m[1] : "";
}
function fieldLines(block: string): string {
  return block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("///")).join("\n");
}

const projection = modelBlock("DerivedClaimProjection");
const candidate = modelBlock("DerivedClaimCandidate");
const link = modelBlock("DerivedClaimEvidenceLink");
const projF = fieldLines(projection);
const candF = fieldLines(candidate);
const linkF = fieldLines(link);
const derivedAll = projF + "\n" + candF + "\n" + linkF;

// forbidden across ALL three derived models (pre-impl v2 §15/§24)
const FORBIDDEN = [
  "state", "status", "confidence", "score", "weight", "probability",
  "current", "currentVersion", "latest", "active", "isActive", "preferred", "selected",
  "priority", "rank", "order", "ordinal", "sequence",
  "truth", "verified", "ownerApproved", "approved", "recommendation", "action", "cta",
  "isGlobal", "updatedAt", "supersededBy", "previousProjection", "generation",
];

// ── Presence ─────────────────────────────────────────────────────────────────────────────────────
section("Presence — exactly three derived models");
check("DerivedClaimProjection defined", projection.length > 0);
check("DerivedClaimCandidate defined", candidate.length > 0);
check("DerivedClaimEvidenceLink defined", link.length > 0);

// ── Projection ───────────────────────────────────────────────────────────────────────────────────
section("Projection — derived cache, tenant-local, policy-pinned");
check("businessId required", /^businessId\s+Int$/m.test(projF));
check("subjectDomain + subjectNormalizedKey present", /^subjectDomain\s+String$/m.test(projF) && /^subjectNormalizedKey\s+String$/m.test(projF));
check("claimType governed String (not enum)", /^claimType\s+String$/m.test(projF));
check("policyVersionId present", /^policyVersionId\s+Int$/m.test(projF));
check("evidenceSetFingerprint present (staleness aid, not authority)", /^evidenceSetFingerprint\s+String$/m.test(projF));
check("materializedAt recorded-only DateTime @default(now())", /^materializedAt\s+DateTime\s+@default\(now\(\)\)$/m.test(projF));
check("policyVersion FK is onDelete: Restrict", /policyVersion\s+DerivationPolicyVersion\s+@relation\([^)]*onDelete:\s*Restrict\)/.test(projection));
check("Business FK is onDelete: Cascade (derived cache cleaned with tenant)", /business\s+Business\s+@relation\([^)]*onDelete:\s*Cascade\)/.test(projection));
check("identity = (businessId, subjectDomain, subjectNormalizedKey, claimType, policyVersionId)",
  /@@unique\(\[businessId,\s*subjectDomain,\s*subjectNormalizedKey,\s*claimType,\s*policyVersionId\]\)/.test(projection));

// ── Candidate ────────────────────────────────────────────────────────────────────────────────────
section("Candidate — proposition, conflict via co-existence (no winner)");
check("projectionId + propositionValue present", /^projectionId\s+Int$/m.test(candF) && /^propositionValue\s+String$/m.test(candF));
check("Cascade from Projection", /projection\s+DerivedClaimProjection\s+@relation\([^)]*onDelete:\s*Cascade\)/.test(candidate));
check("identity (projectionId, propositionValue) — enables candidate-set conflict", /@@unique\(\[projectionId,\s*propositionValue\]\)/.test(candidate));

// ── EvidenceLink ─────────────────────────────────────────────────────────────────────────────────
section("EvidenceLink — reference only, NO ReviewEvent FK, tenant field");
check("candidateId + businessId + evidenceKind + evidenceRecordId present",
  /^candidateId\s+Int$/m.test(linkF) && /^businessId\s+Int$/m.test(linkF) && /^evidenceKind\s+String$/m.test(linkF) && /^evidenceRecordId\s+Int$/m.test(linkF));
check("Cascade from Candidate", /candidate\s+DerivedClaimCandidate\s+@relation\([^)]*onDelete:\s*Cascade\)/.test(link));
check("NO FK/relation to ReviewEvent (store-agnostic scalar ref)", !/ReviewEvent/.test(linkF));
check("identity (candidateId, evidenceKind, evidenceRecordId)", /@@unique\(\[candidateId,\s*evidenceKind,\s*evidenceRecordId\]\)/.test(link));
check("no raw evidence payload (no Json field)", !/\bJson\b/.test(link));

// ── No state / no confidence / forbidden fields ──────────────────────────────────────────────────
section("No stored state · no confidence · no precedence/truth (pre-impl v2 §15)");
for (const bad of FORBIDDEN) {
  check(`no forbidden field "${bad}" on any derived model`, !new RegExp(`^${bad}\\b`, "m").test(derivedAll));
}
check("no Json anywhere in the three models", !/\bJson\b/.test(projection + candidate + link));
check("no confidence/score/weight (case-insensitive)", !/\b(confidence|score|weight|probability)\b/i.test(derivedAll));

// ── No coupling ──────────────────────────────────────────────────────────────────────────────────
section("No VendorLearning / RIA / C1 coupling");
check("no VendorLearning relation/field", !/VendorLearning|vendorLearning/.test(projection + candidate + link));
check("no RIA relation/field", !/\bRia[A-Z]/.test(projection + candidate + link));
check("no Detection/Equality coupling", !/\b(Detection|Equality)\b/.test(projection + candidate + link));

// ── Migration — additive only, correct FK semantics ──────────────────────────────────────────────
section("Migration — additive only, cascade inside derived hierarchy, RESTRICT to policy");
check("creates DerivedClaimProjection", /CREATE TABLE "DerivedClaimProjection"/.test(migration));
check("creates DerivedClaimCandidate", /CREATE TABLE "DerivedClaimCandidate"/.test(migration));
check("creates DerivedClaimEvidenceLink", /CREATE TABLE "DerivedClaimEvidenceLink"/.test(migration));
check("policy FK is ON DELETE RESTRICT", /DerivedClaimProjection_policyVersionId_fkey[\s\S]*?REFERENCES "DerivationPolicyVersion"[\s\S]*?ON DELETE RESTRICT/.test(migration));
check("Business FK is ON DELETE CASCADE", /DerivedClaimProjection_businessId_fkey[\s\S]*?REFERENCES "Business"[\s\S]*?ON DELETE CASCADE/.test(migration));
check("Candidate→Projection is ON DELETE CASCADE", /DerivedClaimCandidate_projectionId_fkey[\s\S]*?REFERENCES "DerivedClaimProjection"[\s\S]*?ON DELETE CASCADE/.test(migration));
check("EvidenceLink→Candidate is ON DELETE CASCADE", /DerivedClaimEvidenceLink_candidateId_fkey[\s\S]*?REFERENCES "DerivedClaimCandidate"[\s\S]*?ON DELETE CASCADE/.test(migration));
check("NO FK to ReviewEvent in migration", !/REFERENCES "ReviewEvent"/.test(migration));
check("no DROP", !/\bDROP\b/i.test(migration));
check("no data transform (no DELETE/UPDATE…SET/TRUNCATE/INSERT)",
  !/\bDELETE\s+FROM\b/i.test(migration) && !/\bUPDATE\s+"?[A-Za-z_]\w*"?\s+SET\b/i.test(migration) && !/\bTRUNCATE\b/i.test(migration) && !/\bINSERT\b/i.test(migration));
const alterTargets = [...migration.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]);
check("every ALTER TABLE targets only the 3 new derived tables (its own FKs)",
  alterTargets.length > 0 && alterTargets.every((t) => ["DerivedClaimProjection", "DerivedClaimCandidate", "DerivedClaimEvidenceLink"].includes(t)));

// ── Non-interference ─────────────────────────────────────────────────────────────────────────────
section("Non-interference — existing substrates untouched");
check("VendorLearning still present + unchanged key", /\nmodel VendorLearning \{[\s\S]*@@unique\(\[businessId, vendorName\]\)/.test(schema));
check("DerivationPolicyVersion still present (policy substrate)", /\nmodel DerivationPolicyVersion \{/.test(schema));
check("RiaPolicyLineage still present (RIA untouched)", /\nmodel RiaPolicyLineage \{/.test(schema));
check("migration does not touch VendorLearning / Ria* / ReviewEvent / policy tables",
  !alterTargets.some((t) => /VendorLearning|Ria|ReviewEvent|ExtractionSnapshot|SliceDecision|DerivationPolicy/.test(t)));

// ── report ──────────────────────────────────────────────────────────────────────────────────────
section("Business Memory IMPL-4 · Derived Claim substrate invariants");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("All IMPL-4 Derived Claim substrate invariants hold. Additive · inert · derived · droppable. ✔");
