import { AsyncLocalStorage } from "node:async_hooks";
import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
  type IntervalHistogram,
} from "node:perf_hooks";

/**
 * TIMELINE for GET /api/home/collection — observability only.
 *
 * Production has failed three times with P2028: the four PaymentTransaction
 * reads were submitted ~5–6 s after the interactive transaction opened, so
 * Prisma refused them. Nothing yet says where that time went. This records,
 * per request, when each phase happened and whether the Node event loop was
 * busy or idle in between, and hands that to the existing failure line.
 *
 * WHY EVENT-LOOP UTILISATION, NOT TIMESTAMPS ALONE
 *
 * Every mark is taken by JavaScript. If the event loop is blocked, the mark
 * that follows an await (say, `set_config` resolved) is itself late — so a
 * stall shows up as a long interval wherever the await was, and a timestamp
 * cannot say whether the database was slow or JavaScript could not run.
 * `performance.eventLoopUtilization()` can: between two marks it gives how
 * long the loop was ACTIVE (running JavaScript) against IDLE (waiting on I/O).
 * A long, mostly-idle interval means waiting on the database or network; a
 * long, mostly-active one means the process could not get back to this request.
 * ELU is process-wide and costs a counter read — no timer, no allocation.
 *
 * `monitorEventLoopDelay` adds the longest single delay seen during the
 * request (one long block against many short ones). It runs a 10 ms libuv
 * timer only while this request is in flight, and is always disabled when the
 * request ends, so nothing survives the request.
 *
 * WHAT IT NEVER DOES
 *
 * Change the work. Every mark and summary is wrapped: if measurement fails it
 * is skipped, and the request runs exactly as it would without it. Success
 * logs nothing. Nothing here touches the tenant context, the transaction, the
 * timeout or the queries.
 */

/** The phases. T2–T4 are reported by the tenant transaction helper. */
export type HomeCollectionPhase = "T0" | "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "TERR";

const ORDER: HomeCollectionPhase[] = ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "TERR"];

type Timeline = {
  at: Partial<Record<HomeCollectionPhase, number>>;
  elu: Partial<Record<HomeCollectionPhase, EventLoopUtilization>>;
  delay: IntervalHistogram | null;
  inFlightAtStart: number;
  requestsSeen: number;
  processUptimeMs: number;
  moduleAgeMs: number;
};

export type HomeCollectionTimelineSpan = {
  span: string;
  ms: number;
  /** Event loop running JavaScript during the span. */
  loopActiveMs: number | null;
  /** Event loop idle (waiting on I/O) during the span. */
  loopIdleMs: number | null;
};

export type HomeCollectionTimelineSummary = {
  /** Phases reached, ms since T0 (rounded). Absent phases were never reached. */
  marks: Partial<Record<HomeCollectionPhase, number>>;
  routeToTxRequestMs: number | null;
  txRequestToCallbackMs: number | null;
  callbackToSetConfigStartMs: number | null;
  setConfigMs: number | null;
  setConfigResolvedToReadsSubmittedMs: number | null;
  readsMs: number | null;
  txTotalMs: number | null;
  requestMs: number | null;
  /** Each interval between consecutive reached phases, with the event loop's share. */
  spans: HomeCollectionTimelineSpan[];
  eventLoopDelay: { maxMs: number; meanMs: number; p99Ms: number } | null;
  /** Cold-start evidence for this module instance. */
  instance: {
    processUptimeMs: number;
    moduleAgeMs: number;
    /** Requests this route has handled in this instance, this one included. 1 = the first. */
    requestsSeen: number;
    /** Other requests to THIS route in flight in this instance when this one began. */
    inFlightAtStart: number;
  };
  commit: string | null;
  deploymentId: string | null;
};

const storage = new AsyncLocalStorage<Timeline>();
const moduleLoadedAt = performance.now();
let requestsSeen = 0;
let inFlight = 0;

const SAFE_COMMIT = /^[0-9a-f]{7,40}$/;
const SAFE_DEPLOYMENT = /^dpl_[A-Za-z0-9]{1,64}$/;

/** Record a phase for the request in scope. Silent if none, or if measuring fails. */
export function markHomeCollection(phase: HomeCollectionPhase): void {
  try {
    const timeline = storage.getStore();
    if (!timeline || timeline.at[phase] !== undefined) return;
    timeline.at[phase] = performance.now();
    timeline.elu[phase] = performance.eventLoopUtilization();
  } catch {
    // Measurement never affects the request.
  }
}

/** The tenant transaction's phases, mapped onto this timeline. */
export function homeCollectionTxObserver(phase: "callback" | "set-config-start" | "set-config-resolved"): void {
  markHomeCollection(phase === "callback" ? "T2" : phase === "set-config-start" ? "T3" : "T4");
}

function startTimeline(): Timeline | null {
  try {
    requestsSeen += 1;
    const timeline: Timeline = {
      at: {},
      elu: {},
      delay: null,
      inFlightAtStart: inFlight,
      requestsSeen,
      processUptimeMs: Math.round(process.uptime() * 1000),
      moduleAgeMs: Math.round(performance.now() - moduleLoadedAt),
    };
    try {
      const histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
      timeline.delay = histogram;
    } catch {
      timeline.delay = null;
    }
    inFlight += 1;
    return timeline;
  } catch {
    return null;
  }
}

function endTimeline(timeline: Timeline | null): void {
  if (!timeline) return;
  try {
    timeline.delay?.disable();
  } catch {
    // ignore
  }
  inFlight = Math.max(0, inFlight - 1);
}

/**
 * Run the request's work with a timeline in scope. The work's result and error
 * pass through untouched; `onError` sees the summary before the error rethrows.
 */
export async function runWithHomeCollectionTimeline<T>(
  work: () => Promise<T>,
  onError: (summary: HomeCollectionTimelineSummary | null) => void
): Promise<T> {
  const timeline = startTimeline();
  if (!timeline) return work();
  try {
    return await storage.run(timeline, async () => {
      markHomeCollection("T0");
      return work();
    });
  } catch (error) {
    let summary: HomeCollectionTimelineSummary | null = null;
    try {
      timeline.at.TERR ??= performance.now();
      timeline.elu.TERR ??= performance.eventLoopUtilization();
      summary = summarizeHomeCollectionTimeline(timeline);
    } catch {
      summary = null;
    }
    try {
      onError(summary);
    } catch {
      // ignore
    }
    throw error;
  } finally {
    endTimeline(timeline);
  }
}

const round = (value: number) => Math.max(0, Math.round(value));

function between(timeline: Timeline, from: HomeCollectionPhase, to: HomeCollectionPhase): number | null {
  const a = timeline.at[from];
  const b = timeline.at[to];
  return a === undefined || b === undefined ? null : round(b - a);
}

function safeEnv(name: string, pattern: RegExp, slice?: number): string | null {
  const value = process.env[name];
  if (typeof value !== "string") return null;
  const v = slice ? value.slice(0, slice) : value;
  return pattern.test(v) ? v : null;
}

/** Numbers only, from fixed keys. Exported for tests. */
export function summarizeHomeCollectionTimeline(timeline: {
  at: Partial<Record<HomeCollectionPhase, number>>;
  elu: Partial<Record<HomeCollectionPhase, EventLoopUtilization>>;
  delay: IntervalHistogram | null;
  inFlightAtStart: number;
  requestsSeen: number;
  processUptimeMs: number;
  moduleAgeMs: number;
}): HomeCollectionTimelineSummary {
  const t = timeline as Timeline;
  const t0 = t.at.T0 ?? 0;
  const marks: Partial<Record<HomeCollectionPhase, number>> = {};
  for (const phase of ORDER) {
    const value = t.at[phase];
    if (value !== undefined) marks[phase] = round(value - t0);
  }

  const reached = ORDER.filter((phase) => t.at[phase] !== undefined);
  const spans: HomeCollectionTimelineSpan[] = [];
  for (let i = 1; i < reached.length; i++) {
    const from = reached[i - 1];
    const to = reached[i];
    let loopActiveMs: number | null = null;
    let loopIdleMs: number | null = null;
    const ms = between(t, from, to) ?? 0;
    const a = t.elu[from];
    const b = t.elu[to];
    if (a && b) {
      const active = b.active - a.active;
      const idle = b.idle - a.idle;
      // Before the event loop has started, ELU reports zeros. Zero active AND zero
      // idle across real elapsed time is "not measured", never "neither".
      if (active + idle > 0 || ms === 0) {
        loopActiveMs = round(active);
        loopIdleMs = round(idle);
      }
    }
    spans.push({ span: `${from}-${to}`, ms, loopActiveMs, loopIdleMs });
  }

  const end: HomeCollectionPhase = t.at.T7 !== undefined ? "T7" : "TERR";
  let eventLoopDelay: HomeCollectionTimelineSummary["eventLoopDelay"] = null;
  if (t.delay && t.delay.count > 0) {
    const ns = 1e6;
    eventLoopDelay = {
      maxMs: round(t.delay.max / ns),
      meanMs: round(t.delay.mean / ns),
      p99Ms: round(t.delay.percentile(99) / ns),
    };
  }

  return {
    marks,
    routeToTxRequestMs: between(t, "T0", "T1"),
    txRequestToCallbackMs: between(t, "T1", "T2"),
    callbackToSetConfigStartMs: between(t, "T2", "T3"),
    setConfigMs: between(t, "T3", "T4"),
    setConfigResolvedToReadsSubmittedMs: between(t, "T4", "T5"),
    readsMs: between(t, "T5", "T6"),
    txTotalMs: between(t, "T1", end),
    requestMs: between(t, "T0", t.at.TERR !== undefined ? "TERR" : "T7"),
    spans,
    eventLoopDelay,
    instance: {
      processUptimeMs: round(t.processUptimeMs),
      moduleAgeMs: round(t.moduleAgeMs),
      requestsSeen: round(t.requestsSeen),
      inFlightAtStart: round(t.inFlightAtStart),
    },
    commit: safeEnv("VERCEL_GIT_COMMIT_SHA", SAFE_COMMIT, 12),
    deploymentId: safeEnv("VERCEL_DEPLOYMENT_ID", SAFE_DEPLOYMENT),
  };
}
