/**
 * DOC-04 — the first MEASURE. Run:
 *   npx tsx lib/knowledge/rules/documents-paperwork-lag.test.ts
 *
 * The contract under test is mostly about RESTRAINT. It is easy to make a rule that always produces a
 * number; the hard part, and the part that decides whether an owner ever trusts this system, is that it
 * refuses when it should, refuses in a way it can explain, and never lets a refusal carry a value that
 * something downstream might read anyway.
 */
import {
  derivePaperworkLag,
  lagDays,
  MIN_SUPPORT,
  WINDOW_DAYS,
  MEASURE_KEY,
  type PaperworkObservation,
} from "./documents-paperwork-lag";
import { median, trendFromWindows, measureFingerprint } from "../measure.contract";
import { validateMeasure, MeasureRejected } from "../measure-writer";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const NOW = new Date("2026-09-22T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

/** An approval `approvedAgo` days ago, for a document dated `lag` days before that. */
const obs = (recordId: number, approvedAgo: number, lag: number, businessId = 3): PaperworkObservation => ({
  recordId,
  businessId,
  approvedAt: ago(approvedAgo),
  documentDate: new Date(ago(approvedAgo).getTime() - lag * DAY),
});

// ── Refusal ────────────────────────────────────────────────────────────────
{
  const r = derivePaperworkLag([obs(1, 10, 3), obs(2, 9, 4)], NOW);
  ok("below minimum support the rule refuses", r.status === "INSUFFICIENT_EVIDENCE");
  ok("a refusal carries NO value", r.valueNumeric === null);
  ok("a refusal still reports what it saw", r.observationCount === 2);
  ok("a refusal explains itself", (r.detail as { have: number }).have === 2 &&
    (r.detail as { minSupport: number }).minSupport === MIN_SUPPORT);
  ok("a refusal still carries its window", r.windowEnd.getTime() === NOW.getTime());
  ok("a refusal still carries its evidence", r.evidenceSet.refs.length === 2);
}

{
  const none = derivePaperworkLag([], NOW);
  ok("no evidence at all is a refusal, not a crash", none.status === "INSUFFICIENT_EVIDENCE");
  ok("…with an empty fingerprint rather than a fabricated one", none.evidenceSet.fingerprint === "");
}

// ── A real habit ───────────────────────────────────────────────────────────
{
  const sample = [obs(1, 50, 2), obs(2, 40, 4), obs(3, 30, 6), obs(4, 20, 8), obs(5, 10, 10)];
  const r = derivePaperworkLag(sample, NOW);
  ok("at minimum support the rule speaks", r.status === "ACTIVE");
  ok("the value is the MEDIAN lag", r.valueNumeric === 6, r.valueNumeric);
  ok("the unit is days", r.valueUnit === "days");
  ok("the key is the governed one", r.measureKey === MEASURE_KEY);
  ok("it is a business-level measure", r.entityType === null && r.entityId === null);
  ok("every observation is linked as evidence", r.evidenceSet.refs.length === 5);
  ok("evidence refs are references, not payloads",
    Object.keys(r.evidenceSet.refs[0]).sort().join(",") === "businessId,kind,recordId");
}

// The median is chosen over the mean precisely so one catastrophe cannot invent a habit.
{
  const withOutlier = [obs(1, 50, 2), obs(2, 40, 2), obs(3, 30, 2), obs(4, 20, 2), obs(5, 10, 300)];
  const r = derivePaperworkLag(withOutlier, NOW);
  ok("a single extreme case does not move the median", r.valueNumeric === 2, r.valueNumeric);
  ok("…but it is still visible in the detail", (r.detail as { slowestDays: number }).slowestDays === 300);
}

// ── The window is real ─────────────────────────────────────────────────────
{
  const old = [obs(1, WINDOW_DAYS + 5, 3), obs(2, WINDOW_DAYS + 6, 3), obs(3, WINDOW_DAYS + 7, 3),
    obs(4, WINDOW_DAYS + 8, 3), obs(5, WINDOW_DAYS + 9, 3)];
  const r = derivePaperworkLag(old, NOW);
  ok("evidence outside the window does not count", r.status === "INSUFFICIENT_EVIDENCE");
  ok("…and is not linked as evidence either", r.evidenceSet.refs.length === 0);
}

// ── Determinism: the fingerprint is the rebuild guarantee ──────────────────
{
  const sample = [obs(3, 30, 6), obs(1, 50, 2), obs(5, 10, 10), obs(2, 40, 4), obs(4, 20, 8)];
  const a = derivePaperworkLag(sample, NOW);
  const b = derivePaperworkLag([...sample].reverse(), NOW);
  ok("input order does not change the result", a.valueNumeric === b.valueNumeric);
  ok("input order does not change the fingerprint",
    a.evidenceSet.fingerprint === b.evidenceSet.fingerprint, {
      a: a.evidenceSet.fingerprint, b: b.evidenceSet.fingerprint });
  ok("the fingerprint is identity-only", !a.evidenceSet.fingerprint.includes("6"));
}

// ── Trend ──────────────────────────────────────────────────────────────────
{
  // Recent half filed fast, older half slow → improving.
  const improving = [obs(1, 170, 20), obs(2, 160, 22), obs(3, 150, 21),
    obs(4, 20, 2), obs(5, 10, 3), obs(6, 5, 2)];
  ok("filing faster than before is IMPROVING", derivePaperworkLag(improving, NOW).trend === "IMPROVING");

  const worsening = [obs(1, 170, 2), obs(2, 160, 3), obs(3, 150, 2),
    obs(4, 20, 25), obs(5, 10, 24), obs(6, 5, 26)];
  ok("filing slower than before is WORSENING", derivePaperworkLag(worsening, NOW).trend === "WORSENING");

  // Enough overall, but one half is too thin to compare.
  const lopsided = [obs(1, 170, 5), obs(2, 160, 5), obs(3, 150, 5), obs(4, 140, 5), obs(5, 130, 5)];
  ok("a half with too little support yields NO trend, not a guess",
    derivePaperworkLag(lopsided, NOW).trend === null);
}

{
  ok("noise is not a trend", trendFromWindows(5.2, 5.0, 0.5) === "STABLE");
  ok("a missing half yields null", trendFromWindows(null, 5, 0.5) === null);
}

// ── Future-dated documents are kept, never negative ────────────────────────
{
  const future: PaperworkObservation = {
    recordId: 9, businessId: 3, approvedAt: ago(5),
    documentDate: new Date(ago(5).getTime() + 10 * DAY),
  };
  ok("a document dated after its approval clamps to zero, not a negative lag", lagDays(future) === 0);
}

// ── The writer refuses the shapes that would corrupt meaning ───────────────
{
  const base = derivePaperworkLag([obs(1, 50, 2), obs(2, 40, 4), obs(3, 30, 6), obs(4, 20, 8), obs(5, 10, 10)], NOW);
  const threw = (f: () => void) => { try { f(); return false; } catch (e) { return e instanceof MeasureRejected; } };

  ok("a cross-tenant evidence ref is rejected", threw(() => validateMeasure(999, base)));
  ok("an ACTIVE measure with no value is rejected",
    threw(() => validateMeasure(3, { ...base, valueNumeric: null })));
  ok("an INSUFFICIENT_EVIDENCE measure carrying a value is rejected",
    threw(() => validateMeasure(3, { ...base, status: "INSUFFICIENT_EVIDENCE" })));
  ok("a count that disagrees with the evidence is rejected",
    threw(() => validateMeasure(3, { ...base, observationCount: 99 })));
  ok("a valid measure passes", !threw(() => validateMeasure(3, base)));
}

// ── Pure helpers ───────────────────────────────────────────────────────────
{
  ok("median of an even sample averages the middle two", median([1, 2, 3, 4]) === 2.5);
  ok("median of one is itself", median([7]) === 7);
  ok("fingerprint is stable and readable",
    measureFingerprint([{ kind: "financial-record", businessId: 3, recordId: 1 }]) === "financial-record:3:1");
}

// ── STATIC: the rule must stay pure ────────────────────────────────────────
{
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "documents-paperwork-lag.ts"), "utf8");
  ok("the rule imports no Prisma", !/@prisma\/client|lib\/prisma/.test(src));
  ok("the rule reads no clock", !/Date\.now\(\)|new Date\(\)/.test(src));
  ok("the rule reads no env", !/process\.env/.test(src));
  ok("the rule declares no confidence", !/confidence/i.test(src));
}

console.log(failed === 0 ? "\nDOC-04: derives, refuses, explains, and stays pure. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
