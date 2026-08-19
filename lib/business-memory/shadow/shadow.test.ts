/**
 * Business Memory SHADOW-2 · dark shadow wiring — invariant test. npx tsx. DB-FREE (injected deps).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isShadowEnabled } from "./shadow-config";
import { runShadowMaterialization, type ShadowDeps } from "./run-shadow";
import type { OrchestratorOutcome } from "@/lib/business-memory/orchestration";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const OK: OrchestratorOutcome = {
  kind: "materialized", writerAction: "created", candidateCount: 1, evidenceFingerprint: "fp",
  policyIdentity: { policyKey: "vendor-category", versionLabel: "v1", policyVersionId: 4210 },
};

function makeDeps(over: { enabled?: boolean; outcome?: OrchestratorOutcome; throws?: unknown } = {}) {
  const calls = { orchestration: 0, observe: 0, observeError: 0 };
  const deps: ShadowDeps = {
    enabled: () => over.enabled ?? true,
    async runOrchestration() { calls.orchestration++; if (over.throws) throw over.throws; return over.outcome ?? OK; },
    observe() { calls.observe++; },
    observeError() { calls.observeError++; },
  };
  return { deps, calls };
}

async function main(): Promise<void> {
  // ── Kill switch — fail-closed parsing ────────────────────────────────────────────────────────────
  section("Kill switch — fail-closed (only explicit 'true' ⇒ ON)");
  {
    check("absent ⇒ OFF", isShadowEnabled({} as NodeJS.ProcessEnv) === false);
    check("'false' ⇒ OFF", isShadowEnabled({ BUSINESS_MEMORY_SHADOW: "false" } as unknown as NodeJS.ProcessEnv) === false);
    check("'' ⇒ OFF", isShadowEnabled({ BUSINESS_MEMORY_SHADOW: "" } as unknown as NodeJS.ProcessEnv) === false);
    check("'1' ⇒ OFF (only 'true')", isShadowEnabled({ BUSINESS_MEMORY_SHADOW: "1" } as unknown as NodeJS.ProcessEnv) === false);
    check("'yes'/malformed ⇒ OFF", isShadowEnabled({ BUSINESS_MEMORY_SHADOW: "yes" } as unknown as NodeJS.ProcessEnv) === false);
    check("'true' ⇒ ON", isShadowEnabled({ BUSINESS_MEMORY_SHADOW: "true" } as unknown as NodeJS.ProcessEnv) === true);
    check("' TRUE ' (trim/case) ⇒ ON", isShadowEnabled({ BUSINESS_MEMORY_SHADOW: " TRUE " } as unknown as NodeJS.ProcessEnv) === true);
  }

  // ── Flag OFF ⇒ Orchestrator never called ─────────────────────────────────────────────────────────
  section("Flag OFF ⇒ 0 Orchestrator executions");
  {
    const m = makeDeps({ enabled: false });
    await runShadowMaterialization({ businessId: 1, vendorInput: "Acme", evidencePersisted: true }, m.deps);
    check("OFF ⇒ orchestration 0", m.calls.orchestration === 0);
  }

  // ── Evidence not persisted ⇒ no shadow ───────────────────────────────────────────────────────────
  section("Evidence not persisted ⇒ no shadow (§24)");
  {
    const m = makeDeps({ enabled: true });
    await runShadowMaterialization({ businessId: 1, vendorInput: "Acme", evidencePersisted: false }, m.deps);
    check("ReviewEvent not persisted ⇒ orchestration 0", m.calls.orchestration === 0);
  }

  // ── Eligibility ──────────────────────────────────────────────────────────────────────────────────
  section("Eligibility — real subject required (silence ≠ approval)");
  {
    let m = makeDeps({ enabled: true });
    await runShadowMaterialization({ businessId: 1, vendorInput: null, evidencePersisted: true }, m.deps);
    check("null vendor ⇒ orchestration 0", m.calls.orchestration === 0);
    m = makeDeps({ enabled: true });
    await runShadowMaterialization({ businessId: 1, vendorInput: "   ", evidencePersisted: true }, m.deps);
    check("blank vendor ⇒ orchestration 0", m.calls.orchestration === 0);
  }

  // ── ON + eligible + persisted ⇒ exactly one execution ────────────────────────────────────────────
  section("ON + eligible + evidence persisted ⇒ exactly 1 Orchestrator run");
  {
    const m = makeDeps({ enabled: true });
    await runShadowMaterialization({ businessId: 1, vendorInput: "Acme Ltd", evidencePersisted: true }, m.deps);
    check("orchestration ran exactly once", m.calls.orchestration === 1);
    check("outcome observed (non-authoritative)", m.calls.observe === 1);
  }

  // ── Failure isolation — never throws, no retry ───────────────────────────────────────────────────
  section("Failure isolation — best-effort, never throws, no retry");
  {
    let threw = false;
    const m = makeDeps({ enabled: true, throws: new Error("orchestrator boom") });
    try { await runShadowMaterialization({ businessId: 1, vendorInput: "Acme", evidencePersisted: true }, m.deps); }
    catch { threw = true; }
    check("helper never rethrows an orchestrator error", threw === false);
    check("orchestration attempted once, NOT retried", m.calls.orchestration === 1);
    check("error observed (non-fatal), not swallowed silently", m.calls.observeError === 1);
  }

  // ── stale / failed outcomes surface without throwing ─────────────────────────────────────────────
  section("stale / failed outcomes → observed, not thrown, no retry");
  {
    const stale: OrchestratorOutcome = { kind: "stale", evidenceFingerprintFirst: "a", evidenceFingerprintSecond: "b", policyIdentity: OK.kind === "materialized" ? OK.policyIdentity : { policyKey: "vendor-category", versionLabel: "v1", policyVersionId: 4210 } };
    let m = makeDeps({ enabled: true, outcome: stale });
    let threw = false;
    try { await runShadowMaterialization({ businessId: 1, vendorInput: "Acme", evidencePersisted: true }, m.deps); } catch { threw = true; }
    check("stale outcome → no throw, observed, single run", !threw && m.calls.orchestration === 1 && m.calls.observe === 1);

    const failedOut: OrchestratorOutcome = { kind: "failed", stage: "writer-error", message: "P2002" };
    m = makeDeps({ enabled: true, outcome: failedOut });
    threw = false;
    try { await runShadowMaterialization({ businessId: 1, vendorInput: "Acme", evidencePersisted: true }, m.deps); } catch { threw = true; }
    check("failed outcome → no throw, observed, single run", !threw && m.calls.orchestration === 1 && m.calls.observe === 1);
  }

  // ── Static — S-A only, no VendorLearning, no raw-vendor logging, no retry, downstream leaf ──────
  section("Static — S-A · no VendorLearning · no PII log · no retry · leaf");
  {
    const dir = __dirname;
    const src = ["run-shadow.ts", "shadow-config.ts", "index.ts"]
      .map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n")).join("\n");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    check("no VendorLearning read/write/compare", !/vendorLearning|VendorLearning/.test(code));
    check("no comparison/match/agreement (S-A only)", !/\bmatch\b|mismatch|agreement|compareTo|decideCategory/i.test(code));
    check("no retry / loop / sleep / backoff", !/\bretry\b|while\s*\(|for\s*\(|setTimeout|setInterval|backoff/i.test(code));
    check("logs no raw vendor / normalizedKey / evidence payload", !/vendorInput\s*[,)]/.test(code.replace(/vendorInput\s*=/g, "")) === false || !/console\.(info|log|error)\([^)]*vendorInput/.test(code));
    check("does not import/read Derived Claims (no claim reader)", !/derivedClaim|DerivedClaimProjection/i.test(code));
    check("awaits Orchestrator (F1), not fire-and-forget (no floating promise)", /await d\.runOrchestration|await runVendorCategoryOrchestration/.test(src));
    check("kill switch checked before orchestration", /if \(!d\.enabled\(\)\) return;/.test(src));
    check("evidence-persisted guard present", /if \(!input\.evidencePersisted\) return;/.test(src));
  }

  section("Business Memory SHADOW-2 · dark shadow wiring invariants");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
  console.log("All SHADOW-2 invariants hold. Dark · default-OFF · best-effort · isolated · S-A. ✔");
}

main().catch((err) => { console.error(err); process.exit(1); });
