/**
 * Business Memory READ-4 · Comparison-only wrapper — invariant/unit tests. npx tsx. No DB.
 *
 * Proves: flag OFF → incumbent only (Coordinator not called); flag ON → Coordinator once, incumbent
 * computed exactly once (no recursion / no duplicate lookup, precomputed injection); effective product
 * result is ALWAYS the incumbent (even supported+fresh+disagree); every memory-side failure → incumbent;
 * logger failure → incumbent; comparison metadata leaks no vendor/subject/category/evidence.
 */
import { categorySuggestionWithComparison, type ComparisonDeps, type ComparisonLog } from "./comparison-read";
import type { CoordinatorDeps, IncumbentDecision, VendorCategoryDecision } from "./coordinator.contract";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const INCUMBENT: IncumbentDecision = { category: "general", confidence: "low" };

function decision(partial: Partial<VendorCategoryDecision> & { memory: VendorCategoryDecision["memory"]; observation: VendorCategoryDecision["observation"] }): VendorCategoryDecision {
  return { incumbent: INCUMBENT, effective: INCUMBENT, ...partial };
}

type Opts = {
  enabled?: boolean;
  incumbent?: IncumbentDecision;
  decideThrow?: boolean;
  coordinatorThrow?: boolean;
  logThrow?: boolean;
  result?: VendorCategoryDecision;
};
function makeDeps(o: Opts = {}) {
  const calls = { decide: 0, coordinator: 0, logs: [] as ComparisonLog[], coordDeps: null as CoordinatorDeps | null };
  const deps: ComparisonDeps = {
    decideCategory: async () => { calls.decide++; if (o.decideThrow) throw new Error("incumbent boom"); return o.incumbent ?? INCUMBENT; },
    isReadEnabled: () => o.enabled ?? false,
    buildCoordinatorDeps: () => ({} as unknown as CoordinatorDeps),
    runCoordinator: async (_input, coordDeps) => { calls.coordinator++; calls.coordDeps = coordDeps; if (o.coordinatorThrow) throw new Error("coord boom"); return o.result as VendorCategoryDecision; },
    log: (e) => { calls.logs.push(e); if (o.logThrow) throw new Error("log boom"); },
  };
  return { deps, calls };
}
const run = (deps: ComparisonDeps) => categorySuggestionWithComparison(7, "Acme Fuel", "invoice", deps);

const supportedFresh = (category: string) => decision({
  memory: { status: "supported", category, fresh: true, fallbackReason: null },
  observation: { businessId: 7, claimType: "vendor-category", policyKey: "vendor-category", versionLabel: "v1", policyVersionId: 1, outcome: "memory-available", fallbackReason: null, fingerprintMatch: true },
});

async function main(): Promise<void> {
  section("Flag OFF (default) — incumbent only, coordinator never called");
  {
    const { deps, calls } = makeDeps({ enabled: false });
    const r = await run(deps);
    check("returns incumbent", r.category === "general");
    check("decideCategory called exactly once", calls.decide === 1);
    check("coordinator NOT called", calls.coordinator === 0);
    check("no comparison log emitted", calls.logs.length === 0);
  }

  section("Flag ON — coordinator once, incumbent computed once (no recursion / no duplicate lookup)");
  {
    const { deps, calls } = makeDeps({ enabled: true, result: supportedFresh("general") });
    await run(deps);
    check("decideCategory called EXACTLY once even when ON", calls.decide === 1);
    check("coordinator called once", calls.coordinator === 1);
    const injected = await calls.coordDeps!.decideCategory(0, "", "");
    check("coordinator received PRECOMPUTED incumbent (no recompute)", injected.category === "general" && calls.decide === 1);
  }

  section("Comparison-only — effective product result is ALWAYS incumbent");
  {
    const { deps, calls } = makeDeps({ enabled: true, result: supportedFresh("general") });
    const r = await run(deps);
    check("supported+fresh AGREE → incumbent, log comparison=agree", r.category === "general" && calls.logs[0]?.comparison === "agree");
  }
  {
    const { deps, calls } = makeDeps({ enabled: true, result: supportedFresh("fuel") });
    const r = await run(deps);
    check("supported+fresh DISAGREE → STILL incumbent (no override)", r.category === "general");
    check("disagree logged as disagree", calls.logs[0]?.comparison === "disagree");
  }

  section("Fail-open — every non-supported/failed state → incumbent");
  const cases: Array<[string, VendorCategoryDecision]> = [
    ["conflicting", decision({ memory: { status: "conflicting", candidates: ["fuel", "tax"], fallbackReason: "conflicting" }, observation: { businessId: 7, claimType: "vendor-category", outcome: "fallback", fallbackReason: "conflicting" } })],
    ["absent", decision({ memory: { status: "absent", fallbackReason: "absent" }, observation: { businessId: 7, claimType: "vendor-category", outcome: "fallback", fallbackReason: "absent" } })],
    ["stale", decision({ memory: { status: "supported", category: "fuel", fresh: false, fallbackReason: "stale" }, observation: { businessId: 7, claimType: "vendor-category", outcome: "fallback", fallbackReason: "stale", fingerprintMatch: false } })],
    ["unavailable", decision({ memory: { status: "unavailable", fallbackReason: "unavailable" }, observation: { businessId: 7, claimType: "vendor-category", outcome: "fallback", fallbackReason: "unavailable" } })],
  ];
  for (const [name, result] of cases) {
    const { deps, calls } = makeDeps({ enabled: true, result });
    const r = await run(deps);
    check(`${name} → incumbent, comparison not-applicable`, r.category === "general" && calls.logs[0]?.comparison === "not-applicable");
  }

  section("Failure isolation — coordinator throw / logger throw / never affects product");
  {
    let threw = false; let r;
    try { const { deps } = makeDeps({ enabled: true, coordinatorThrow: true }); r = await run(deps); } catch { threw = true; }
    check("coordinator throw → no throw, returns incumbent", threw === false && r?.category === "general");
  }
  {
    let threw = false; let r;
    try { const { deps } = makeDeps({ enabled: true, logThrow: true, result: supportedFresh("fuel") }); r = await run(deps); } catch { threw = true; }
    check("logger throw → no throw, returns incumbent", threw === false && r?.category === "general");
  }

  section("Durable log is AWAITED — completes within the invocation (not detached)");
  {
    // An async log that resolves on a later microtask; the wrapper must await it before returning.
    let logDone = false;
    const base = makeDeps({ enabled: true, result: supportedFresh("general") });
    const deps: ComparisonDeps = {
      ...base.deps,
      log: async () => { await Promise.resolve(); await Promise.resolve(); logDone = true; },
    };
    const r = await run(deps);
    check("async log completed BEFORE the wrapper returned", logDone === true);
    check("effective still incumbent after awaited log", r.category === "general");
  }
  {
    // Async log rejection is still caught → incumbent, never throws.
    let threw = false; let r;
    const base = makeDeps({ enabled: true, result: supportedFresh("fuel") });
    const deps: ComparisonDeps = { ...base.deps, log: async () => { throw new Error("async log boom"); } };
    try { r = await run(deps); } catch { threw = true; }
    check("async log rejection → no throw, returns incumbent", threw === false && r?.category === "general");
  }

  section("Privacy — comparison log carries no vendor/subject/category/evidence");
  {
    const { deps, calls } = makeDeps({ enabled: true, result: supportedFresh("fuel") });
    await run(deps);
    const log = calls.logs[0] as unknown as Record<string, unknown>;
    const allowed = new Set(["event", "businessId", "outcome", "fallbackReason", "policyKey", "versionLabel", "fingerprintMatch", "comparison"]);
    check("log keys ⊆ allowed set", Object.keys(log).every((k) => allowed.has(k)));
    for (const bad of ["vendorName", "normalizedSubject", "subjectNormalizedKey", "category", "memoryCategory", "incumbentCategory", "evidence", "evidenceRefs"]) {
      check(`log has no "${bad}"`, !(bad in log));
    }
    check("event tag = bm-read-comparison", log.event === "bm-read-comparison");
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
    console.log("All READ-4 comparison invariants hold. Dark-default · incumbent-once · effective===incumbent · privacy-safe. ✔");
  })
  .catch((e) => { console.error("test harness error:", e); process.exit(1); });
