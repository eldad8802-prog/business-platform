import type { EmbeddedSignupResult } from "./embedded-signup-controller";

/**
 * The one client → Dubiz call of the connect flow: hands the captured Embedded
 * Signup result to `POST /api/integrations/whatsapp/embedded-signup`.
 *
 * Pure (fetch + timers injected) so every outcome is unit-tested, and BOUNDED:
 * the request is aborted after `timeoutMs`, so a hanging API or a hanging Graph
 * call behind it always ends in a named, retryable error — never an endless
 * "מחברים…". The server bounds each Graph call on its own side as well.
 *
 * The `code` travels only in the request body. It is never logged, and the
 * outcome carries only safe fields (HTTP status, the server's stage/code
 * vocabulary, the display number on success).
 */

export const SUBMIT_TIMEOUT_MS = 60_000;

export type SubmitErrorCode =
  | "bad_request" // 400
  | "unauthorized" // 401
  | "forbidden" // 403
  | "number_taken" // 409 — the number is connected to another business
  | "meta_failed" // 502 — a Graph step (exchange / phone / subscribe) failed
  | "server_error" // other 5xx
  | "unexpected_status" // any other non-2xx
  | "timeout" // no answer within timeoutMs
  | "network"; // the request itself failed

export type SubmitOutcome =
  | { ok: true; httpStatus: number; displayPhoneNumber: string | null }
  | {
      ok: false;
      error: SubmitErrorCode;
      httpStatus: number | null;
      /** Server-side stage that failed (exchange / display / subscribe / persist), when given. */
      stage: string | null;
      /** Server-side safe failure code (e.g. `exchange_400_100`), when given. */
      serverCode: string | null;
    };

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type SubmitDeps = {
  fetch: FetchLike;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  timeoutMs?: number;
};

function errorForStatus(status: number): SubmitErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 409) return "number_taken";
  if (status === 502) return "meta_failed";
  if (status >= 500) return "server_error";
  return "unexpected_status";
}

function safeString(v: unknown, max = 64): string | null {
  return typeof v === "string" && /^[a-z0-9_]+$/i.test(v) ? v.slice(0, max) : null;
}

export async function submitEmbeddedSignup(
  result: EmbeddedSignupResult,
  bearerToken: string | null,
  deps: SubmitDeps
): Promise<SubmitOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = deps.setTimer(() => {
    timedOut = true;
    controller.abort();
  }, deps.timeoutMs ?? SUBMIT_TIMEOUT_MS);

  try {
    const res = await deps.fetch("/api/integrations/whatsapp/embedded-signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify({
        code: result.code,
        wabaId: result.wabaId,
        // Absent for coexistence onboarding — the server resolves it from the WABA.
        ...(result.phoneNumberId ? { phoneNumberId: result.phoneNumberId } : {}),
      }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as
      | { connection?: { displayPhoneNumber?: unknown }; stage?: unknown; code?: unknown }
      | null;
    if (timedOut) {
      return { ok: false, error: "timeout", httpStatus: null, stage: null, serverCode: null };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: errorForStatus(res.status),
        httpStatus: res.status,
        stage: safeString(data?.stage),
        serverCode: safeString(data?.code),
      };
    }
    const phone = data?.connection?.displayPhoneNumber;
    return {
      ok: true,
      httpStatus: res.status,
      displayPhoneNumber: typeof phone === "string" ? phone : null,
    };
  } catch {
    return {
      ok: false,
      error: timedOut ? "timeout" : "network",
      httpStatus: null,
      stage: null,
      serverCode: null,
    };
  } finally {
    deps.clearTimer(timer);
  }
}
