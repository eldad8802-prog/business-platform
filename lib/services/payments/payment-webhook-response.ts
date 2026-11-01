import { NextResponse } from "next/server";

import { answerForError, webhookErrorLog } from "./payment-webhook-failure";
import type { WebhookHandlerResult } from "./payment-webhook-handler";

/**
 * The HTTP answer of every payment webhook route. A 503 carries Retry-After; nothing is ever cached (a cached
 * "ok" could acknowledge a callback that was never received).
 */
export function webhookResponse(result: WebhookHandlerResult): NextResponse {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (result.status === 503 && result.retryAfterSeconds) headers["Retry-After"] = String(result.retryAfterSeconds);
  return NextResponse.json(result.body, { status: result.status, headers });
}

/**
 * A route's own last-resort catch (wiring, deps construction, an escape from the handler): the same decision as the
 * handler — 503 only for an infrastructure failure, 200 otherwise — and a log line with class + code only.
 */
export function webhookRouteFailure(tag: string, error: unknown): NextResponse {
  const answer = answerForError(error);
  console.warn(`[${tag}] unexpected failure`, { ...webhookErrorLog(error), answer: answer.status });
  return webhookResponse(answer);
}
