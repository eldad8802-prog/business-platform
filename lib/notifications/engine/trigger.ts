/**
 * Trigger (a) of the push worker: after the producer's response, for that business only (notifications track spec).
 * SERVER-ONLY.
 *
 * A producer that wrote an owed push through notify() calls `kickPushWorkerAfterResponse(businessId)` from its
 * route handler: Next's `after()` runs one worker pass for that business once the response is finished, so a push
 * does not wait for the CRON_SECRET route. Idempotent with every other trigger (the claim has one winner); the
 * worker itself is inert unless notifications_engine is ON. Outside a request scope (`after` throws there) it does
 * nothing — the scheduled route still picks the row up.
 */
import { after } from "next/server";

import { runPushWorker } from "./push-worker";

export function kickPushWorkerAfterResponse(businessId: number): void {
  try {
    after(async () => {
      try {
        await runPushWorker(new Date(), { businessId });
      } catch (e) {
        console.warn("[notifications] after-response worker failed", JSON.stringify({ error: e instanceof Error ? e.name : "unknown" }));
      }
    });
  } catch {
    /* not inside a request: the CRON_SECRET worker route is the other path */
  }
}
