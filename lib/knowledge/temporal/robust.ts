/**
 * M6 · Robust statistics, deterministic and pure.
 *
 * Median, quartiles and the median absolute deviation, because business data is not normal: one
 * invoice filed a year late, one vendor bill for an annual licence. A mean would let that single
 * point decide what "normal" means. DOC-04 already showed it in Production.
 *
 * Quantiles use linear interpolation between closest ranks (the "type 7" definition), so the same
 * sample always produces the same numbers regardless of platform.
 */
import type { RateSummary, RobustSummary } from "./temporal.contract";

export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("quantile of an empty sample is undefined");
  if (sorted.length === 1) return sorted[0];
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function robustSummary(values: readonly number[]): RobustSummary {
  if (values.length === 0) throw new Error("robust summary of an empty sample is undefined");
  const s = [...values].sort((a, b) => a - b);
  const median = quantile(s, 0.5);
  const q1 = quantile(s, 0.25);
  const q3 = quantile(s, 0.75);
  const dev = s.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  return {
    n: s.length,
    median: r4(median),
    q1: r4(q1),
    q3: r4(q3),
    iqr: r4(q3 - q1),
    mad: r4(quantile(dev, 0.5)),
    min: r4(s[0]),
    max: r4(s[s.length - 1]),
  };
}

/**
 * A robust scale for deviation tests: 1.4826 × MAD estimates σ for normal data while ignoring
 * outliers. When MAD is zero (over half the sample identical), fall back to IQR ÷ 1.349; when that is
 * zero too, the history is degenerate and the caller must use its material floor alone.
 */
export function robustScale(s: RobustSummary): number {
  if (s.mad > 0) return 1.4826 * s.mad;
  if (s.iqr > 0) return s.iqr / 1.349;
  return 0;
}

export function rateSummary(hits: readonly boolean[]): RateSummary {
  const n = hits.length;
  const h = hits.filter(Boolean).length;
  return { n, hits: h, proportion: n === 0 ? 0 : r4(h / n) };
}

/**
 * Two-proportion z statistic with a pooled standard error. Used only for rate MATERIAL_CHANGE, and
 * only together with a material floor on the difference itself, so a large population cannot turn a
 * trivial difference into a "change".
 */
export function twoProportionZ(a: RateSummary, b: RateSummary): number {
  if (a.n === 0 || b.n === 0) return 0;
  const p = (a.hits + b.hits) / (a.n + b.n);
  const se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
  return se === 0 ? 0 : (b.proportion - a.proportion) / se;
}

/**
 * Kendall's tau over a short sequence of period levels: +1 strictly increasing, −1 strictly
 * decreasing. Rank-based, so one extreme period cannot manufacture a direction on its own.
 */
export function kendallTau(levels: readonly number[]): number {
  const k = levels.length;
  if (k < 2) return 0;
  let s = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = i + 1; j < k; j += 1) s += Math.sign(levels[j] - levels[i]);
  }
  return s / ((k * (k - 1)) / 2);
}

/** Four decimals: enough for every unit here, and exact across rebuilds. */
export function r4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
