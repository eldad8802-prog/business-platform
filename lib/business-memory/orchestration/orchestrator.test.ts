/**
 * Business Memory IMPL-6A · Single-Pass Orchestrator — invariant test. npx tsx. DB-FREE (injected deps).
 */
import { runVendorCategoryOrchestration } from "./orchestrator";
import { evidenceIdentityEquals } from "./evidence-identity";
import { MaterializationRejected } from "@/lib/business-memory/materialization";
import type { OrchestratorDeps } from "./orchestrator.contract";
import type { EvidenceRef, OwnerDecisionEvidenceSet, DomainLocalSubject } from "@/lib/business-memory/evidence";
import type { DerivedClaimResult } from "@/lib/business-memory/derivation";
import type { MaterializationOutcome } from "@/lib/business-memory/materialization";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
const SUBJECT: DomainLocalSubject = { domain: "vendor", normalizedKey: "acme", businessId: 1 };
const ref = (id: number): EvidenceRef => ({ kind: "review-event", businessId: 1, recordId: id });
function identity(ids: number[]) {
  const refs = ids.map(ref);
  return { refs, ordering: "occurredAt-asc,ordinal-asc" as const, fingerprint: refs.map((r) => `${r.kind}:${r.businessId}:${r.recordId}`).join("|") };
}
const evSet = (ids: number[]): OwnerDecisionEvidenceSet => ({ subject: SUBJECT, items: [], identity: identity(ids) });
function result(over: Partial<DerivedClaimResult> = {}): DerivedClaimResult {
  return {
    subject: SUBJECT, claimType: "vendor-category", policyVersionId: 4210,
    evidenceSetIdentity: identity([1, 2]), state: "supported",
    candidates: [{ claimType: "vendor-category", propositionValue: "Office", supportingRefs: [ref(1)] }],
    ...over,
  } as DerivedClaimResult;
}
const outcome = (action: MaterializationOutcome["action"], candidateCount = 1): MaterializationOutcome => ({
  action, slot: { businessId: 1, subjectDomain: "vendor", subjectNormalizedKey: "acme", claimType: "vendor-category", policyVersionId: 4210 },
  evidenceSetFingerprint: "fp", candidateCount, evidenceLinkCount: candidateCount,
});

type Over = {
  reads?: OwnerDecisionEvidenceSet[];        // sequence returned per read call (A, B, ...)
  resolveThrows?: unknown; readThrowsOn?: number; deriveThrows?: unknown; writeThrows?: unknown;
  derived?: DerivedClaimResult; writerOutcome?: MaterializationOutcome;
  capture?: { businessIds: number[]; writeCommand?: unknown };
};
function makeDeps(over: Over = {}) {
  const calls = { resolve: 0, read: 0, derive: 0, write: 0 };
  const bizSeen: number[] = [];
  let writeCommand: unknown;
  const deps: OrchestratorDeps = {
    async resolvePolicyVersion() { calls.resolve++; if (over.resolveThrows) throw over.resolveThrows; return { policyKey: "vendor-category", versionLabel: "v1", policyId: 7, policyVersionId: 4210 }; },
    async readOwnerDecisionEvidence(businessId) { calls.read++; bizSeen.push(businessId); if (over.readThrowsOn === calls.read) throw new Error("read failed"); return over.reads ? over.reads[calls.read - 1] : evSet([1, 2]); },
    deriveClaim(_set, policyVersionId) { calls.derive++; if (over.deriveThrows) throw over.deriveThrows; return over.derived ?? result({ policyVersionId }); },
    async writeClaim(command) { calls.write++; writeCommand = command; if (over.writeThrows) throw over.writeThrows; return over.writerOutcome ?? outcome("created"); },
  };
  return { deps, calls, bizSeen, getWriteCommand: () => writeCommand };
}

async function main(): Promise<void> {
  // ── Happy supported ────────────────────────────────────────────────────────────────────────────
  section("Happy supported → single write, materialized");
  {
    const m = makeDeps({ reads: [evSet([1, 2]), evSet([1, 2])] });
    const out = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "Acme Ltd" }, m.deps);
    check("outcome kind = materialized", out.kind === "materialized");
    check("call counts: resolve1 / read2 / derive1 / write1", m.calls.resolve === 1 && m.calls.read === 2 && m.calls.derive === 1 && m.calls.write === 1);
    check("Writer command carries the trusted businessId", (m.getWriteCommand() as { businessId: number }).businessId === 1);
    check("same trusted businessId across all reads", m.bizSeen.every((b) => b === 1));
  }

  // ── Conflict passes through untouched ────────────────────────────────────────────────────────────
  section("Conflict → both candidates passed to Writer, no winner");
  {
    const r = result({ state: "conflicting", candidates: [
      { claimType: "vendor-category", propositionValue: "Office", supportingRefs: [ref(1)] },
      { claimType: "vendor-category", propositionValue: "Inventory", supportingRefs: [ref(2)] }] });
    const m = makeDeps({ reads: [evSet([1, 2]), evSet([1, 2])], derived: r, writerOutcome: outcome("created", 2) });
    const out = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "Acme" }, m.deps);
    const cmd = m.getWriteCommand() as { result: DerivedClaimResult };
    check("Orchestrator forwards the derived result untouched (2 candidates)", cmd.result.candidates.length === 2);
    check("outcome materialized with candidateCount 2", out.kind === "materialized" && (out as { candidateCount: number }).candidateCount === 2);
  }

  // ── Silence → Writer deletes; Orchestrator adds no fallback ──────────────────────────────────────
  section("Silence (insufficient) → Writer delete, no VendorLearning fallback");
  {
    const r = result({ state: "insufficient", candidates: [] });
    const m = makeDeps({ reads: [evSet([]), evSet([])], derived: r, writerOutcome: outcome("deleted", 0) });
    const out = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "Acme" }, m.deps);
    check("Writer was invoked (delete-slot), not skipped", m.calls.write === 1);
    check("outcome kind = deleted", out.kind === "deleted");
  }

  // ── Stale → no write ─────────────────────────────────────────────────────────────────────────────
  section("Stale (A != B) → return stale, Writer 0 (S1, no retry)");
  {
    const m = makeDeps({ reads: [evSet([1, 2]), evSet([1, 2, 3])] });
    const out = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "Acme" }, m.deps);
    check("outcome kind = stale", out.kind === "stale");
    check("Writer NOT called; no re-derive; no retry", m.calls.write === 0 && m.calls.derive === 1 && m.calls.read === 2);
  }

  // ── Failure taxonomy — each fails closed, Writer 0 (except writer stage) ──────────────────────────
  section("Failure taxonomy — typed, fail-closed, surfaced");
  {
    let m = makeDeps({ resolveThrows: new Error("no policy") });
    let out = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "x" }, m.deps);
    check("policy resolution failure → failed/policy-resolution, write0", out.kind === "failed" && (out as { stage: string }).stage === "policy-resolution" && m.calls.write === 0);

    m = makeDeps({ readThrowsOn: 1 });
    out = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "x" }, m.deps);
    check("first read failure → failed/evidence-read-first, write0", out.kind === "failed" && (out as { stage: string }).stage === "evidence-read-first" && m.calls.write === 0);

    m = makeDeps({ readThrowsOn: 2 });
    out = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "x" }, m.deps);
    check("second read failure → failed/evidence-read-second, write0", out.kind === "failed" && (out as { stage: string }).stage === "evidence-read-second" && m.calls.write === 0);

    m = makeDeps({ deriveThrows: new Error("derive boom") });
    out = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "x" }, m.deps);
    check("derivation failure → failed/derivation, write0", out.kind === "failed" && (out as { stage: string }).stage === "derivation" && m.calls.write === 0);

    m = makeDeps({ reads: [evSet([1]), evSet([1])], writeThrows: new MaterializationRejected("bad") });
    out = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "x" }, m.deps);
    check("writer validation rejection → failed/writer-validation, write attempted once, NO retry", out.kind === "failed" && (out as { stage: string }).stage === "writer-validation" && m.calls.write === 1);

    m = makeDeps({ reads: [evSet([1]), evSet([1])], writeThrows: new Error("P2002") });
    out = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "x" }, m.deps);
    check("writer DB/concurrency error → failed/writer-error, NO retry", out.kind === "failed" && (out as { stage: string }).stage === "writer-error" && m.calls.write === 1);

    m = makeDeps();
    out = await runVendorCategoryOrchestration({ businessId: 0, vendorInput: "x" }, m.deps);
    check("invalid tenant → failed/tenant-subject, nothing called", out.kind === "failed" && (out as { stage: string }).stage === "tenant-subject" && m.calls.resolve === 0);
  }

  // ── Idempotency (logical) ────────────────────────────────────────────────────────────────────────
  section("Repeated identical invocation → same logical outcome");
  {
    const a = makeDeps({ reads: [evSet([1, 2]), evSet([1, 2])], writerOutcome: outcome("created") });
    const b = makeDeps({ reads: [evSet([1, 2]), evSet([1, 2])], writerOutcome: outcome("replaced") });
    const o1 = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "Acme" }, a.deps);
    const o2 = await runVendorCategoryOrchestration({ businessId: 1, vendorInput: "Acme" }, b.deps);
    check("both materialized (created then replaced = same logical state)", o1.kind === "materialized" && o2.kind === "materialized");
  }

  // ── F3 equality helper ───────────────────────────────────────────────────────────────────────────
  section("F3 — canonical refs+ordering equality (fingerprint is not the sole authority)");
  {
    check("same refs+ordering → equal", evidenceIdentityEquals(identity([1, 2, 3]), identity([1, 2, 3])));
    check("different ref set → not equal", !evidenceIdentityEquals(identity([1, 2]), identity([1, 2, 3])));
    check("different order → not equal", !evidenceIdentityEquals(identity([1, 2]), identity([2, 1])));
  }

  // ── Static — inert, no lock/retry/VendorLearning/confidence; TOCTOU not claimed closed ──────────
  section("Static — no lock/retry/VendorLearning/confidence; F3 compares refs; TOCTOU limitation documented");
  {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = __dirname;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const raw = files.map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n")).join("\n");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    check("no advisory lock / serializable / compare-and-write", !/advisory|pg_advisory|Serializable|isolationLevel|compareAndWrite|compare-and-write/i.test(code));
    check("no retry loop / sleep / backoff", !/\bretry\b|setTimeout|setInterval|backoff|while\s*\(/i.test(code));
    check("no timestamp/latest freshness heuristic", !/Date\.now|new Date|createdAt|latest/i.test(code));
    check("no VendorLearning", !/vendorLearning|VendorLearning/.test(code));
    check("no RIA / C1", !/referent-identity|\bRia[A-Z]|detection-grammar/.test(code));
    check("no confidence / recommendation / winner in orchestrator logic", !/\bconfidence\b|recommendation|pickWinner|majority|recency/i.test(code));
    check("uses the exact vendor-category resolver (not an arbitrary descriptor)", /resolveVendorCategoryPolicyVersion/.test(code) && !/resolveDerivationPolicyVersion\s*\(/.test(code));
    check("F3 equality compares refs (kind/businessId/recordId), not just fingerprint", /x\.recordId !== y\.recordId|refs\[i\]/.test(raw));
    check("TOCTOU limitation is documented (no linearizability claim)", /TOCTOU|lineariz/i.test(raw));
  }

  section("Business Memory IMPL-6A · Single-Pass Orchestrator invariants");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
  console.log("All IMPL-6A orchestrator invariants hold. Single-pass · best-effort G1 · S1 · inert. ✔");
}

main().catch((err) => { console.error(err); process.exit(1); });
