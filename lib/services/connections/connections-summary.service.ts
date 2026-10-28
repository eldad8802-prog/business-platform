/**
 * How many of the business's connections are live right now — the number the
 * Settings hub shows beside "חיבורים".
 *
 * A connection counts only when it is in the same state the Connections screen
 * itself shows as connected. Supporting a provider is not a connection, and a
 * revoked, paused, errored or expired one is not active:
 *
 *   whatsapp      WhatsAppConnection.status = CONNECTED       (IntegrationStatusCards)
 *   gmail         EmailConnection gmail rows with status = connected, one per account
 *   payments      BusinessPaymentConnection.isActive           (PaymentConnectionCard)
 *   taxAuthority  the authority UI status = CONNECTED — the same resolver the
 *                 card calls, so an expired refresh token is EXPIRED, not active
 *   leadSources   AcquisitionConnection.status = ACTIVE, for sources this business
 *                 is enabled for (LeadSourcesPanel only lists enabled sources)
 *   storesAndCalls  AcquisitionConnection.status = ACTIVE for the enabled store / phone
 *                 sources (StoresAndCallsPanel: WooCommerce, Wix, CloudTalk, Voicenter).
 *                 Rivhit (pos.rivhit) is not counted: it has no connect screen yet (M2).
 *
 * All-or-nothing: if any source cannot be read, `active` is null and the hub
 * shows no number rather than a partial one that looks complete.
 *
 * `businessId` / `userId` are server-derived (the session). Read-only: nothing
 * here connects, refreshes or changes a provider.
 */
import { BillingAuthorityEnvironment } from "@prisma/client";

import { enabledSources } from "@/lib/intake/acquisition/owner-api";
import { ACQUISITION_SOURCE_KEYS } from "@/lib/intake/acquisition/gate";
import { getActiveAuthorityApp } from "@/lib/services/billing/authority/billing-authority-app.service";
import { resolveRuntimeAuthorityEnvironment } from "@/lib/services/billing/authority/billing-authority-env.service";
import { getAuthorityConnectionStatus } from "@/lib/services/billing/authority/billing-authority-status.service";
import { resolveAuthorityStatusRequest } from "@/lib/services/billing/authority/billing-authority-status-view.service";
import { findPublicByBusinessId } from "@/lib/services/integrations/whatsapp/connection.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { tenantTx } from "@/lib/tenant/tenant-tx";

/** The store / phone sources StoresAndCallsPanel manages (S1-B · M1: counted on the hub too). */
export const STORES_AND_CALLS_SOURCE_KEYS = [
  "commerce.woocommerce",
  "commerce.wix",
  "telephony.cloudtalk",
  "telephony.voicenter",
] as const;

export type ConnectionsBreakdown = {
  whatsapp: number;
  gmail: number;
  payments: number;
  taxAuthority: number;
  leadSources: number;
  storesAndCalls: number;
};

export type ConnectionsSummary =
  | { available: true; active: number; breakdown: ConnectionsBreakdown }
  | { available: false; active: null; breakdown: null };

export type ConnectionsSummaryCaller = { businessId: number; userId: number };

/** Mirrors /api/taxes/authority/status: an unresolvable environment reads as SANDBOX. */
function authorityEnvironment(): BillingAuthorityEnvironment {
  try {
    return resolveRuntimeAuthorityEnvironment();
  } catch {
    return BillingAuthorityEnvironment.SANDBOX;
  }
}

async function whatsappActive(businessId: number): Promise<number> {
  const connection = await findPublicByBusinessId(businessId);
  return connection?.status === "CONNECTED" ? 1 : 0;
}

async function taxAuthorityActive(caller: ConnectionsSummaryCaller): Promise<number> {
  const outcome = await resolveAuthorityStatusRequest({
    actor: { id: caller.userId, businessId: caller.businessId },
    requestedBusinessId: null,
    environment: authorityEnvironment(),
    deps: { getActiveAuthorityApp, getAuthorityConnectionStatus, now: () => new Date() },
  });
  if (!outcome.ok) throw new Error("authority status refused for the caller's own business");
  return outcome.dto.status === "CONNECTED" ? 1 : 0;
}

async function tenantCounts(businessId: number) {
  const enabled = await runWithTenantContext({ businessId }, () => enabledSources(businessId));
  const enabledOf = (keys: readonly string[]) =>
    Object.entries(enabled)
      .filter(([key, on]) => on && keys.includes(key))
      .map(([key]) => key);
  // Lead sources (M6) and stores / phone lines (M7) are counted apart: an order or a call is not a lead.
  const enabledKeys = enabledOf(ACQUISITION_SOURCE_KEYS);
  const enabledStoreKeys = enabledOf(STORES_AND_CALLS_SOURCE_KEYS);

  return tenantTx(businessId, async (tx) => {
    const gmail = await tx.emailConnection.count({
      where: { businessId, provider: "gmail", status: "connected" },
    });
    const payments = await tx.businessPaymentConnection.count({
      where: { businessId, isActive: true },
    });
    const leadSources =
      enabledKeys.length === 0
        ? 0
        : await tx.acquisitionConnection.count({
            where: { businessId, status: "ACTIVE", sourceKey: { in: enabledKeys } },
          });
    const storesAndCalls =
      enabledStoreKeys.length === 0
        ? 0
        : await tx.acquisitionConnection.count({
            where: { businessId, status: "ACTIVE", sourceKey: { in: enabledStoreKeys } },
          });
    return { gmail, payments, leadSources, storesAndCalls };
  });
}

export async function loadConnectionsSummary(
  caller: ConnectionsSummaryCaller,
): Promise<ConnectionsSummary> {
  const [whatsapp, taxAuthority, counts] = await Promise.allSettled([
    whatsappActive(caller.businessId),
    taxAuthorityActive(caller),
    tenantCounts(caller.businessId),
  ]);

  if (
    whatsapp.status !== "fulfilled" ||
    taxAuthority.status !== "fulfilled" ||
    counts.status !== "fulfilled"
  ) {
    for (const result of [whatsapp, taxAuthority, counts]) {
      if (result.status === "rejected") {
        const reason = result.reason;
        // Name only — a provider error message may carry configuration.
        console.error("CONNECTIONS_SUMMARY_SOURCE_ERROR:", reason instanceof Error ? reason.name : "UnknownError");
      }
    }
    return { available: false, active: null, breakdown: null };
  }

  const breakdown: ConnectionsBreakdown = {
    whatsapp: whatsapp.value,
    gmail: counts.value.gmail,
    payments: counts.value.payments,
    taxAuthority: taxAuthority.value,
    leadSources: counts.value.leadSources,
    storesAndCalls: counts.value.storesAndCalls,
  };
  const active = Object.values(breakdown).reduce((sum, n) => sum + n, 0);
  return { available: true, active, breakdown };
}
