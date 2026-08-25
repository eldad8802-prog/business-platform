/**
 * Business Memory READ-OBS · comparison-sink — unit test. npx tsx. No DB.
 * Proves the durable telemetry event carries ONLY privacy-safe fields (featureKey + action/outcome +
 * safe metadata) and NEVER any vendor / normalized subject / category value / evidence payload.
 */
import { buildComparisonUsageEvent, READ_COMPARISON_FEATURE_KEY } from "./comparison-sink";
import type { ComparisonLog } from "./comparison-read";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}

const supportedFresh: ComparisonLog = {
  event: "bm-read-comparison",
  businessId: 1,
  outcome: "memory-available",
  fallbackReason: null,
  policyKey: "vendor-category",
  versionLabel: "v1",
  fingerprintMatch: true,
  comparison: "agree",
};
const absent: ComparisonLog = {
  event: "bm-read-comparison",
  businessId: 3,
  outcome: "fallback",
  fallbackReason: "absent",
  policyKey: "vendor-category",
  versionLabel: "v1",
  comparison: "not-applicable",
};

const e1 = buildComparisonUsageEvent(supportedFresh);
const e2 = buildComparisonUsageEvent(absent);

check("featureKey is the fixed comparison key", e1.featureKey === READ_COMPARISON_FEATURE_KEY && e1.featureKey === "business-memory-read-comparison");
check("businessId propagated", e1.businessId === 1 && e2.businessId === 3);
check("action = comparison verdict", e1.action === "agree" && e2.action === "not-applicable");
check("outcome carried", e1.outcome === "memory-available" && e2.outcome === "fallback");
check("metadata has fallbackReason", e1.metadata.fallbackReason === null && e2.metadata.fallbackReason === "absent");
check("metadata has policy identity + fingerprintMatch when present", e1.metadata.policyKey === "vendor-category" && e1.metadata.versionLabel === "v1" && e1.metadata.fingerprintMatch === true);
check("fingerprintMatch omitted when absent (not-applicable)", !("fingerprintMatch" in e2.metadata));

// Privacy — key-level (top-level + metadata) carries NO sensitive business field. (Note: policyKey
// legitimately equals the identity string "vendor-category"; we check for sensitive KEY NAMES and
// category VALUES, not that literal, so it is not a false positive.)
const allKeys = [...Object.keys(e1), ...Object.keys(e1.metadata), ...Object.keys(e2), ...Object.keys(e2.metadata)];
for (const badKey of ["vendorName", "vendorFinal", "normalizedSubject", "subjectNormalizedKey", "evidenceRefs", "evidenceRecordId", "documentId", "ocrText", "rawFinal", "rawBelief", "amount", "category"]) {
  check(`no field named "${badKey}"`, !allKeys.some((k) => k.toLowerCase() === badKey.toLowerCase()));
}
const metaKeys = new Set([...Object.keys(e1.metadata), ...Object.keys(e2.metadata)]);
const allowedMeta = new Set(["fallbackReason", "policyKey", "versionLabel", "fingerprintMatch"]);
check("metadata keys ⊆ allowed privacy-safe set", [...metaKeys].every((k) => allowedMeta.has(k)));
// Values are only the safe enums + policy identity — no owner-final category value leaks through.
const stringVals = [e1.action, e1.outcome, String(e1.metadata.fallbackReason), e1.metadata.policyKey, e1.metadata.versionLabel, e2.action, e2.outcome, String(e2.metadata.fallbackReason)];
const allowedVals = new Set(["agree", "disagree", "not-applicable", "memory-available", "fallback", "null", "absent", "vendor-category", "v1", "stale", "conflicting", "invalid", "unavailable", "resolver-failure", "evidence-failure", "unexpected", undefined as unknown as string]);
check("all string values are safe enums/identity (no category value)", stringVals.every((v) => v === undefined || allowedVals.has(v)));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("comparison-sink: featureKey fixed · privacy-safe fields only · no business payload. ✔");
