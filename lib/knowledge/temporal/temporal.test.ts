/**
 * M6 · The temporal engine and catalogue, without a database. Run:
 *   npx tsx lib/knowledge/temporal/temporal.test.ts
 *
 * Each block is one of the properties M6 exists to guarantee: that "not enough history" is said
 * rather than guessed, that a spike is not a trend, that a new level is a change and not an endless
 * stream of anomalies, that one extreme value does not redefine normal, that the same evidence at the
 * same instant always yields the same answer — and that no rule can quietly consume evidence the
 * sensor manifest does not vouch for.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assessNumeric, assessRate } from "./engine";
import { robustSummary, kendallTau } from "./robust";
import { temporalCatalogue } from "./rules";
import { evidenceFingerprint, semanticHash } from "./temporal-writer";
import type { NumericPoint, RatePoint, TemporalArtifact, TemporalSpec } from "./temporal.contract";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const DAY = 86_400_000;
const AS_OF = new Date("2026-09-01T12:00:00.000Z");
const ago = (d: number) => new Date(AS_OF.getTime() - d * DAY);
let rid = 0;
const pt = (daysAgo: number, value: number): NumericPoint => ({ at: ago(daysAgo), value, recordId: ++rid, evidenceKind: "lab" });
const find = (xs: TemporalArtifact[], t: string) => xs.find((a) => a.knowledgeType === t);

const SPEC: TemporalSpec = {
  valueKind: "duration", unit: "days", historyDays: 365, recentDays: 90,
  minHistory: 12, minSpanDays: 90, minRecent: 4, materialFloor: 1.5, stableRelativeSpread: 0.5,
  trendPeriods: 4, minPerPeriod: 3, staleAfterDays: 120,
};
/** `n` history points spread evenly over the history window, value from `f(i)`. */
const history = (n: number, f: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => pt(95 + Math.floor((i * 355) / n), f(i)));

/* ── INSUFFICIENT HISTORY is a result with its reason ─────────────────────────────── */
{
  const r = assessNumeric([], SPEC, AS_OF);
  ok("a brand-new business: exactly one artifact, BASELINE / INSUFFICIENT_HISTORY", r.length === 1 &&
    r[0].knowledgeType === "BASELINE" && r[0].status === "INSUFFICIENT_HISTORY" && r[0].reason?.code === "NO_OBSERVATIONS");
  const few = assessNumeric(history(5, () => 3), SPEC, AS_OF);
  ok("five of twelve: TOO_FEW_OBSERVATIONS with have/need", few[0].reason?.code === "TOO_FEW_OBSERVATIONS" &&
    few[0].reason?.have === 5 && few[0].reason?.need === 12 && few[0].baseline === null);
  const burst = assessNumeric(Array.from({ length: 20 }, (_, i) => pt(100 + (i % 10), 3)), SPEC, AS_OF);
  ok("twenty observations inside ten days is not a history: TOO_SHORT_HISTORY with span/needSpan",
    burst[0].reason?.code === "TOO_SHORT_HISTORY" && burst[0].reason?.needSpanDays === 90);
  ok("…and nothing else is inferred without a baseline (no trend, no anomaly)", few.length === 1 && burst.length === 1);
}

/* ── BASELINE is robust ─────────────────────────────────────────────────────────── */
{
  const r = assessNumeric(history(20, (i) => 3 + (i % 3)), SPEC, AS_OF);
  const b = find(r, "BASELINE");
  ok("a baseline is ACTIVE with a robust summary", b?.status === "ACTIVE" && (b.baseline as { median: number }).median === 4);
  const s = robustSummary([1, 2, 3, 4, 1000]);
  ok("median and MAD ignore a single extreme value (mean would be 202)", s.median === 3 && s.mad === 1);
}

/* ── STABLE_PATTERN only for consistent history ────────────────────────────────── */
{
  const tight = assessNumeric(history(20, (i) => 5 + (i % 2)), SPEC, AS_OF);
  ok("tight history → STABLE_PATTERN", find(tight, "STABLE_PATTERN")?.status === "ACTIVE");
  const noisy = assessNumeric(history(20, (i) => [1, 15, 3, 22, 8, 30, 2, 12][i % 8]), SPEC, AS_OF);
  ok("noisy history → a baseline, but NO stable pattern", find(noisy, "BASELINE")?.status === "ACTIVE" && !find(noisy, "STABLE_PATTERN"));
}

/* ── ANOMALY needs a baseline and a real deviation; one spike is not a trend ─────── */
{
  const base = history(24, (i) => 4 + (i % 3) * 0.5);
  const r = assessNumeric([...base, pt(10, 4.5), pt(20, 4), pt(30, 45)], SPEC, AS_OF);
  const an = find(r, "ANOMALY");
  ok("one extreme recent observation → ANOMALY naming that observation",
    an?.status === "ACTIVE" && (an.finding as { observations: unknown[] }).observations.length === 1);
  ok("…and it is NOT a material change (the rest of the recent window is normal)", !find(r, "MATERIAL_CHANGE"));
  const t = find(r, "TREND");
  ok("…and NOT an upward trend", (t?.finding as { direction?: string } | null)?.direction !== "UP");
  const calm = assessNumeric([...base, pt(10, 4.5), pt(20, 4), pt(30, 5)], SPEC, AS_OF);
  ok("an ordinary recent window → no anomaly", !find(calm, "ANOMALY"));
}

/* ── NO BASELINE POISONING ──────────────────────────────────────────────────────── */
{
  const base = history(24, (i) => 4 + (i % 3) * 0.5);
  const poisoned = [...base.slice(0, 23), { ...base[23], value: 400 }];
  const b0 = find(assessNumeric(base, SPEC, AS_OF), "BASELINE")!.baseline as { median: number };
  const b1 = find(assessNumeric(poisoned, SPEC, AS_OF), "BASELINE")!.baseline as { median: number };
  ok("one extreme value in history barely moves normal (median is robust)", Math.abs(b0.median - b1.median) <= 0.5);
}

/* ── MATERIAL_CHANGE: a sustained new level is a shift, not a stream of anomalies ── */
{
  const base = history(24, (i) => 4 + (i % 3) * 0.5);
  const recent = [80, 70, 60, 50, 40, 30, 20].map((d) => pt(d, 12 + (d % 3)));
  const r = assessNumeric([...base, ...recent], SPEC, AS_OF);
  const ch = find(r, "MATERIAL_CHANGE");
  ok("the whole recent window at a new level → MATERIAL_CHANGE UP",
    ch?.status === "ACTIVE" && (ch.finding as { direction: string }).direction === "UP");
  ok("…and NOT seven separate anomalies", !find(r, "ANOMALY"));
  ok("…the old baseline is still the baseline (recent never feeds it)",
    (find(r, "BASELINE")!.baseline as { median: number }).median <= 5);
  ok("…the new level is only a CANDIDATE until it has a baseline's support",
    (ch!.finding as { candidateNewBaseline: boolean }).candidateNewBaseline === false);
}

/* ── TREND: sustained direction across every period ─────────────────────────────── */
{
  const rising = Array.from({ length: 32 }, (_, i) => pt(450 - i * 14, 2 + i * 0.4));
  const r = assessNumeric(rising, SPEC, AS_OF);
  ok("steady rise across all periods → TREND UP", (find(r, "TREND")?.finding as { direction: string }).direction === "UP");
  const flat = assessNumeric(Array.from({ length: 32 }, (_, i) => pt(450 - i * 14, 4 + (i % 2) * 0.2)), SPEC, AS_OF);
  ok("level history → TREND FLAT", (find(flat, "TREND")?.finding as { direction: string }).direction === "FLAT");
  const sparse = assessNumeric(history(12, () => 4), SPEC, AS_OF);
  ok("a period with too few observations → TREND is INSUFFICIENT_HISTORY, not guessed",
    find(sparse, "TREND")?.status === "INSUFFICIENT_HISTORY");
  // One whole period far above the rest (a spike month): rank agreement alone could look directional,
  // which is exactly why a trend ALSO needs the first-to-last movement to clear the material floor.
  const spikeMonth = Array.from({ length: 32 }, (_, i) => pt(450 - i * 14, i >= 16 && i < 24 ? 30 : 4 + (i % 2) * 0.1));
  const sm = find(assessNumeric(spikeMonth, SPEC, AS_OF), "TREND")?.finding as { direction: string };
  ok("one spike period is not a trend (direction NONE, not UP)", sm.direction === "NONE", sm);
  ok("Kendall tau of a final-period spike stays below the trend line", Math.abs(kendallTau([4, 4, 4, 30])) < 0.66);
}

/* ── STALE: a subject that went quiet ─────────────────────────────────────────── */
{
  const old = Array.from({ length: 15 }, (_, i) => pt(200 + i * 15, 4));
  const r = assessNumeric(old, SPEC, AS_OF);
  ok("no observation for longer than staleAfterDays → BASELINE STALE, and nothing inferred about now",
    r.length === 1 && r[0].status === "STALE");
}

/* ── RATE: change and trend on a population; no per-row anomaly ─────────────────── */
{
  const RSPEC: TemporalSpec = { ...SPEC, valueKind: "rate", unit: "ratio", minHistory: 30, minRecent: 15, materialFloor: 0.1, minPerPeriod: 8 };
  const rp = (d: number, hit: boolean): RatePoint => ({ at: ago(d), hit, recordId: ++rid, evidenceKind: "lab" });
  const hist = Array.from({ length: 60 }, (_, i) => rp(95 + i * 6, i % 10 === 0));
  const up = Array.from({ length: 20 }, (_, i) => rp(5 + i * 4, i % 2 === 0));
  const r = assessRate([...hist, ...up], RSPEC, AS_OF);
  ok("10% → 50%: rate MATERIAL_CHANGE UP", (find(r, "MATERIAL_CHANGE")?.finding as { direction: string } | undefined)?.direction === "UP");
  ok("a rate never yields a per-observation ANOMALY", !find(r, "ANOMALY"));
  const same = assessRate([...hist, ...Array.from({ length: 20 }, (_, i) => rp(5 + i * 4, i % 10 === 0))], RSPEC, AS_OF);
  ok("same proportion recently → no change", !find(same, "MATERIAL_CHANGE"));
}

/* ── CADENCE: an expected occurrence that has not appeared ───────────────────────── */
{
  const CSPEC: TemporalSpec = { ...SPEC, valueKind: "cadence", minHistory: 5, materialFloor: 5, staleAfterDays: 240, minPerPeriod: 2 };
  const monthly = Array.from({ length: 10 }, (_, i) => pt(120 + i * 30, 30));
  const r = assessNumeric(monthly, CSPEC, AS_OF, { lastEventAt: ago(120) });
  const an = find(r, "ANOMALY");
  ok("a monthly rhythm silent for 120 days → ANOMALY: expected occurrence missing (no cause claimed)",
    (an?.finding as { expectedOccurrenceMissing: { daysSinceLast: number } | null } | undefined)?.expectedOccurrenceMissing?.daysSinceLast === 120);
  const onTime = assessNumeric(monthly, CSPEC, AS_OF, { lastEventAt: ago(25) });
  ok("…but 25 days since the last one is simply on rhythm", !find(onTime, "ANOMALY"));
}

/* ── DETERMINISM: order-independent, as-of exact, fingerprints stable ───────────── */
{
  const pts = [...history(24, (i) => 4 + (i % 3)), pt(10, 30)];
  const a = assessNumeric(pts, SPEC, AS_OF);
  const b = assessNumeric([...pts].reverse(), SPEC, AS_OF);
  const slot = (x: TemporalArtifact[]) => x.map((z) => ({ ...z, entityType: null, entityId: null, contextKey: "" }));
  ok("input order does not change a single artifact",
    JSON.stringify(slot(a).map(semanticHash)) === JSON.stringify(slot(b).map(semanticHash)) &&
    JSON.stringify(a.map((z) => evidenceFingerprint(z.evidenceRefs))) === JSON.stringify(b.map((z) => evidenceFingerprint(z.evidenceRefs))));
  const later = assessNumeric(pts, SPEC, new Date(AS_OF.getTime() + 200 * DAY));
  ok("a different asOf is a different question (windows move)",
    evidenceFingerprint(later[0].evidenceRefs) !== evidenceFingerprint(a[0].evidenceRefs));
  const minus = assessNumeric(pts.slice(1), SPEC, AS_OF);
  ok("removing (reversing) one observation changes the evidence fingerprint",
    evidenceFingerprint(minus[0].evidenceRefs) !== evidenceFingerprint(a[0].evidenceRefs));
}

/* ── THE CATALOGUE: sensor-manifest boundary, versions, no forbidden rules ───────── */
{
  const rules = temporalCatalogue();
  const manifest = readFileSync(join(__dirname, "..", "..", "..", "docs", "learning", "SENSOR_COVERAGE.md"), "utf8");
  const statusOf = new Map<string, string>();
  for (const line of manifest.split(/\r?\n/)) {
    if (!line.startsWith("| ") || line.startsWith("| Action") || line.startsWith("|---")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const action = cells[1];
    const status = (cells[cells.length - 3].match(/COVERED_BY_DOMAIN_STATE|COVERED|PARTIAL|GAP|BLOCKED_PRODUCT_SEMANTICS|NOT_LEARNING_RELEVANT/) ?? [""])[0];
    statusOf.set(action, status);
  }
  for (const r of rules) {
    ok(`${r.ruleId}: declares its manifest dependencies`, r.manifestDependencies.length > 0);
    for (const dep of r.manifestDependencies) {
      const st = statusOf.get(dep);
      const trusted = st === "COVERED" || st === "COVERED_BY_DOMAIN_STATE";
      ok(`${r.ruleId}: "${dep}" is trusted evidence (${st ?? "NOT IN MANIFEST"})`,
        trusted || (st === "PARTIAL" && (r.partialJustification ?? "").length > 40));
    }
    ok(`${r.ruleId}: versioned`, /^v\d+$/.test(r.versionLabel) && r.policyKey.startsWith("temporal-"));
  }
  ok("ten temporal rules, each its own lineage", rules.length === 10 && new Set(rules.map((r) => r.policyKey)).size === 10);
  ok("INV-05 is not in the catalogue (blocked by the POS held-sale defect)", !rules.some((r) => r.followsRule === "INV-05"));
  // No cross-business path: a rule's source takes ONE businessId, and its series are built only from
  // what that source returned. There is no second argument through which another tenant could enter.
  ok("every source loads for exactly one business", rules.every((r) => r.source.load.length === 2));
}

console.log(failed === 0 ? "\nM6 temporal engine: normal is per business, change is not noise. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
