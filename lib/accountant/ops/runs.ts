/**
 * The run log of the accountant sweep and of its monitor ("AccountantOpsRun", a platform table: no tenant key,
 * no business data — counts only, by CHECK). A run is recorded RUNNING when it starts and finished when it ends;
 * one that never finishes (killed at the function limit) stays RUNNING, which is how the monitor sees a crash.
 *
 * Recording a sweep run must never change the sweep: every write here is best-effort for the sweep (a failure is
 * logged and swallowed by the caller), and the counts are the sweep's own summary.
 */

import { prisma } from "@/lib/prisma";
import type { RunFact } from "./findings";

export type RunKind = "SWEEP" | "MONITOR";
export type RunSource = "VERCEL_CRON" | "GITHUB_ACTIONS";
export type RunCounts = { [key: string]: number | boolean | RunCounts };

/** Vercel Cron calls with GET; the GitHub Actions jobs POST. */
export function runSourceOf(method: string): RunSource {
  return method.toUpperCase() === "GET" ? "VERCEL_CRON" : "GITHUB_ACTIONS";
}

/** Keeps numbers, booleans and nested objects of them — the table refuses anything else. */
export function countsOnly(value: unknown, depth = 0): RunCounts {
  const out: RunCounts = {};
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = countsOnly(v, depth + 1);
  }
  return out;
}

export async function startRun(kind: RunKind, source: RunSource, now: Date): Promise<number> {
  const row = await prisma.accountantOpsRun.create({ data: { kind, source, startedAt: now, outcome: "RUNNING" }, select: { id: true } });
  return row.id;
}

export async function finishRun(id: number, outcome: "OK" | "FAILED", counts: unknown, errorCode: string | null, now: Date): Promise<void> {
  const code = errorCode && /^[A-Za-z0-9_:.-]{1,64}$/.test(errorCode) ? errorCode : errorCode ? "error" : null;
  // Only a run still RUNNING is finished, once; the end is never before the start (the table's CHECK).
  const run = await prisma.accountantOpsRun.findUnique({ where: { id }, select: { startedAt: true } });
  if (!run) return;
  await prisma.accountantOpsRun.updateMany({
    where: { id, outcome: "RUNNING" },
    data: {
      finishedAt: now.getTime() < run.startedAt.getTime() ? run.startedAt : now,
      outcome,
      counts: countsOnly(counts),
      errorCode: code,
    },
  });
}

/** The newest sweep runs (newest first), when the monitor first ran, and its newest run from each channel. */
export async function readRunFacts(limit = 6): Promise<{
  sweepRuns: RunFact[];
  firstMonitorRunAt: Date | null;
  lastMonitorRunBySource: { VERCEL_CRON: Date | null; GITHUB_ACTIONS: Date | null };
}> {
  const sweepRuns = await prisma.accountantOpsRun.findMany({
    where: { kind: "SWEEP" },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { kind: true, startedAt: true, finishedAt: true, outcome: true },
  });
  const first = await prisma.accountantOpsRun.findFirst({ where: { kind: "MONITOR" }, orderBy: { startedAt: "asc" }, select: { startedAt: true } });
  const lastOf = async (source: RunSource) =>
    (await prisma.accountantOpsRun.findFirst({ where: { kind: "MONITOR", source }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }))
      ?.startedAt ?? null;
  return {
    sweepRuns: sweepRuns as RunFact[],
    firstMonitorRunAt: first?.startedAt ?? null,
    lastMonitorRunBySource: { VERCEL_CRON: await lastOf("VERCEL_CRON"), GITHUB_ACTIONS: await lastOf("GITHUB_ACTIONS") },
  };
}
