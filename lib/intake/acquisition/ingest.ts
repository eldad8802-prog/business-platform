/**
 * M6 / M7-A — the one ingestion path every connection webhook uses (lead, commerce and telephony
 * sources alike), after it has authenticated the request and its trusted resolver has named the business:
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
import type { IntakeRegistry } from "@/lib/intake/core/registry";
import { runTenantJob } from "@/lib/tenant/job";
import { sourceGate, type ConnectionSourceKey } from "./gate";
import { touchConnection } from "./connection.service";
import { runWithTenantContext } from "@/lib/tenant/context";

export type IngestOutcome =
  /** `held` — L1.5-a: recorded under the platform's emergency switch; waits, unprocessed, until released. */
  | { status: "accepted"; businessId: number; newCount: number; replayCount: number; held?: true }
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
  sourceKey: ConnectionSourceKey;
  /** The trusted provider-side reference the resolver answered for (endpoint id / Page id). */
  accountRef: string;
  businessId: number;
  connectionId: number;
  /** decision 3 — what the v2 resolver found; PAUSED records the delivery and holds it (never processed while paused). */
  connectionStatus?: "ACTIVE" | "PAUSED" | "ERROR";
  receipts: IntakeReceiptDraft[];
  /** Tests: process inline instead of after the response. */
  processInline?: boolean;
  /** Lab only: a registry holding reference adapters. Production always uses the source registry. */
  registry?: IntakeRegistry;
}): Promise<IngestOutcome> {
  const registry = input.registry ?? intakeRegistry;
  const gate = await sourceGate(input.businessId, input.sourceKey);
  // L1.5-a — the emergency switch HOLDS (records, acknowledges, never processes until released); any other
  // refusal records nothing. The processor re-checks the gate before every attempt (holdUnlessAllowed), so a
  // held receipt — like one accepted just before the switch — waits instead of becoming a Lead.
  if (!gate.ok && !gate.holdable) {
    // L1.5-b · B1 — the log names why (e.g. "source_disabled:plan_excluded"); the outcome is unchanged: nothing recorded.
    const code = gate.reason === "source_disabled" ? `${gate.reason}:${gate.refusal}` : gate.reason;
    logIntake("refused", { businessId: input.businessId, sourceKey: input.sourceKey, code });
    return { status: "refused", reason: gate.reason };
  }
  const paused = input.connectionStatus === "PAUSED";
  const held = !gate.ok || paused;
  if (held) logIntake("held", { businessId: input.businessId, sourceKey: input.sourceKey, code: !gate.ok ? "emergency_disabled" : "connection_paused" });
  const accepted = await acceptIntake({
    registry,
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
    // Even a pure re-delivery drains: drainIntake also picks up this business's DUE retries, so any
    // inbound for a business is a recovery opportunity for its own stuck receipts (tenant-scoped).
    await runTenantJob({ businessId: accepted.businessId }, () =>
      drainIntake(registry, accepted.businessId, { eventIds })
    ).then(() => undefined, () => undefined);
  };
  if (input.processInline) await work();
  else await afterResponse(work);

  return {
    status: "accepted",
    businessId: accepted.businessId,
    newCount: eventIds.length,
    replayCount: accepted.recorded.length - eventIds.length,
    ...(held ? { held: true as const } : {}),
  };
}
