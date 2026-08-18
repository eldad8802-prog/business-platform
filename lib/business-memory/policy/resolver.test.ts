/**
 * Business Memory IMPL-5B · Policy Resolver — invariant test. npx tsx. DB-FREE (injected fake client).
 */
import { resolveDerivationPolicyVersion, resolveVendorCategoryPolicyVersion } from "./resolver";
import { PolicyResolutionFailed, type PolicyResolverClient } from "./resolver.contract";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }
async function rejects(name: string, fn: () => Promise<unknown>): Promise<void> {
  let threw: unknown = null;
  try { await fn(); } catch (e) { threw = e; }
  check(name, threw instanceof PolicyResolutionFailed);
}

// Fake registry: policies by key, versions keyed by (policyId, version). Arbitrary ids (never 1) to
// prove environment-independent resolution.
type Policy = { key: string; id: number; versions: Array<{ version: string; id: number }> };
function makeClient(policies: Policy[]) {
  const byKey = new Map(policies.map((p) => [p.key, p]));
  const byPv = new Map<string, number>();
  for (const p of policies) for (const v of p.versions) byPv.set(`${p.id}|${v.version}`, v.id);
  const calls = { policyFindUnique: 0, versionFindUnique: 0 };
  const client: PolicyResolverClient = {
    derivationPolicy: {
      async findUnique({ where }) { calls.policyFindUnique++; const p = byKey.get(where.key); return p ? { id: p.id } : null; },
    },
    derivationPolicyVersion: {
      async findUnique({ where }) { calls.versionFindUnique++; const id = byPv.get(`${where.policyId_version.policyId}|${where.policyId_version.version}`); return id != null ? { id } : null; },
    },
  };
  return { client, calls };
}

async function main(): Promise<void> {
  // ── Exact resolution, environment-independent ids ──────────────────────────────────────────────
  section("Exact key+version resolution (arbitrary DB ids — no id=1 assumption)");
  {
    const { client } = makeClient([{ key: "vendor-category", id: 7, versions: [{ version: "v1", id: 4210 }] }]);
    const r = await resolveDerivationPolicyVersion({ policyKey: "vendor-category", versionLabel: "v1" }, client);
    check("resolves to the exact policyVersionId", r.policyVersionId === 4210);
    check("returns resolved policyId + echoes key/version", r.policyId === 7 && r.policyKey === "vendor-category" && r.versionLabel === "v1");
    check("no assumption that id=1", r.policyId !== 1 && r.policyVersionId !== 1);
  }

  // ── Missing lineage / version → fail closed ───────────────────────────────────────────────────
  section("Fail-closed on missing lineage / version");
  {
    const { client } = makeClient([{ key: "vendor-category", id: 7, versions: [{ version: "v1", id: 4210 }] }]);
    await rejects("missing policy key fails", () => resolveDerivationPolicyVersion({ policyKey: "nope", versionLabel: "v1" }, client));
    await rejects("missing version fails", () => resolveDerivationPolicyVersion({ policyKey: "vendor-category", versionLabel: "v9" }, client));
    await rejects("empty policyKey rejected", () => resolveDerivationPolicyVersion({ policyKey: "", versionLabel: "v1" }, client));
    await rejects("empty versionLabel rejected", () => resolveDerivationPolicyVersion({ policyKey: "vendor-category", versionLabel: "" }, client));
  }

  // ── v2 coexistence — v2 does NOT supersede v1 ─────────────────────────────────────────────────
  section("v2 coexistence — binding, not latest");
  {
    const { client } = makeClient([{ key: "vendor-category", id: 7, versions: [{ version: "v1", id: 4210 }, { version: "v2", id: 4211 }] }]);
    const r1 = await resolveDerivationPolicyVersion({ policyKey: "vendor-category", versionLabel: "v1" }, client);
    const r2 = await resolveDerivationPolicyVersion({ policyKey: "vendor-category", versionLabel: "v2" }, client);
    check("resolve v1 → v1 (existence of v2 changes nothing)", r1.policyVersionId === 4210);
    check("resolve v2 → v2 (explicit, not 'latest')", r2.policyVersionId === 4211);
  }

  // ── Cross-lineage — same version label under different lineages ───────────────────────────────
  section("Cross-lineage — version label alone is not identity");
  {
    const { client } = makeClient([
      { key: "vendor-category", id: 7, versions: [{ version: "v1", id: 4210 }] },
      { key: "another-policy", id: 8, versions: [{ version: "v1", id: 9990 }] },
    ]);
    const a = await resolveDerivationPolicyVersion({ policyKey: "vendor-category", versionLabel: "v1" }, client);
    const b = await resolveDerivationPolicyVersion({ policyKey: "another-policy", versionLabel: "v1" }, client);
    check("vendor-category/v1 → its own version (scoped to lineage)", a.policyVersionId === 4210);
    check("another-policy/v1 → the OTHER version (no collision on label)", b.policyVersionId === 9990);
  }

  // ── Convenience binding resolves exact v1 ─────────────────────────────────────────────────────
  section("VENDOR_CATEGORY_POLICY convenience → exact v1");
  {
    const { client, calls } = makeClient([{ key: "vendor-category", id: 7, versions: [{ version: "v1", id: 4210 }] }]);
    const r = await resolveVendorCategoryPolicyVersion(client);
    check("resolves the canonical descriptor to v1", r.policyKey === "vendor-category" && r.versionLabel === "v1" && r.policyVersionId === 4210);
    check("used exactly findUnique (2 lookups), no scan", calls.policyFindUnique === 1 && calls.versionFindUnique === 1);
  }

  // ── Static: read-only, no selection, no Writer/Deriver/evidence/VendorLearning ─────────────────
  section("Static — read-only · no current/latest · no Writer/Deriver/evidence/VendorLearning");
  {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = __dirname;
    const code = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n")).join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    check("no findFirst", !/findFirst/.test(code));
    check("no orderBy / max / latest / current / active / default selection", !/orderBy|Math\.max|\blatest\b|currentVersion|\bactive\b|defaultVersion/i.test(code));
    check("no mutation (create/update/upsert/delete)", !/\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\s*\(/.test(code));
    check("no hardcoded numeric policy/version id", !/policyVersionId\s*[:=]\s*\d/.test(code) && !/version\.id\s*=\s*\d/.test(code));
    check("no Writer invocation", !/materializeClaim/.test(code));
    check("no Deriver invocation", !/deriveVendorCategory\b|deriveVendorCategoryCandidates/.test(code));
    check("no Evidence Adapter read", !/readOwnerDecisionEvidence|business-memory\/evidence/.test(code));
    check("no VendorLearning", !/vendorLearning|VendorLearning/.test(code));
    check("no RIA / C1", !/referent-identity|\bRia[A-Z]|detection-grammar/.test(code));
    check("single source of truth: uses VENDOR_CATEGORY_POLICY (no duplicated 'vendor-category' literal in resolver.ts logic)",
      (readFileSync(join(dir, "resolver.ts"), "utf8").match(/"vendor-category"/g) ?? []).length === 0);
  }

  section("Business Memory IMPL-5B · Policy Resolver invariants");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
  console.log("All IMPL-5B Policy-resolver invariants hold. Exact · binding · read-only · inert. ✔");
}

main().catch((err) => { console.error(err); process.exit(1); });
