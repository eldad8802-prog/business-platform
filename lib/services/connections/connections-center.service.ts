/**
 * Connections center (S1-B · M1) — every connection the business has, grouped by what it means,
 * read from the mechanisms that already own them. Served by GET /api/settings/connections-center
 * and shown at the top of /settings/connections.
 *
 *   acquisition    AcquisitionConnection rows (lead sources, stores, phone lines, Rivhit) for the
 *                  sources enabledSources allows; Meta / Wix connectability from their app config
 *   payments       BusinessPaymentConnection (provider, isActive, updatedAt) for the providers the
 *                  payment catalogue offers (listProviderDescriptors)
 *   authority      the authority UI status — the same resolver the authority card and the hub count use
 *   whatsapp       WhatsAppConnection's public projection
 *   gmail          EmailConnection gmail rows
 *   inbound_email  InboundEmailAddress status rows, only while INBOUND_EMAIL_ENABLED is on
 *
 * Each read runs on its own (Promise.allSettled): one failing marks only its own cards
 * "unavailable" and never fails the response. Mapping lives in ./connections-center.model.ts.
 *
 * Read-only: nothing here connects, refreshes or changes a provider. The selects name only
 * status / time / display columns — no credential, token, key, ciphertext or merchant secret is
 * read, and no provider error message (WhatsApp lastErrorMessage, Gmail lastError) is selected.
 * `businessId` / `userId` are server-derived (the session).
 */
import { BillingAuthorityEnvironment } from "@prisma/client";

import { isMetaLeadAdsConfigured } from "@/lib/intake/acquisition/meta-config";
import { enabledSources } from "@/lib/intake/acquisition/owner-api";
import { wixAppConfig } from "@/lib/intake/commerce/wix";
import { wixInstallUrl } from "@/lib/intake/commerce/wix-connect";
import { isInboundEmailEnabled } from "@/lib/inbound-email/inbound-email-flag";
import { getActiveAuthorityApp } from "@/lib/services/billing/authority/billing-authority-app.service";
import { resolveRuntimeAuthorityEnvironment } from "@/lib/services/billing/authority/billing-authority-env.service";
import { getAuthorityConnectionStatus } from "@/lib/services/billing/authority/billing-authority-status.service";
import { resolveAuthorityStatusRequest } from "@/lib/services/billing/authority/billing-authority-status-view.service";
import { findPublicByBusinessId } from "@/lib/services/integrations/whatsapp/connection.service";
import { listProviderDescriptors } from "@/lib/services/payments/providers/provider-registry";
import { runWithTenantContext } from "@/lib/tenant/context";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import {
  assembleConnectionsCenter,
  mapAcquisitionCards,
  mapAuthorityCards,
  mapGmailCards,
  mapInboundEmailCards,
  mapPaymentCards,
  mapWhatsAppCards,
  unavailableCards,
  type AcquisitionInput,
  type AuthorityUiStatus,
  type ConnectionCard,
  type ConnectionSourceId,
  type ConnectionsCenter,
  type GmailRow,
  type InboundAddressRow,
  type PaymentConnectionRow,
  type WhatsAppRow,
} from "./connections-center.model";

export type ConnectionsCenterCaller = { businessId: number; userId: number };

/** The reads, injectable so the mapping and isolation can be proven without a database. */
export type ConnectionsCenterReaders = {
  acquisition: (caller: ConnectionsCenterCaller) => Promise<AcquisitionInput>;
  payments: (caller: ConnectionsCenterCaller) => Promise<{ enabledProviders: readonly string[]; connections: PaymentConnectionRow[] }>;
  authority: (caller: ConnectionsCenterCaller) => Promise<{ status: AuthorityUiStatus; connectedAt: string | null }>;
  whatsapp: (caller: ConnectionsCenterCaller) => Promise<WhatsAppRow>;
  gmail: (caller: ConnectionsCenterCaller) => Promise<GmailRow[]>;
  inboundEmail: (caller: ConnectionsCenterCaller) => Promise<{ enabled: boolean; addresses: InboundAddressRow[] }>;
};

/** Mirrors /api/taxes/authority/status: an unresolvable environment reads as SANDBOX. */
function authorityEnvironment(): BillingAuthorityEnvironment {
  try {
    return resolveRuntimeAuthorityEnvironment();
  } catch {
    return BillingAuthorityEnvironment.SANDBOX;
  }
}

export const defaultConnectionsCenterReaders: ConnectionsCenterReaders = {
  async acquisition({ businessId }) {
    const enabled = await runWithTenantContext({ businessId }, () => enabledSources(businessId));
    const connections = await tenantTx(businessId, (tx) =>
      tx.acquisitionConnection.findMany({
        where: { businessId },
        select: { id: true, sourceKey: true, status: true, label: true, lastEventAt: true, lastErrorCode: true },
        orderBy: { id: "asc" },
      })
    );
    return {
      enabled,
      connections,
      metaAvailable: isMetaLeadAdsConfigured(),
      wixAvailable: !!wixAppConfig() && !!wixInstallUrl(),
    };
  },

  async payments({ businessId }) {
    const connections = await tenantTx(businessId, (tx) =>
      tx.businessPaymentConnection.findMany({
        where: { businessId },
        select: { id: true, provider: true, isActive: true, updatedAt: true },
        orderBy: { id: "asc" },
      })
    );
    return { enabledProviders: listProviderDescriptors().map((d) => d.key), connections };
  },

  async authority(caller) {
    const outcome = await resolveAuthorityStatusRequest({
      actor: { id: caller.userId, businessId: caller.businessId },
      requestedBusinessId: null,
      environment: authorityEnvironment(),
      deps: { getActiveAuthorityApp, getAuthorityConnectionStatus, now: () => new Date() },
    });
    if (!outcome.ok) throw new Error("authority status refused for the caller's own business");
    return { status: outcome.dto.status, connectedAt: outcome.dto.connectedAt };
  },

  async whatsapp({ businessId }) {
    const c = await findPublicByBusinessId(businessId);
    return c ? { status: c.status, displayPhoneNumber: c.displayPhoneNumber, lastVerifiedAt: c.lastVerifiedAt } : null;
  },

  async gmail({ businessId }) {
    return tenantTx(businessId, (tx) =>
      tx.emailConnection.findMany({
        where: { businessId, provider: "gmail" },
        select: { id: true, emailAddress: true, status: true, lastSyncedAt: true },
        orderBy: { id: "desc" },
      })
    );
  },

  async inboundEmail({ businessId }) {
    if (!isInboundEmailEnabled()) return { enabled: false, addresses: [] };
    const addresses = await tenantTx(businessId, (tx) =>
      tx.inboundEmailAddress.findMany({
        where: { businessId, status: { in: ["ACTIVE", "RETIRING"] } },
        select: { status: true, lastReceivedAt: true },
      })
    );
    return { enabled: true, addresses };
  },
};

export async function loadConnectionsCenter(
  caller: ConnectionsCenterCaller,
  readers: ConnectionsCenterReaders = defaultConnectionsCenterReaders
): Promise<ConnectionsCenter> {
  const sources: Array<[ConnectionSourceId, () => Promise<ConnectionCard[]>]> = [
    ["gmail", async () => mapGmailCards(await readers.gmail(caller))],
    ["inbound_email", async () => mapInboundEmailCards(await readers.inboundEmail(caller))],
    ["acquisition", async () => mapAcquisitionCards(await readers.acquisition(caller))],
    ["payments", async () => mapPaymentCards(await readers.payments(caller))],
    ["whatsapp", async () => mapWhatsAppCards(await readers.whatsapp(caller))],
    ["authority", async () => mapAuthorityCards(await readers.authority(caller))],
  ];
  const results = await Promise.allSettled(sources.map(([, run]) => run()));

  const cards: ConnectionCard[] = [];
  const unavailable: ConnectionSourceId[] = [];
  results.forEach((result, i) => {
    const source = sources[i]![0];
    if (result.status === "fulfilled") {
      cards.push(...result.value);
      return;
    }
    const reason = result.reason;
    // Name only — a provider error message may carry configuration.
    console.error("CONNECTIONS_CENTER_SOURCE_ERROR:", source, reason instanceof Error ? reason.name : "UnknownError");
    unavailable.push(source);
    cards.push(...unavailableCards(source));
  });

  return assembleConnectionsCenter(cards, unavailable);
}
