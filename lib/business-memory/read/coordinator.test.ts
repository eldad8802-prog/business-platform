/**
 * Business Memory READ-3 · Read Coordinator — invariant/unit tests. npx tsx. No DB.
 *
 * Proves: incumbent always computed and returned as `effective`; fail-open for every non-supported/
 * non-fresh state; S2 freshness uses the exact evidence fingerprint (supported only); exact
 * vendor-category/v1 resolver; businessId propagated everywhere (no subject-only lookup); the memory
 * layer never throws; no re-derive/write/materialization.
 */
import { resolveVendorCategoryWithMemory } from "./coordinator";
import type { CoordinatorDeps, IncumbentDecision, VendorCategoryDecision } from "./coordinator.contract";
import type { ReadClaimQuery, ReadClaimResult } from "./read-claim.contract";
import type { DomainLocalSubject } from "@/lib/business-memory/evidence";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const INCUMBENT: IncumbentDecision = { category: "general", confidence: "low" };

type Overrides = {
  incumbent?: IncumbentDecision;
  decideCategoryThrow?: boolean;
  normalizedKey?: string;
  normalizeThrow?: boolean;
  resolverThrow?: boolean;
  policyVersionId?: number;
  claim?: ReadClaimResult;
  currentFp?: string;
  evidenceThrow?: boolean;
};

function makeDeps(o: Overrides = {}) {
  const calls = {
    decideCategory: 0,
    normalize: 0,
    resolvePolicyVersion: 0,
    readClaim: [] as ReadClaimQuery[],
    readEvidenceIdentity: [] as Array<{ businessId: number; subject: DomainLocalSubject }>,
  };
  const deps: CoordinatorDeps = {
    decideCategory: async () => { calls.decideCategory++; if (o.decideCategoryThrow) throw new Error("incumbent boom"); return o.incumbent ?? INCUMBENT; },
    normalize: () => { calls.normalize++; if (o.normalizeThrow) throw new Error("normalize boom"); return { normalizedKey: o.normalizedKey ?? "acme fuel" }; },
    resolvePolicyVersion: async () => { calls.resolvePolicyVersion++; if (o.resolverThrow) throw new Error("resolver boom"); return { policyKey: "vendor-category", versionLabel: "v1", policyVersionId: o.policyVersionId ?? 1 }; },
    readClaim: async (q) => { calls.readClaim.push(q); return o.claim ?? { status: "absent" }; },
    readEvidenceIdentity: async (businessId, subject) => { calls.readEvidenceIdentity.push({ businessId, subject }); if (o.evidenceThrow) throw new Error("evidence boom"); return { fingerprint: o.currentFp ?? "FP" }; },
  };
  return { deps, calls };
}
const input = { businessId: 7, vendorName: "Acme Fuel Ltd", text: "invoice" };

async function safe(o: Overrides): Promise<{ threw: boolean; r?: VendorCategoryDecision; calls: ReturnType<typeof makeDeps>["calls"] }> {
  const { deps, calls } = makeDeps(o);
  try { const r = await resolveVendorCategoryWithMemory(input, deps); return { threw: false, r, calls }; }
  catch { return { threw: true, calls }; }
}

async function main(): Promise<void> {
  section("Incumbent — always computed, always the effective decision");
  {
    const { r, calls } = await safe({ claim: { status: "absent" } });
    check("decideCategory invoked", calls.decideCategory === 1);
    check("incumbent returned unchanged", r?.incumbent.category === "general" && r?.incumbent.confidence === "low");
    check("effective === incumbent", r?.effective === r?.incumbent);
  }

  section("supported + fresh — memory candidate present, effective still incumbent");
  {
    const { r, calls } = await safe({ claim: { status: "supported", category: "fuel", candidateRefCount: 3, evidenceSetFingerprint: "FP" }, currentFp: "FP" });
    check("memory.status supported", r?.memory.status === "supported");
    check("memory.category = fuel", r?.memory.status === "supported" && r.memory.category === "fuel");
    check("memory.fresh = true", r?.memory.status === "supported" && r.memory.fresh === true);
    check("effective STILL incumbent (general), not fuel", r?.effective.category === "general" && r?.effective === r?.incumbent);
    check("observation outcome=memory-available, fingerprintMatch=true", r?.observation.outcome === "memory-available" && r?.observation.fingerprintMatch === true);
    check("freshness used exact fingerprint (1 evidence read)", calls.readEvidenceIdentity.length === 1);
  }

  section("supported + stale — fallback stale, effective incumbent");
  {
    const { r } = await safe({ claim: { status: "supported", category: "fuel", candidateRefCount: 1, evidenceSetFingerprint: "OLD" }, currentFp: "NEW" });
    check("memory.fresh = false", r?.memory.status === "supported" && r.memory.fresh === false);
    check("memory.fallbackReason = stale", r?.memory.status === "supported" && r.memory.fallbackReason === "stale");
    check("effective still incumbent", r?.effective === r?.incumbent);
    check("observation fallback + fingerprintMatch=false", r?.observation.outcome === "fallback" && r?.observation.fallbackReason === "stale" && r?.observation.fingerprintMatch === false);
  }

  section("Fail-open — every non-supported state → incumbent, no evidence read");
  for (const [name, claim, reason] of [
    ["absent", { status: "absent" }, "absent"],
    ["invalid", { status: "invalid", detail: "x" }, "invalid"],
    ["unavailable", { status: "unavailable", detail: "x" }, "unavailable"],
  ] as Array<[string, ReadClaimResult, string]>) {
    const { r, calls } = await safe({ claim });
    check(`${name} → memory.${name}, effective incumbent`, r?.memory.status === name && r?.effective === r?.incumbent);
    check(`${name} → fallbackReason ${reason}`, r?.observation.fallbackReason === reason);
    check(`${name} → NO evidence freshness read`, calls.readEvidenceIdentity.length === 0);
  }
  {
    const { r, calls } = await safe({ claim: { status: "conflicting", candidates: ["fuel", "tax"], evidenceSetFingerprint: "FP" } });
    check("conflicting → memory.conflicting, candidates preserved", r?.memory.status === "conflicting" && JSON.stringify((r?.memory as { candidates: string[] }).candidates) === JSON.stringify(["fuel", "tax"]));
    check("conflicting → NO winner picked (effective incumbent)", r?.effective === r?.incumbent && !("category" in (r?.memory ?? {})));
    check("conflicting → no evidence read", calls.readEvidenceIdentity.length === 0);
  }

  section("Failure isolation — resolver / evidence / unexpected → fallback, never throws");
  {
    const { threw, r, calls } = await safe({ resolverThrow: true });
    check("resolver throw does NOT throw", threw === false);
    check("resolver throw → unavailable/resolver-failure", r?.memory.status === "unavailable" && r?.observation.fallbackReason === "resolver-failure");
    check("resolver throw → readClaim NOT called", calls.readClaim.length === 0);
    check("resolver throw → effective incumbent", r?.effective === r?.incumbent);
  }
  {
    const { threw, r } = await safe({ claim: { status: "supported", category: "fuel", candidateRefCount: 1, evidenceSetFingerprint: "FP" }, evidenceThrow: true });
    check("evidence read throw does NOT throw", threw === false);
    check("evidence throw → evidence-failure fallback", r?.memory.status === "unavailable" && r?.observation.fallbackReason === "evidence-failure");
    check("evidence throw → effective incumbent", r?.effective === r?.incumbent);
  }
  {
    const { threw, r } = await safe({ normalizeThrow: true });
    check("normalize throw does NOT throw", threw === false);
    check("normalize throw → unexpected fallback", r?.memory.status === "unavailable" && r?.observation.fallbackReason === "unexpected");
  }

  section("Policy binding + tenant propagation + no subject-only lookup");
  {
    const { r, calls } = await safe({ claim: { status: "supported", category: "fuel", candidateRefCount: 1, evidenceSetFingerprint: "FP" }, currentFp: "FP", policyVersionId: 9 });
    check("resolver consulted (exact vendor-category/v1)", calls.resolvePolicyVersion === 1);
    const q = calls.readClaim[0];
    check("readClaim uses claimType vendor-category", q?.claimType === "vendor-category");
    check("readClaim uses resolved policyVersionId", q?.policyVersionId === 9);
    check("readClaim carries businessId (tenant)", q?.businessId === 7);
    check("readClaim subjectDomain vendor + normalized key", q?.subjectDomain === "vendor" && q?.subjectNormalizedKey === "acme fuel");
    check("no subject-only lookup (identity carries businessId)", typeof q?.businessId === "number" && q.businessId === 7);
    check("evidence read scoped to same tenant + subject", calls.readEvidenceIdentity[0]?.businessId === 7 && calls.readEvidenceIdentity[0]?.subject.businessId === 7 && calls.readEvidenceIdentity[0]?.subject.normalizedKey === "acme fuel");
    check("observation carries policy identity", r?.observation.policyKey === "vendor-category" && r?.observation.versionLabel === "v1" && r?.observation.policyVersionId === 9);
    check("observation has businessId + claimType, no category/subject/vendor leak", r?.observation.businessId === 7 && r?.observation.claimType === "vendor-category" && !("category" in (r?.observation ?? {})) && !("subjectNormalizedKey" in (r?.observation ?? {})) && !("vendorName" in (r?.observation ?? {})));
  }

  section("Incumbent-error semantics — propagates unchanged (no swallow, no fabrication)");
  {
    const { threw, calls } = await safe({ decideCategoryThrow: true });
    check("incumbent throw propagates (coordinator adds no new failure mode)", threw === true);
    check("memory work not attempted before incumbent", calls.readClaim.length === 0 && calls.resolvePolicyVersion === 0);
  }

  section("No re-derive / write / materialization");
  {
    const { calls } = await safe({ claim: { status: "supported", category: "fuel", candidateRefCount: 1, evidenceSetFingerprint: "FP" }, currentFp: "FP" });
    check("exactly one Claim read", calls.readClaim.length === 1);
    check("at most one evidence identity read (freshness only, no re-derive loop)", calls.readEvidenceIdentity.length === 1);
  }
}

main()
  .then(() => {
    section("Business Memory READ-3 · Read Coordinator");
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
    console.log("All READ-3 coordinator invariants hold. Fail-open · effective===incumbent · S2 read-only · inert. ✔");
  })
  .catch((e) => { console.error("test harness error:", e); process.exit(1); });
