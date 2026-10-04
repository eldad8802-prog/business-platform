/**
 * M6 — the one ingestion path every acquisition webhook uses, after it has authenticated the
 * request and its trusted resolver has named the business:
 *
 *   gate (source enabled for the business, business active) → acceptIntake (durable receipts,
 *   deduped by provider id) → ACK → processing after the response (drainIntake: hydrate,
 *   normalize, M4 identity, routing, Lead, lifecycle) → the sweeper retries anything left.
 *
 * Durability contract (same as WhatsApp): the HTTP answer is 2xx ONLY after the receipts are
 * written; a database failure throws, the route answers 5xx, the provider redelivers, and the
 * unique (business, source, externalEventId) key makes the redelivery a no-op.
 */
import { after } from "next/server";
import type { IntakeReceiptDraft } from "@/lib/intake/core/contract";
import { acceptIntake, drainIntake } from "@/lib/intake/core/processor";
import { logIntake } from "@/lib/intake/core/observability";
import { intakeRegistry } from "@/lib/intake/sources";
import { runTenantJob } from "@/lib/tenant/job";
import { acquisitionGate, type AcquisitionSourceKey } from "./gate";
import { touchConnection } from "./connection.service";
import { runWithTenantContext } from "@/lib/tenant/context";

export type IngestOutcome =
  | { status: "accepted"; businessId: number; newCount: number; replayCount: number }
  | { status: "refused"; reason: "source_disabled" | "business_inactive" | "unknown_account" };

/** After the response when in a request; inline (awaited) outside one — the WhatsApp route's rule. */
function afterResponse(task: () => Promise<void>): Promise<void> | null {
  try {
    after(task);
    return null;
  } catch {
    return task();
  }
}

export async function ingestAcquisition(input: {
  sourceKey: AcquisitionSourceKey;
  /** The trusted provider-side reference the resolver answered for (endpoint id / Page id). */
  accountRef: string;
  businessId: number;
  connectionId: number;
  receipts: IntakeReceiptDraft[];
  /** Tests: process inline instead of after the response. */
  processInline?: boolean;
}): Promise<IngestOutcome> {
  const gate = await acquisitionGate(input.businessId, input.sourceKey);
  if (!gate.ok) {
    logIntake("refused", { businessId: input.businessId, sourceKey: input.sourceKey, code: gate.reason });
    return { status: "refused", reason: gate.reason };
  }
  const accepted = await acceptIntake({
    registry: intakeRegistry,
    sourceKey: input.sourceKey,
    accountRef: input.accountRef,
    receipts: input.receipts,
  });
  if (accepted.status !== "accepted") return { status: "refused", reason: "unknown_account" };
  // The resolver and acceptIntake must agree on the tenant; anything else is refused loudly.
  if (accepted.businessId !== input.businessId) throw new Error("acquisition: tenant mismatch between resolvers");

  await runWithTenantContext({ businessId: accepted.businessId }, () => touchConnection(input.connectionId)).catch(() => undefined);

  const eventIds = accepted.recorded.filter((r) => r.isNew).map((r) => r.id);
  const work = async () => {
    if (!eventIds.length) return;
    await runTenantJob({ businessId: accepted.businessId }, () =>
      drainIntake(intakeRegistry, accepted.businessId, { eventIds })
    ).then(() => undefined, () => undefined);
  };
  if (input.processInline) await work();
  else await afterResponse(work);

  return {
    status: "accepted",
    businessId: accepted.businessId,
    newCount: eventIds.length,
    replayCount: accepted.recorded.length - eventIds.length,
  };
}
