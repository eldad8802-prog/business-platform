/**
 * TEMPORARY — pure logic for the Tax Authority token-probe UI section.
 *
 * Remove together with the probe route, service, section, and their tests.
 *
 * Kept framework-free so it can be unit-tested without a DOM: strict response
 * validation (no blind cast), sanitized error mapping (status only — never a
 * raw body/headers/stack/token), and a runner that permits exactly ONE probe
 * request per component instance (locked after the first attempt, regardless of
 * outcome; reset only by a full page refresh — no persistence/DB/localStorage).
 */

import {
  PlatformAdminFetchError,
  type TokenProbeInvocation,
} from "@/lib/platform-admin/fetch-platform-admin";

/** The only fields ever shown in the UI: routeHttpStatus + the six probe fields. */
export type ProbeView = {
  routeHttpStatus: number | null;
  networkReachable: boolean;
  httpStatusIfAny: number | null;
  networkErrorClass: string | null;
  requestDurationBucket: string;
  runtime: string;
  region: string | null;
};

export type ProbeRunnerState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "succeeded"; view: ProbeView }
  | { phase: "failed"; routeHttpStatus: number | null; message: string };

type ParsedProbeFields = Omit<ProbeView, "routeHttpStatus">;

/**
 * Strictly validates the raw probe body and copies ONLY the six allowed fields.
 * Returns null if anything is missing or mis-typed — the caller then shows a
 * sanitized error and never surfaces the raw body.
 */
export function parseProbeResult(raw: unknown): ParsedProbeFields | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const isNumberOrNull = (v: unknown): v is number | null =>
    v === null || typeof v === "number";
  const isStringOrNull = (v: unknown): v is string | null =>
    v === null || typeof v === "string";

  if (typeof r.networkReachable !== "boolean") return null;
  if (!isNumberOrNull(r.httpStatusIfAny)) return null;
  if (!isStringOrNull(r.networkErrorClass)) return null;
  if (typeof r.requestDurationBucket !== "string") return null;
  if (typeof r.runtime !== "string") return null;
  if (!isStringOrNull(r.region)) return null;

  return {
    networkReachable: r.networkReachable,
    httpStatusIfAny: r.httpStatusIfAny,
    networkErrorClass: r.networkErrorClass,
    requestDurationBucket: r.requestDurationBucket,
    runtime: r.runtime,
    region: r.region,
  };
}

/** Sanitized, status-only message. Never includes a raw body/headers/stack. */
export function sanitizeProbeErrorMessage(status: number | null): string {
  switch (status) {
    case 401:
      return "אין הרשאה לבצע את הבדיקה (401).";
    case 403:
      return "אין הרשאת Platform Admin (403).";
    case 500:
      return "שגיאת שרת בעת הבדיקה (500).";
    case null:
      return "בקשת הרשת נכשלה בדפדפן (לא התקבלה תגובת HTTP).";
    default:
      return `הבדיקה נכשלה (${status}).`;
  }
}

/**
 * Runs the probe once and maps the outcome to a terminal state. Never throws.
 */
export async function executeTokenProbe(
  probeRequest: () => Promise<TokenProbeInvocation>
): Promise<ProbeRunnerState> {
  try {
    const { routeHttpStatus, result } = await probeRequest();
    const parsed = parseProbeResult(result);
    if (!parsed) {
      return {
        phase: "failed",
        routeHttpStatus,
        message: "התקבלה תשובה במבנה בלתי צפוי.",
      };
    }
    return { phase: "succeeded", view: { routeHttpStatus, ...parsed } };
  } catch (error) {
    if (error instanceof PlatformAdminFetchError) {
      return {
        phase: "failed",
        routeHttpStatus: error.status,
        message: sanitizeProbeErrorMessage(error.status),
      };
    }
    // No HTTP response was received (browser network failure).
    return {
      phase: "failed",
      routeHttpStatus: null,
      message: sanitizeProbeErrorMessage(null),
    };
  }
}

export type ProbeRunner = { run: () => Promise<void> };

/**
 * Creates a single-shot runner: the first `run()` locks the runner forever
 * (`started` never resets), so a double-click sends one request and no further
 * request is ever sent — regardless of success/HTTP-error/network-failure.
 * Only creating a new runner (a fresh component instance / page refresh) resets.
 */
export function createProbeRunner(deps: {
  probeRequest: () => Promise<TokenProbeInvocation>;
  onState: (state: ProbeRunnerState) => void;
}): ProbeRunner {
  let started = false;
  return {
    async run() {
      if (started) return;
      started = true;
      deps.onState({ phase: "running" });
      const outcome = await executeTokenProbe(deps.probeRequest);
      deps.onState(outcome);
    },
  };
}
