/**
 * Business Memory IMPL-3 · Memory Deriver — invariant test. Run: npx tsx. DB-free, pure.
 *
 * Fixtures are built through the REAL Evidence Adapter (projectOwnerDecisionEvidence) from ReviewEvent
 * row shapes, then fed to the deriver — proving the adapter→deriver pipeline. Static scans assert
 * purity + no forbidden coupling.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { projectOwnerDecisionEvidence, vendorSubject, type ReviewEventRow } from "@/lib/business-memory/evidence";
import { deriveVendorCategory } from "./memory-deriver";
import { deriveVendorCategoryCandidates } from "./vendor-category.policy";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const PV = 1; // an explicit pinned DerivationPolicyVersion.id

// Build a ReviewEvent row with an owner category verdict.
function row(
  id: number,
  category: string | null,
  verdict: "confirmed" | "corrected" | "rejected" | "not-submitted",
  occurredAt = `2026-01-${String(id).padStart(2, "0")}T00:00:00.000Z`,
  vendorFinal = "Acme Ltd",
): ReviewEventRow {
  return {
    id,
    businessId: 1,
    occurredAt,
    vendorFinal,
    directionFinal: "outgoing",
    verdicts: {
      category: { belief: "general", final: category, verdict },
      vendorName: { belief: "Acme", final: vendorFinal, verdict: "confirmed" },
      direction: { belief: "outgoing", final: "outgoing", verdict: "confirmed" },
    },
  };
}
function setOf(rows: ReviewEventRow[]) {
  return projectOwnerDecisionEvidence(rows, vendorSubject(1, "Acme Ltd"));
}

// ── VendorLearning-comparison cases ──────────────────────────────────────────────────────────────
section("VendorLearning-comparison cases (conceptual)");
{
  // Case 1 — X→Office once → supported (VL: category=Office, usageCount=1)
  const c1 = deriveVendorCategory(setOf([row(1, "Office", "corrected")]), PV);
  check("Case1 single Office → supported", c1.state === "supported" && c1.candidates.length === 1 && c1.candidates[0].propositionValue === "Office");
  check("Case1 candidate carries 1 supporting ref (VL usageCount analogue = 1)", c1.candidates[0].supportingRefs.length === 1);

  // Case 2 — X→Office ×3 → supported, 3 supporting refs (VL: usageCount=3)
  const c2 = deriveVendorCategory(setOf([row(1, "Office", "confirmed"), row(2, "Office", "confirmed"), row(3, "Office", "corrected")]), PV);
  check("Case2 repeated Office → supported (still one candidate)", c2.state === "supported" && c2.candidates.length === 1);
  check("Case2 support count = 3 (duplicates add support, not deduped)", c2.candidates[0].supportingRefs.length === 3);

  // Case 3 — X→Office + X→Inventory → conflicting candidate-set (VL would silently overwrite → this DIFFERS, by design)
  const c3 = deriveVendorCategory(setOf([row(1, "Office", "corrected"), row(2, "Inventory", "corrected")]), PV);
  check("Case3 competing values → conflicting", c3.state === "conflicting");
  check("Case3 keeps BOTH candidates (no winner)", c3.candidates.map((c) => c.propositionValue).join(",") === "Inventory,Office");

  // Case 4 — corrections over time (Office,Office,Inventory,Office) → conflicting candidate-set (NOT recency/majority)
  const c4 = deriveVendorCategory(setOf([row(1, "Office", "corrected"), row(2, "Office", "confirmed"), row(3, "Inventory", "corrected"), row(4, "Office", "confirmed")]), PV);
  check("Case4 mixed corrections → conflicting (no recency/majority winner)", c4.state === "conflicting");
  check("Case4 Office candidate has 3 supporting refs, Inventory 1 (support preserved, not resolved)",
    c4.candidates.find((c) => c.propositionValue === "Office")!.supportingRefs.length === 3 &&
    c4.candidates.find((c) => c.propositionValue === "Inventory")!.supportingRefs.length === 1);

  // Case 5 — no evidence → insufficient (VL: no row)
  const c5 = deriveVendorCategory(setOf([]), PV);
  check("Case5 no evidence → insufficient, no candidates", c5.state === "insufficient" && c5.candidates.length === 0);
}

// ── Qualifying support / silence ≠ approval (INV-4) ──────────────────────────────────────────────
section("Qualifying support — silence/no-action is not support (INV-4)");
{
  const notSubmitted = deriveVendorCategory(setOf([row(1, "Office", "not-submitted")]), PV);
  check("not-submitted category → no support → insufficient", notSubmitted.state === "insufficient");
  const rejected = deriveVendorCategory(setOf([row(1, "Office", "rejected")]), PV);
  check("rejected category → no support → insufficient", rejected.state === "insufficient");
  const nullVal = deriveVendorCategory(setOf([row(1, null, "confirmed")]), PV);
  check("null category value → no support → insufficient", nullVal.state === "insufficient");
  const mixed = deriveVendorCategory(setOf([row(1, "Office", "confirmed"), row(2, "Inventory", "not-submitted")]), PV);
  check("only the acted-upon category counts → supported (Office)", mixed.state === "supported" && mixed.candidates[0].propositionValue === "Office");
}

// ── Determinism / ordering independence ──────────────────────────────────────────────────────────
section("Determinism — order-independent, value-ordered candidates");
{
  const rowsA = [row(1, "Office", "corrected"), row(2, "Inventory", "corrected"), row(3, "Travel", "corrected")];
  const rowsB = [rowsA[2], rowsA[0], rowsA[1]];
  const a = deriveVendorCategory(setOf(rowsA), PV);
  const b = deriveVendorCategory(setOf(rowsB), PV);
  check("candidate values ordered by proposition value (not support/precedence)", a.candidates.map((c) => c.propositionValue).join(",") === "Inventory,Office,Travel");
  check("input order does not change result", JSON.stringify(a) === JSON.stringify(b));
  check("evidenceSetIdentity echoed from the adapter set", a.evidenceSetIdentity.ordering === "occurredAt-asc,ordinal-asc");
}

// ── Withdrawn via erasure (contract/test-level, no runtime erasure) ──────────────────────────────
section("Withdrawn — erased support collapses candidates (Claim pre-impl §8)");
{
  const set = setOf([row(1, "Office", "corrected"), row(2, "Office", "confirmed")]);
  const allRefs = set.items.map((i) => i.ref);
  const withdrawn = deriveVendorCategory(set, PV, { erasedRefs: allRefs });
  check("all supporting evidence erased → withdrawn (not insufficient)", withdrawn.state === "withdrawn" && withdrawn.candidates.length === 0);
  const partial = deriveVendorCategory(set, PV, { erasedRefs: [allRefs[0]] });
  check("partial erasure keeps remaining support → supported", partial.state === "supported" && partial.candidates[0].supportingRefs.length === 1);
  const neverHad = deriveVendorCategory(setOf([row(1, "Office", "not-submitted")]), PV, { erasedRefs: [] });
  check("no qualifying evidence at all → insufficient (not withdrawn)", neverHad.state === "insufficient");
}

// ── Policy-version pinning required (INV-2) ──────────────────────────────────────────────────────
section("Policy-version pinning — explicit, required (INV-2)");
{
  const set = setOf([row(1, "Office", "corrected")]);
  check("result echoes the pinned policyVersionId", deriveVendorCategory(set, 7).policyVersionId === 7);
  let threw = 0;
  for (const bad of [0, -1, 1.5, NaN]) { try { deriveVendorCategory(set, bad as number); } catch { threw++; } }
  check("missing/invalid policyVersionId is rejected (no implicit/default version)", threw === 4);
}

// ── Explanation linkage / no winner / no confidence ──────────────────────────────────────────────
section("Explainability, no winner, no confidence");
{
  const res = deriveVendorCategory(setOf([row(1, "Office", "corrected"), row(2, "Inventory", "corrected")]), PV);
  check("every candidate links to supporting evidence refs (explainable)", res.candidates.every((c) => c.supportingRefs.length >= 1));
  check("supporting refs are references (kind+ids), not copied payload", res.candidates[0].supportingRefs.every((r) => r.kind === "review-event" && typeof r.recordId === "number"));
  check("conflicting result exposes NO winner/current/selected field", !("winner" in res) && !("current" in res) && !("selected" in res));
  check("no confidence anywhere on the result", !JSON.stringify(res).match(/confidence/i));
  // pure-rule direct call also yields the same candidates
  const direct = deriveVendorCategoryCandidates(setOf([row(1, "Office", "corrected")]).items);
  check("pure policy fn returns candidates + state", direct.state === "supported" && direct.candidates.length === 1);
}

// ── Static source scan — purity + no forbidden coupling ──────────────────────────────────────────
section("Static — purity, no Prisma/VendorLearning/RIA/C1, no confidence/precedence");
{
  const dir = __dirname;
  const src = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n"))
    .join("\n");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

  check("no Prisma import / client", !/@prisma\/client|@\/lib\/prisma|@\/lib\/generated|prisma\./.test(code));
  check("no DB access", !/\.(findMany|findUnique|create|update|upsert|delete)\s*\(/.test(code));
  check("no clock (Date.now / new Date)", !/Date\.now|new Date/.test(code));
  check("no randomness", !/Math\.random|randomUUID|crypto\./.test(code));
  check("no env / network", !/process\.env|fetch\s*\(|require\(/.test(code));
  check("no VendorLearning coupling", !/vendorLearning|VendorLearning/.test(code));
  check("no RIA coupling", !/referent-identity|\bRia[A-Z]/.test(code));
  check("no C1/detection-grammar coupling", !/detection-grammar|\bEquality\b/.test(code));
  check("no confidence field", !/\bconfidence\b/i.test(code));
  check("no precedence/winner/currentness verbs", !/\b(latestWins|pickWinner|getCurrent|selectPreferred|majority|recencyWins)\b/i.test(code));
  check("consumes ONLY the evidence public barrel (no deep evidence import)", !/business-memory\/evidence\/(review-event|extraction-snapshot|evidence-contract)/.test(code));
}

section("Business Memory IMPL-3 · Memory Deriver invariants");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("All IMPL-3 memory-deriver invariants hold. Pure · deterministic · candidate-set · inert. ✔");
