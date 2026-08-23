/**
 * Business Memory SHADOW-COMPARISON-2 · Dry-run comparison — fixture test. npx tsx. No DB.
 *
 * Drives the REAL comparison core (real reader-core + real vendor-category deriver) on synthetic
 * ReviewEvent rows to prove the adversarial matrix: single confirmed, single corrected (owner-final
 * wins), repeated agreement (refs accumulate), conflict, non-supporting, tenant isolation, deterministic
 * replay, and the control subject (shadow qa vendor -> general).
 */
import {
  compareSubject,
  compareTenant,
  type ResolvedPolicy,
} from "../../../scripts/business-memory/dry-run-comparison.core";
import type { ReviewEventRow } from "@/lib/business-memory/evidence";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const POLICY: ResolvedPolicy = { policyKey: "vendor-category", versionLabel: "v1", policyVersionId: 1 };

function ev(
  id: number,
  businessId: number,
  vendorFinal: string,
  categoryFinal: string | null,
  categoryVerdict: "confirmed" | "corrected" | "rejected" | "not-submitted",
  occurredAt: string,
): ReviewEventRow {
  return {
    id,
    businessId,
    occurredAt,
    vendorFinal,
    directionFinal: null,
    verdicts: {
      vendorName: { final: vendorFinal, verdict: "corrected" },
      category: { final: categoryFinal, verdict: categoryVerdict },
      direction: { final: null, verdict: "rejected" },
    },
  };
}

function subj(businessId: number, key: string) {
  return { domain: "vendor" as const, normalizedKey: key, businessId };
}

// ── 1. single confirmed ──────────────────────────────────────────────────────────────────────────
section("single confirmed → supported, candidate = category");
{
  const rows = [ev(1, 1, "Acme Fuel", "fuel", "confirmed", "2026-01-01T00:00:00Z")];
  const r = compareSubject(rows, subj(1, "acme fuel"), POLICY);
  check("normalized subject", r.normalizedSubject === "acme fuel");
  check("actual candidate = [fuel]", JSON.stringify(r.actualCandidates) === JSON.stringify(["fuel"]));
  check("actual state supported", r.actualState === "supported");
  check("expected matches actual → PASS", r.classification === "PASS");
  check("evidence count 1", r.evidenceCount === 1);
}

// ── 2. single corrected — owner-final NEW value wins (not belief) ───────────────────────────────────
section("single corrected → owner-final (corrected) value wins");
{
  // belief was 'services'; owner corrected the FINAL to 'rent'. Only the owner-final reaches evidence.
  const rows = [ev(2, 1, "Beta Rentals", "rent", "corrected", "2026-01-02T00:00:00Z")];
  const r = compareSubject(rows, subj(1, "beta rentals"), POLICY);
  check("candidate = [rent] (owner-final), not the belief", JSON.stringify(r.actualCandidates) === JSON.stringify(["rent"]));
  check("supported + PASS", r.actualState === "supported" && r.classification === "PASS");
  check("qualifying verdict recorded as corrected", r.qualifyingByCategory[0]?.verdicts.includes("corrected") === true);
}

// ── 3. repeated agreement — one candidate, refs accumulate ─────────────────────────────────────────
section("repeated agreement → one candidate, evidence accumulates");
{
  const rows = [
    ev(10, 1, "Gamma Supplies", "supplies", "confirmed", "2026-01-01T00:00:00Z"),
    ev(11, 1, "Gamma Supplies", "supplies", "confirmed", "2026-01-02T00:00:00Z"),
    ev(12, 1, "Gamma Supplies", "supplies", "corrected", "2026-01-03T00:00:00Z"),
  ];
  const r = compareSubject(rows, subj(1, "gamma supplies"), POLICY);
  check("single candidate [supplies]", JSON.stringify(r.actualCandidates) === JSON.stringify(["supplies"]));
  check("supported", r.actualState === "supported");
  check("all 3 refs accumulate under the candidate", r.actualCandidateRefCounts[0]?.refCount === 3);
  check("evidence count 3", r.evidenceCount === 3);
  check("classification PASS", r.classification === "PASS");
}

// ── 4. conflicting categories — candidate-set, conflicting ─────────────────────────────────────────
section("conflicting categories → multiple candidates + conflicting");
{
  const rows = [
    ev(20, 1, "Delta Co", "fuel", "confirmed", "2026-01-01T00:00:00Z"),
    ev(21, 1, "Delta Co", "rent", "confirmed", "2026-01-02T00:00:00Z"),
  ];
  const r = compareSubject(rows, subj(1, "delta co"), POLICY);
  check("two candidates ordered by value [fuel, rent]", JSON.stringify(r.actualCandidates) === JSON.stringify(["fuel", "rent"]));
  check("state conflicting", r.actualState === "conflicting");
  check("classification CONFLICT_EXPECTED", r.classification === "CONFLICT_EXPECTED");
}

// ── 5. non-supporting evidence → insufficient (does not teach) ─────────────────────────────────────
section("non-supporting evidence → insufficient, teaches nothing");
{
  const rows = [
    ev(30, 1, "Epsilon", null, "not-submitted", "2026-01-01T00:00:00Z"),
    ev(31, 1, "Epsilon", "", "confirmed", "2026-01-02T00:00:00Z"), // empty final → no support
    ev(32, 1, "Epsilon", "fuel", "rejected", "2026-01-03T00:00:00Z"), // rejected → owner did not act
  ];
  const r = compareSubject(rows, subj(1, "epsilon"), POLICY);
  check("no candidates", r.actualCandidates.length === 0);
  check("state insufficient", r.actualState === "insufficient");
  check("classification INSUFFICIENT_EXPECTED", r.classification === "INSUFFICIENT_EXPECTED");
  check("non-supporting count 3", r.nonSupportingCount === 3);
}

// ── 6. tenant isolation — same vendor name, different tenants, fully isolated ───────────────────────
section("same vendor name, different tenants → completely isolated");
{
  const rows = [
    ev(40, 1, "Shared Vendor", "fuel", "confirmed", "2026-01-01T00:00:00Z"),
    ev(41, 2, "Shared Vendor", "rent", "confirmed", "2026-01-02T00:00:00Z"),
  ];
  const t1 = compareSubject(rows, subj(1, "shared vendor"), POLICY);
  const t2 = compareSubject(rows, subj(2, "shared vendor"), POLICY);
  check("tenant 1 sees only its own event", t1.evidenceCount === 1 && JSON.stringify(t1.actualCandidates) === JSON.stringify(["fuel"]));
  check("tenant 2 sees only its own event", t2.evidenceCount === 1 && JSON.stringify(t2.actualCandidates) === JSON.stringify(["rent"]));
  check("tenant 1 refs contain no cross-tenant ref", t1.evidenceRefs.every((r) => r.startsWith("review-event:1:")));
  check("tenant 2 refs contain no cross-tenant ref", t2.evidenceRefs.every((r) => r.startsWith("review-event:2:")));
  // compareTenant on a tenant-filtered row set derives independently
  const only1 = compareTenant(rows.filter((r) => r.businessId === 1), 1, POLICY);
  check("compareTenant(businessId=1) yields exactly one subject, candidate [fuel]", only1.rows.length === 1 && JSON.stringify(only1.rows[0].actualCandidates) === JSON.stringify(["fuel"]));
}

// ── 7. deterministic replay — same evidence (any input order) → identical result + fingerprint ──────
section("deterministic replay → identical result + fingerprint");
{
  const base = [
    ev(50, 1, "Zeta Ltd", "marketing", "confirmed", "2026-01-01T00:00:00Z"),
    ev(51, 1, "Zeta Ltd", "marketing", "confirmed", "2026-01-02T00:00:00Z"),
  ];
  const reordered = [base[1], base[0]];
  const a = compareSubject(base, subj(1, "zeta ltd"), POLICY);
  const b = compareSubject(reordered, subj(1, "zeta ltd"), POLICY);
  check("identical candidates", JSON.stringify(a.actualCandidates) === JSON.stringify(b.actualCandidates));
  check("identical state", a.actualState === b.actualState);
  check("identical fingerprint (order-independent)", a.evidenceFingerprint === b.evidenceFingerprint);
  check("identical refs order", JSON.stringify(a.evidenceRefs) === JSON.stringify(b.evidenceRefs));
}

// ── 8. control — equivalent to the Production-proven event ──────────────────────────────────────────
section("control fixture → shadow qa vendor → general (matches Production proof)");
{
  const rows = [ev(70, 1, "SHADOW QA VENDOR", "general", "confirmed", "2026-08-23T00:00:00Z")];
  const r = compareSubject(rows, subj(1, "shadow qa vendor"), POLICY);
  check("normalized subject = shadow qa vendor", r.normalizedSubject === "shadow qa vendor");
  check("candidate = [general]", JSON.stringify(r.actualCandidates) === JSON.stringify(["general"]));
  check("supported + PASS", r.actualState === "supported" && r.classification === "PASS");
  check("evidence ref = review-event:1:70", JSON.stringify(r.evidenceRefs) === JSON.stringify(["review-event:1:70"]));
}

section("Business Memory SHADOW-COMPARISON-2 · dry-run fixtures");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("All dry-run fixtures hold. Real engine derives correctly across the adversarial matrix. ✔");
