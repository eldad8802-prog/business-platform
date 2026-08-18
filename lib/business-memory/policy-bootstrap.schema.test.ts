/**
 * Business Memory POLICY-2 — Policy identity revision + canonical bootstrap · invariant test. npx tsx.
 *
 * Source of truth:
 *   docs/business-brain-derivation-policy-bootstrap-resolution-v1.md (verdict C; D1=B1, D2=R1, D3=W-A)
 *
 * STATIC / DB-FREE: reads prisma/schema.prisma, the bootstrap migration.sql, and the governed code
 * descriptor as text. Asserts: the `key` governed identity is unique; `name` stays a non-identity
 * descriptor; the identity hierarchy (id=storage / key=lineage / name=descriptor / version=version); the
 * bootstrap seeds EXACTLY vendor-category/v1 with NO hardcoded DB id and NO extra rows; no current/latest/
 * tenant/selector; additive-only; RESTRICT + immutability preserved.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const ROOT = join(__dirname, "..", "..");
const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
const migRaw = readFileSync(
  join(ROOT, "prisma", "migrations", "20260818130000_bootstrap_vendor_category_policy_v1", "migration.sql"),
  "utf8",
).replace(/\r\n/g, "\n");
const mig = migRaw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const descriptor = readFileSync(join(ROOT, "lib", "business-memory", "derivation", "vendor-category.policy.ts"), "utf8").replace(/\r\n/g, "\n");

function modelBlock(name: string): string {
  const m = schema.match(new RegExp(`\\nmodel ${name} \\{\\n([\\s\\S]*?)\\n\\}`));
  return m ? m[1] : "";
}
function fieldLines(b: string): string {
  return b.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("///")).join("\n");
}
const policy = modelBlock("DerivationPolicy");
const version = modelBlock("DerivationPolicyVersion");
const policyF = fieldLines(policy);
const versionF = fieldLines(version);

// ── Identity hierarchy (§3) ──────────────────────────────────────────────────────────────────────
section("Identity hierarchy — id(storage) / key(lineage) / name(descriptor) / version(version)");
check("id is storage-only Int autoincrement PK", /^id\s+Int\s+@id\s+@default\(autoincrement\(\)\)$/m.test(policyF));
check("key is a governed String @unique (lineage identity)", /^key\s+String\s+@unique$/m.test(policyF));
check("name is a String and is NOT unique (descriptor, not identity)", /^name\s+String$/m.test(policyF) && !/^name\s+String\s+@unique/m.test(policyF));
check("version is an identity String label", /^version\s+String$/m.test(versionF));
check("version uniqueness is ONLY within a policy: @@unique([policyId, version])", /@@unique\(\[policyId,\s*version\]\)/.test(version));
check("no global unique on the version label alone", !/@@unique\(\[version\]\)/.test(version) && !/^version\s+String\s+@unique/m.test(versionF));

// ── Global / no tenant, no selection (§9/§14) ────────────────────────────────────────────────────
section("Global / no tenant · no current/latest/selection");
check("DerivationPolicy has NO businessId", !/^businessId\b/m.test(policyF));
check("DerivationPolicyVersion has NO businessId", !/^businessId\b/m.test(versionF));
const SELECT_FORBIDDEN = ["current","currentVersion","currentVersionId","latest","latestVersion","active","activeVersionId","selected","preferred","default","defaultVersion","priority","rank","weight","precedence","order","effective","supersededBy","updatedAt","status","state","confidence","selector"];
for (const bad of SELECT_FORBIDDEN) {
  check(`no forbidden field "${bad}" on Policy/Version`, !new RegExp(`^${bad}\\b`, "m").test(policyF + "\n" + versionF));
}

// ── Delete / immutability (§13) ──────────────────────────────────────────────────────────────────
section("Delete / immutability preserved");
check("Version→Policy relation is onDelete: Restrict", /policy\s+DerivationPolicy\s+@relation\([^)]*onDelete:\s*Restrict\)/.test(version));
check("no updatedAt on Policy", !/^updatedAt\b/m.test(policyF));
check("no updatedAt on Version", !/^updatedAt\b/m.test(versionF));

// ── Migration: schema revision additive ──────────────────────────────────────────────────────────
section("Migration — additive schema revision");
check("ADD COLUMN key TEXT NOT NULL", /ALTER TABLE "DerivationPolicy" ADD COLUMN\s+"key" TEXT NOT NULL/.test(mig));
check("CREATE UNIQUE INDEX on key", /CREATE UNIQUE INDEX "DerivationPolicy_key_key" ON "DerivationPolicy"\("key"\)/.test(mig));
check("no DROP", !/\bDROP\b/i.test(mig));
check("only DerivationPolicy is ALTERed (no other existing table)", [...mig.matchAll(/ALTER TABLE "([^"]+)"/g)].every((m) => m[1] === "DerivationPolicy"));
check("no VendorLearning / Claim / ReviewEvent / RIA mutation", !/VendorLearning|DerivedClaim|ReviewEvent|Ria[A-Z]/.test(mig));

// ── Bootstrap: exactly vendor-category / v1, no hardcoded id ──────────────────────────────────────
section("Bootstrap — exactly one lineage + one version, deterministic, no hardcoded id");
const policyInserts = [...mig.matchAll(/INSERT INTO "DerivationPolicy"/g)].length;
const versionInserts = [...mig.matchAll(/INSERT INTO "DerivationPolicyVersion"/g)].length;
check("exactly ONE DerivationPolicy insert", policyInserts === 1);
check("exactly ONE DerivationPolicyVersion insert", versionInserts === 1);
check("lineage key = 'vendor-category'", /INSERT INTO "DerivationPolicy"[\s\S]*'vendor-category'/.test(mig));
check("version label = 'v1'", /INSERT INTO "DerivationPolicyVersion"[\s\S]*'v1'/.test(mig));
check("version insert resolves policyId via subquery on key (NOT a hardcoded id)",
  /INSERT INTO "DerivationPolicyVersion"[\s\S]*SELECT "id"[\s\S]*FROM "DerivationPolicy"[\s\S]*WHERE "key" = 'vendor-category'/.test(mig));
check("no hardcoded numeric policyId literal in any version insert", !/"policyId"\s*\)\s*VALUES\s*\(\s*\d+/.test(mig) && !/VALUES\s*\(\s*\d+\s*,\s*'v1'/.test(mig));
check("no other policy value seeded (no customer/inventory/ria)", !/'customer'|'inventory'|'ria'|'v2'/.test(mig));

// ── Governed code descriptor (§10) ───────────────────────────────────────────────────────────────
section("Governed code descriptor — key+label only, no DB id/hash/selection");
check("VENDOR_CATEGORY_POLICY exported with policyKey", /export const VENDOR_CATEGORY_POLICY\s*=\s*\{[\s\S]*policyKey:\s*"vendor-category"/.test(descriptor));
check("descriptor carries versionLabel 'v1'", /versionLabel:\s*"v1"/.test(descriptor));
check("descriptor has NO numeric DB id", !/policyVersionId\s*[:=]\s*\d/.test(descriptor) && !/\bid:\s*\d/.test(descriptor));
// Scan ONLY the object literal (not the surrounding doc comment, which legitimately says "no current/latest").
const descriptorObj = descriptor.match(/VENDOR_CATEGORY_POLICY\s*=\s*\{[^}]*\}/)?.[0] ?? "";
check("descriptor object has no current/latest/default/hash", !/\b(current|latest|default|hash|serialized)\b/i.test(descriptorObj));

// ── report ──────────────────────────────────────────────────────────────────────────────────────
section("Business Memory POLICY-2 invariants");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("All POLICY-2 invariants hold. Governed key identity + canonical vendor-category/v1 bootstrap. Additive · inert. ✔");
