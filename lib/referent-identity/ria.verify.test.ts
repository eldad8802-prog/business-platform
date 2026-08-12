/**
 * RIA — Minimum Cross-Feature Executable Proof (fixtures-only). Run: npx tsx.
 *
 * Proves, end-to-end and with deterministic replay:
 *   Feature A RawInput + Feature B RawInput
 *     → genuine C0 normalize() (two feature domains, real registry snapshot)
 *     → fixture-authorized RIA identity resolution (Policy → Basis → Assertion)
 *     → derived shared Current Identity Interpretation (equivalence-class)
 *     → existing Equality / Detection-Grammar runtime under that shared identity
 *     → deterministic replay / golden.
 *
 * Two layers stay distinct: RIA decides IDENTITY alignment (SAME/DISTINCT/UNRESOLVED/
 * CONFLICT); Equality decides the VALUE relation (EQUAL/NOT_EQUAL). RIA never returns
 * EQUAL; Equality never returns SAME-referent. NO C0 edit, NO Equality edit, fixtures-only.
 */
import {
  normalizeResourceObservation,
  normalizePartyObservation,
  CROSS_FEATURE_CONCEPT_SNAPSHOT,
} from "./fixtures/fixture-cross-feature-observations";
import { makeFixtureIdentityPolicy } from "./fixtures/fixture-identity-policy";
import { bindingFromCot } from "./cot-to-binding";
import { authorizeAndRecord } from "./identity-resolver";
import { deriveCii, anchorsAligned } from "./cii-derivation";
import { ciiDigest, crossFeatureGolden } from "./ria-replay";
import {
  canonicalReferentId,
  fixtureAuthoritativeRef,
  type IdentityHistory,
  type TemporalReconstructionContext,
} from "./ria.types";
import { runEqualityFromCots } from "../detection-grammar/equality/equality-operator";
import { makeIntegerDomain } from "../detection-grammar/equality/fixtures/fixture-equality-domain";
import type { EqualityProjection } from "../detection-grammar/equality/equality.types";
import type { Tenant } from "../business-brain/observation.types";

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

// ── shared constants ────────────────────────────────────────────────────────
const T1: Tenant = { businessId: 1 };
const TOKEN_42 = fixtureAuthoritativeRef("AUTH:resource:42");
const TOKEN_99 = fixtureAuthoritativeRef("AUTH:resource:99");
const TIMES = { recordedAt: "2026-07-02T00:00:00.000Z", effectiveAt: "2026-07-02T00:00:00.000Z" };
const CTX: TemporalReconstructionContext = {
  evaluationTime: "2026-07-03T00:00:00.000Z",
  historyBoundary: "2026-07-03T00:00:00.000Z",
};
const DOMAIN = makeIntegerDomain();
const policy = makeFixtureIdentityPolicy();

function outcomeOf(p: EqualityProjection): string {
  return p.disposition.kind === "OUTCOME" ? p.disposition.outcome : `FAILURE:${p.disposition.family}`;
}

// Sanity: the C0 accounts are pinned to a REAL registry snapshot (not a placeholder).
section("Precondition — genuine C0 snapshot");
check(
  "concept snapshot is a real minted digest",
  typeof CROSS_FEATURE_CONCEPT_SNAPSHOT === "string" &&
    CROSS_FEATURE_CONCEPT_SNAPSHOT.includes("sha256")
);

// ── X1 — cross-feature SAME + equal values → shared CII → Equality EQUAL ──────
section("X1 — cross-feature SAME + equal values");
{
  const R_DOCS = canonicalReferentId("R:docs:resource-42");
  const R_INV = canonicalReferentId("R:inv:resource-42");
  const cotDocs = normalizeResourceObservation({
    featureDomain: "documents", datum: 5, sourceRecordId: "doc-1", runId: "run-doc-1",
  });
  const cotInv = normalizeResourceObservation({
    featureDomain: "inventory", datum: 5, sourceRecordId: "inv-1", runId: "run-inv-1",
  });
  check("two distinct C0 accounts (different feature domains)",
    cotDocs.observationAccountId !== cotInv.observationAccountId);
  check("documents account is feature-tagged", cotDocs.source.featureDomain === "documents");
  check("inventory account is feature-tagged", cotInv.source.featureDomain === "inventory");

  const bDocs = bindingFromCot(cotDocs, { canonicalReferentId: R_DOCS, authorityRef: TOKEN_42 });
  const bInv = bindingFromCot(cotInv, { canonicalReferentId: R_INV, authorityRef: TOKEN_42 });

  const rec = authorizeAndRecord(policy, bDocs, bInv, TIMES);
  check("policy authorized SAME", rec.decision.kind === "AUTHORIZED" &&
    rec.decision.basis.relation === "SAME");
  check("assertion recorded", rec.assertion !== null);

  const history: IdentityHistory = rec.assertion ? [rec.assertion] : [];
  const cii = deriveCii(R_DOCS, T1, "RESOURCE", history, CTX);
  check("CII is RESOLVED", cii.disposition === "RESOLVED");
  check("CII members = both anchors (shared)", cii.members.length === 2 &&
    cii.members.includes(R_DOCS) && cii.members.includes(R_INV));
  check("anchors are aligned (license granted)", anchorsAligned(cii, R_DOCS, R_INV));

  // Only under alignment do we run the existing Equality over the two values.
  const proj = runEqualityFromCots(DOMAIN, cotDocs, cotInv);
  check("Equality EQUAL under shared identity", outcomeOf(proj) === "EQUAL");
}

// ── X2 — cross-feature SAME but different values → NOT_EQUAL (identity≠value) ──
section("X2 — SAME identity, different values");
{
  const R_DOCS = canonicalReferentId("R:docs:resource-77");
  const R_INV = canonicalReferentId("R:inv:resource-77");
  const cotDocs = normalizeResourceObservation({
    featureDomain: "documents", datum: 5, sourceRecordId: "doc-2", runId: "run-doc-2",
  });
  const cotInv = normalizeResourceObservation({
    featureDomain: "inventory", datum: 6, sourceRecordId: "inv-2", runId: "run-inv-2",
  });
  const bDocs = bindingFromCot(cotDocs, { canonicalReferentId: R_DOCS, authorityRef: TOKEN_42 });
  const bInv = bindingFromCot(cotInv, { canonicalReferentId: R_INV, authorityRef: TOKEN_42 });
  const rec = authorizeAndRecord(policy, bDocs, bInv, TIMES);
  const history: IdentityHistory = rec.assertion ? [rec.assertion] : [];
  const cii = deriveCii(R_DOCS, T1, "RESOURCE", history, CTX);

  check("shared RESOLVED CII", cii.disposition === "RESOLVED" &&
    cii.members.includes(R_DOCS) && cii.members.includes(R_INV));
  check("anchors aligned", anchorsAligned(cii, R_DOCS, R_INV));
  const proj = runEqualityFromCots(DOMAIN, cotDocs, cotInv);
  check("Equality NOT_EQUAL under SAME identity (identity SAME ≠ value EQUAL)",
    outcomeOf(proj) === "NOT_EQUAL");
}

// ── X3 — affirmative DISTINCT → separate interpretations, not aligned ─────────
section("X3 — DISTINCT constraining");
{
  const R_A = canonicalReferentId("R:docs:distinct-A");
  const R_B = canonicalReferentId("R:inv:distinct-B");
  const cotA = normalizeResourceObservation({
    featureDomain: "documents", datum: 5, sourceRecordId: "doc-3", runId: "run-doc-3",
  });
  const cotB = normalizeResourceObservation({
    featureDomain: "inventory", datum: 5, sourceRecordId: "inv-3", runId: "run-inv-3",
  });
  const bA = bindingFromCot(cotA, {
    canonicalReferentId: R_A, authorityRef: TOKEN_42, affirmativeDistinctFrom: [R_B],
  });
  const bB = bindingFromCot(cotB, { canonicalReferentId: R_B, authorityRef: TOKEN_99 });
  const rec = authorizeAndRecord(policy, bA, bB, TIMES);
  check("policy authorized DISTINCT (affirmative, not token-mismatch)",
    rec.decision.kind === "AUTHORIZED" && rec.decision.basis.relation === "DISTINCT");
  const history: IdentityHistory = rec.assertion ? [rec.assertion] : [];
  const cii = deriveCii(R_A, T1, "RESOURCE", history, CTX);
  check("R_A stays a singleton (no collapse to R_B)",
    cii.members.length === 1 && cii.members.includes(R_A) && !cii.members.includes(R_B));
  check("anchors NOT aligned (no same-referent joint reasoning)",
    !anchorsAligned(cii, R_A, R_B));
}

// ── X4 — No-Authorization → UNRESOLVED, no collapse ──────────────────────────
section("X4 — UNRESOLVED (No-Authorization)");
{
  const R_A = canonicalReferentId("R:docs:unresolved-A");
  const R_B = canonicalReferentId("R:inv:unresolved-B");
  const cotA = normalizeResourceObservation({
    featureDomain: "documents", datum: 5, sourceRecordId: "doc-4", runId: "run-doc-4",
  });
  const cotB = normalizeResourceObservation({
    featureDomain: "inventory", datum: 5, sourceRecordId: "inv-4", runId: "run-inv-4",
  });
  const bA = bindingFromCot(cotA, { canonicalReferentId: R_A, authorityRef: TOKEN_42 });
  const bB = bindingFromCot(cotB, { canonicalReferentId: R_B, authorityRef: TOKEN_99 });
  const rec = authorizeAndRecord(policy, bA, bB, TIMES);
  check("policy NO_AUTHORIZATION (mismatch is NOT distinct)",
    rec.decision.kind === "NO_AUTHORIZATION");
  check("no assertion recorded", rec.assertion === null);
  const cii = deriveCii(R_A, T1, "RESOURCE", [], CTX);
  check("R_A stays a singleton (identity question uncollapsed)",
    cii.members.length === 1 && cii.members.includes(R_A));
  check("anchors NOT aligned", !anchorsAligned(cii, R_A, R_B));
}

// ── X5 — contradictory SAME-closure + DISTINCT → CONFLICT, abstain, no cut ────
section("X5 — CONFLICT (RC6: abstain, no graph-cut)");
{
  const R1 = canonicalReferentId("R:x:conflict-1");
  const R2 = canonicalReferentId("R:x:conflict-2");
  const R3 = canonicalReferentId("R:x:conflict-3");
  const cot1 = normalizeResourceObservation({
    featureDomain: "documents", datum: 5, sourceRecordId: "doc-5a", runId: "run-5a",
  });
  const cot2 = normalizeResourceObservation({
    featureDomain: "inventory", datum: 5, sourceRecordId: "inv-5b", runId: "run-5b",
  });
  const cot3 = normalizeResourceObservation({
    featureDomain: "documents", datum: 5, sourceRecordId: "doc-5c", runId: "run-5c",
  });
  // R1,R2,R3 share a token (transitive SAME); R1 is affirmatively DISTINCT from R3.
  const b1 = bindingFromCot(cot1, {
    canonicalReferentId: R1, authorityRef: TOKEN_42, affirmativeDistinctFrom: [R3],
  });
  const b2 = bindingFromCot(cot2, { canonicalReferentId: R2, authorityRef: TOKEN_42 });
  const b3 = bindingFromCot(cot3, { canonicalReferentId: R3, authorityRef: TOKEN_42 });

  const rec12 = authorizeAndRecord(policy, b1, b2, TIMES);
  const rec23 = authorizeAndRecord(policy, b2, b3, TIMES);
  const rec13 = authorizeAndRecord(policy, b1, b3, TIMES);
  check("R1~R2 authorized SAME", rec12.decision.kind === "AUTHORIZED" &&
    rec12.decision.basis.relation === "SAME");
  check("R2~R3 authorized SAME", rec23.decision.kind === "AUTHORIZED" &&
    rec23.decision.basis.relation === "SAME");
  check("R1~R3 authorized DISTINCT (targeted affirmative)", rec13.decision.kind === "AUTHORIZED" &&
    rec13.decision.basis.relation === "DISTINCT");

  const history: IdentityHistory = [rec12.assertion!, rec23.assertion!, rec13.assertion!];
  const cii = deriveCii(R1, T1, "RESOURCE", history, CTX);
  check("disposition is CONFLICT", cii.disposition === "CONFLICT");
  check("members are NOT cut/partitioned (all 3 present)",
    cii.members.length === 3 && cii.members.includes(R1) &&
    cii.members.includes(R2) && cii.members.includes(R3));
  check("CONFLICT is not aligned (abstain — no joint reasoning)",
    !anchorsAligned(cii, R1, R3));
}

// ── X6 — cross-tenant → invalid, no CII ──────────────────────────────────────
section("X6 — tenant isolation");
{
  const R_A = canonicalReferentId("R:docs:tenant-A");
  const R_B = canonicalReferentId("R:inv:tenant-B");
  const cotA = normalizeResourceObservation({
    featureDomain: "documents", datum: 5, sourceRecordId: "doc-6", runId: "run-6a", businessId: 1,
  });
  const cotB = normalizeResourceObservation({
    featureDomain: "inventory", datum: 5, sourceRecordId: "inv-6", runId: "run-6b", businessId: 2,
  });
  const bA = bindingFromCot(cotA, { canonicalReferentId: R_A, authorityRef: TOKEN_42 });
  const bB = bindingFromCot(cotB, { canonicalReferentId: R_B, authorityRef: TOKEN_42 });
  const rec = authorizeAndRecord(policy, bA, bB, TIMES);
  check("policy NO_AUTHORIZATION (cross-tenant)",
    rec.decision.kind === "NO_AUTHORIZATION" &&
    rec.decision.reason.includes("cross-tenant"));
  check("no assertion → no shared CII", rec.assertion === null);
}

// ── X7 — cross-type (PARTY vs RESOURCE) → invalid, no reconciliation ──────────
section("X7 — type isolation");
{
  const R_A = canonicalReferentId("R:docs:type-resource");
  const R_B = canonicalReferentId("R:docs:type-party");
  const cotRes = normalizeResourceObservation({
    featureDomain: "documents", datum: 5, sourceRecordId: "doc-7a", runId: "run-7a",
  });
  const cotParty = normalizePartyObservation({
    featureDomain: "documents", sourceRecordId: "doc-7b", label: "Acme Ltd",
  });
  check("RESOURCE vs PARTY C0 referent types differ",
    cotRes.referent.referentType === "RESOURCE" &&
    cotParty.referent.referentType === "PARTY");
  const bRes = bindingFromCot(cotRes, { canonicalReferentId: R_A, authorityRef: TOKEN_42 });
  const bParty = bindingFromCot(cotParty, { canonicalReferentId: R_B, authorityRef: TOKEN_42 });
  const rec = authorizeAndRecord(policy, bRes, bParty, TIMES);
  check("policy NO_AUTHORIZATION (cross-type)",
    rec.decision.kind === "NO_AUTHORIZATION" &&
    rec.decision.reason.includes("cross-type"));
  check("no assertion → no reconciliation across types", rec.assertion === null);
}

// ── X8 — replay: identical inputs/context → identical accounts, CII, projection ─
section("X8 — deterministic replay / golden");
{
  const R_DOCS = canonicalReferentId("R:docs:replay-42");
  const R_INV = canonicalReferentId("R:inv:replay-42");
  function runPipeline() {
    const cotDocs = normalizeResourceObservation({
      featureDomain: "documents", datum: 5, sourceRecordId: "doc-8", runId: "run-8-docs",
    });
    const cotInv = normalizeResourceObservation({
      featureDomain: "inventory", datum: 5, sourceRecordId: "inv-8", runId: "run-8-inv",
    });
    const bDocs = bindingFromCot(cotDocs, { canonicalReferentId: R_DOCS, authorityRef: TOKEN_42 });
    const bInv = bindingFromCot(cotInv, { canonicalReferentId: R_INV, authorityRef: TOKEN_42 });
    const rec = authorizeAndRecord(policy, bDocs, bInv, TIMES);
    const history: IdentityHistory = rec.assertion ? [rec.assertion] : [];
    const cii = deriveCii(R_DOCS, T1, "RESOURCE", history, CTX);
    const proj = runEqualityFromCots(DOMAIN, cotDocs, cotInv);
    return { cotDocs, cotInv, assertionId: rec.assertion?.assertionId, cii, proj };
  }
  const a = runPipeline();
  const b = runPipeline();
  check("C0 account identity is reproducible (documents)",
    a.cotDocs.observationAccountId === b.cotDocs.observationAccountId);
  check("C0 account identity is reproducible (inventory)",
    a.cotInv.observationAccountId === b.cotInv.observationAccountId);
  check("assertion identity is reproducible", a.assertionId === b.assertionId &&
    a.assertionId !== undefined);
  check("CII digest is reproducible", ciiDigest(a.cii) === ciiDigest(b.cii));
  check("cross-feature golden is identical",
    crossFeatureGolden(a.cii, a.proj) === crossFeatureGolden(b.cii, b.proj));
}

// ── X9 — CII consumption does not mutate C0 / source provenance ──────────────
section("X9 — provenance immutability");
{
  const R_DOCS = canonicalReferentId("R:docs:prov-42");
  const R_INV = canonicalReferentId("R:inv:prov-42");
  const cotDocs = normalizeResourceObservation({
    featureDomain: "documents", datum: 5, sourceRecordId: "doc-9", runId: "run-9-docs",
  });
  const cotInv = normalizeResourceObservation({
    featureDomain: "inventory", datum: 5, sourceRecordId: "inv-9", runId: "run-9-inv",
  });
  const accountBefore = cotDocs.observationAccountId;
  const datumBefore = cotDocs.value.datum;
  const featureBefore = cotDocs.source.featureDomain;
  const bDocs = bindingFromCot(cotDocs, { canonicalReferentId: R_DOCS, authorityRef: TOKEN_42 });
  const bInv = bindingFromCot(cotInv, { canonicalReferentId: R_INV, authorityRef: TOKEN_42 });
  const rec = authorizeAndRecord(policy, bDocs, bInv, TIMES);
  const cii = deriveCii(R_DOCS, T1, "RESOURCE", rec.assertion ? [rec.assertion] : [], CTX);
  runEqualityFromCots(DOMAIN, cotDocs, cotInv);
  check("C0 account is frozen (immutable Evidence)", Object.isFrozen(cotDocs));
  check("C0 account identity unchanged", cotDocs.observationAccountId === accountBefore);
  check("C0 value/provenance unchanged after RIA + Equality",
    cotDocs.value.datum === datumBefore && cotDocs.source.featureDomain === featureBefore);
  check("CII is a separate object (identity interpretation stored apart from C0)",
    (cii as unknown) !== (cotDocs as unknown));
}

// ── X10 — original bindings separately attributable while CII is shared ──────
section("X10 — original vs current attribution");
{
  const R_DOCS = canonicalReferentId("R:docs:attr-42");
  const R_INV = canonicalReferentId("R:inv:attr-42");
  const cotDocs = normalizeResourceObservation({
    featureDomain: "documents", datum: 5, sourceRecordId: "doc-10", runId: "run-10-docs",
  });
  const cotInv = normalizeResourceObservation({
    featureDomain: "inventory", datum: 5, sourceRecordId: "inv-10", runId: "run-10-inv",
  });
  const bDocs = bindingFromCot(cotDocs, { canonicalReferentId: R_DOCS, authorityRef: TOKEN_42 });
  const bInv = bindingFromCot(cotInv, { canonicalReferentId: R_INV, authorityRef: TOKEN_42 });
  const rec = authorizeAndRecord(policy, bDocs, bInv, TIMES);
  const cii = deriveCii(R_DOCS, T1, "RESOURCE", rec.assertion ? [rec.assertion] : [], CTX);
  check("bindings remain separately attributable to their own accounts",
    bDocs.accountRef !== bInv.accountRef &&
    bDocs.accountRef === cotDocs.observationAccountId &&
    bInv.accountRef === cotInv.observationAccountId);
  check("both anchors preserved (no destructive merge)",
    bDocs.canonicalReferentId === R_DOCS && bInv.canonicalReferentId === R_INV);
  check("current CII is shared over the two preserved anchors",
    cii.members.includes(R_DOCS) && cii.members.includes(R_INV));
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n──────────────────────────────────────────`);
console.log(`RIA cross-feature proof: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`FAILURES:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`CROSS-FEATURE PROOF PASSES`);
