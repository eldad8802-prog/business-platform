/**
 * The fast path for an email a request just recorded: delivery runs AFTER the response, under an
 * explicit tenant handoff (CI-W4-1), and never blocks, fails or delays the request. The scheduled sweep (every 10 minutes) is
 * what guarantees delivery (or expiry) when this attempt does not happen or does not succeed.
 *
 * `deliverNow` is for work that already runs after the response (inside an `after()` callback).
 */

import { after } from "next/server";

import { runTenantJob } from "@/lib/tenant/job";

import { isTransactionalEmailEnabled } from "./config";
import { deliverTransactionalEmail } from "./delivery";

export async function deliverNow(emailId: number, businessId: number): Promise<void> {
  // OFF: nothing at all — no database read, no outbound request.
  if (!isTransactionalEmailEnabled()) return;
  try {
    await runTenantJob({ businessId }, async () => {
      await deliverTransactionalEmail(emailId);
    });
  } catch (error) {
    console.error("[transactional-email] deliver_now_failed", {
      id: emailId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

export function scheduleDelivery(emailId: number, businessId: number): void {
  if (!isTransactionalEmailEnabled()) return;
  after(() => deliverNow(emailId, businessId));
}
