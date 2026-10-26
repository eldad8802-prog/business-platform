/**
 * The one place the Google link flows hand an email to delivery: AFTER the response, exactly as register
 * does for its WELCOME. The row was recorded in the transaction that owed it (lib/auth/google-link.ts); this
 * only tries to send it now. If it does not go out here, the transactional-email sweep sends it later.
 */

import { after } from "next/server";

import { isTransactionalEmailEnabled } from "@/lib/email/transactional/config";
import { deliverTransactionalEmail } from "@/lib/email/transactional/delivery";
import { runTenantJob } from "@/lib/tenant/job";

export function deliverGoogleLinkEmailAfterResponse(emailId: number, businessId: number): void {
  if (!isTransactionalEmailEnabled()) return;
  try {
    after(() => runTenantJob({ businessId }, async () => { await deliverTransactionalEmail(emailId); }));
  } catch (error) {
    console.error("[transactional-email] schedule_failed", { id: emailId, error: error instanceof Error ? error.name : "unknown" });
  }
}
