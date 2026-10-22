/**
 * i18n performance benchmark — pure helpers (no network, no DB, no browser), pinned by perf-lib.test.ts:
 *   - quantile()        nearest-rank quantile of a sample (the ONLY percentile definition used)
 *   - summarize()       n / p50 / p95 / p99 / mean / min / max of a sample, in ms, rounded to 0.01
 *   - delta()           ON − OFF per statistic (absolute ms and ratio), never hides a missing side
 *   - alternate()       the request order of one round: OFF/ON interleaved, flipped every round (ABBA),
 *                       so drift (JIT warm-up, runner noise, GC) lands on both builds equally
 *   - parseProcStat()   utime+stime (clock ticks) from /proc/<pid>/stat, robust to spaces in comm
 *   - parseVmRss()      VmRSS (kB) from /proc/<pid>/status
 *   - childPids()       descendants of a pid from (pid, ppid) pairs
 *   - mdTable()         a markdown table (used for the report written next to report.json)
 */

export type Summary = { n: number; p50: number; p95: number; p99: number; mean: number; min: number; max: number };

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Nearest-rank: the smallest value with at least q·n values ≤ it. q in (0, 1]. */
export function quantile(sample: readonly number[], q: number): number {
  if (sample.length === 0) return NaN;
  const s = [...sample].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * s.length));
  return s[Math.min(rank, s.length) - 1];
}

export function summarize(sample: readonly number[]): Summary {
  if (sample.length === 0) return { n: 0, p50: NaN, p95: NaN, p99: NaN, mean: NaN, min: NaN, max: NaN };
  const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
  return {
    n: sample.length,
    p50: r2(quantile(sample, 0.5)),
    p95: r2(quantile(sample, 0.95)),
    p99: r2(quantile(sample, 0.99)),
    mean: r2(mean),
    min: r2(Math.min(...sample)),
    max: r2(Math.max(...sample)),
  };
}

export type Delta = { p50: number; p95: number; p99: number; p50Ratio: number };

export function delta(off: Summary, on: Summary): Delta {
  return {
    p50: r2(on.p50 - off.p50),
    p95: r2(on.p95 - off.p95),
    p99: r2(on.p99 - off.p99),
    p50Ratio: off.p50 > 0 ? r2(on.p50 / off.p50) : NaN,
  };
}

/** Round i: [a, b, …] on even rounds, reversed on odd rounds (ABBA). */
export function alternate<T>(variants: readonly T[], round: number): T[] {
  return round % 2 === 0 ? [...variants] : [...variants].reverse();
}

/** /proc/<pid>/stat → utime + stime in clock ticks; fields after the ")" of comm (which may contain spaces). */
export function parseProcStat(stat: string): { ppid: number; ticks: number } | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const f = stat.slice(close + 2).trim().split(/\s+/);
  // after comm: [0]=state [1]=ppid … [11]=utime [12]=stime
  const ppid = Number(f[1]);
  const utime = Number(f[11]);
  const stime = Number(f[12]);
  if (![ppid, utime, stime].every(Number.isFinite)) return null;
  return { ppid, ticks: utime + stime };
}

export function parseVmRss(status: string): number | null {
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  return m ? Number(m[1]) : null;
}

/** All descendants of root (not including root), given (pid, ppid) pairs. */
export function childPids(root: number, pairs: ReadonlyArray<{ pid: number; ppid: number }>): number[] {
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.shift()!;
    for (const x of pairs) if (x.ppid === p && !out.includes(x.pid) && x.pid !== root) { out.push(x.pid); queue.push(x.pid); }
  }
  return out.sort((a, b) => a - b);
}

const cell = (v: unknown) => (typeof v === "number" ? (Number.isNaN(v) ? "—" : String(v)) : String(v ?? "")).replace(/\|/g, "\\|");

export function mdTable(head: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  return [
    `| ${head.map(cell).join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}
