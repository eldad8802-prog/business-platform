/**
 * M7-A — the ONE authenticated delivery path for commerce / telephony providers. A provider route
 * (M7-B / M7-C) is a thin call into one of these; the lab drives them directly.
 *
 *   receiveSignedDelivery   publicId in the URL → the connection (definer lookup, ACTIVE only) →
 *                           its secret read and decrypted INSIDE that business's tenant context →
 *                           the provider's signature verified on the RAW body → parse → ingest.
 *   receiveKeyedDelivery    publicId + a shared key (sha256 match in the definer lookup; Voicenter
 *                           documents no signature) → parse → ingest.
 *
 * Tenant authority is ONLY the connection the lookup returned. A store / account / business id inside
 * the payload is never consulted for routing (an adapter may cross-check it and refuse a mismatch).
 *
 *   401  unknown / paused / revoked endpoint, wrong key, bad or stale signature (nothing recorded)
 *   400  authenticated but unparsable (nothing recorded)
 *   200  recorded — or a duplicate, or the source is OFF for the business (a decision, recorded nothing)
 *   503  rate-limited or the store is unavailable: the provider retries (Retry-After when known)
 *   413  too large
 */
import { checkRateLimit } from "@/lib/security/rate-limiter";
import type { IntakeReceiptDraft } from "@/lib/intake/core/contract";
import type { IntakeRegistry } from "@/lib/intake/core/registry";
import { runWithTenantContext } from "@/lib/tenant/context";
import { logIntake } from "@/lib/intake/core/observability";
import { ingestAcquisition, type IngestOutcome } from "./ingest";
import { readConnectionSecrets, type ConnectionSecrets, type SignedSourceKey } from "./connection.service";
import { resolveKeyedConnection, resolvePublicConnection } from "./resolve";
import { PUBLIC_ID_PATTERN } from "./keys";

export type DeliveryResponse = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

export type ParseResult = { ok: true; receipts: IntakeReceiptDraft[] } | { ok: false; code: string };

type Common = {
  raw: string;
  /** Turns the authenticated body into canonical receipts (the provider adapter's parser). */
  parse: (raw: string) => ParseResult;
  /** Lab only: reference adapters. Production uses the source registry. */
  registry?: IntakeRegistry;
  processInline?: boolean;
};

async function ingest(
  sourceKey: Parameters<typeof ingestAcquisition>[0]["sourceKey"],
  publicId: string,
  conn: { businessId: number; connectionId: number },
  parse: Common["parse"],
  raw: string,
  extra: Pick<Common, "registry" | "processInline">
): Promise<DeliveryResponse & { outcome?: IngestOutcome }> {
  const parsed = parse(raw);
  if (!parsed.ok) return { status: 400, body: { error: "malformed", code: parsed.code } };
  const limit = await checkRateLimit({ bucket: "ACQUISITION_INTAKE", business: conn.businessId });
  if (!limit.allowed && limit.outcome === "rate_limited") {
    // 5xx so the provider redelivers (several providers never retry a 4xx).
    return { status: 503, body: { error: "rate_limited" }, headers: { "retry-after": String(limit.retryAfterSeconds) } };
  }
  try {
    const outcome = await ingestAcquisition({
      sourceKey,
      accountRef: publicId,
      businessId: conn.businessId,
      connectionId: conn.connectionId,
      receipts: parsed.receipts,
      ...(extra.registry ? { registry: extra.registry } : {}),
      ...(extra.processInline ? { processInline: true } : {}),
    });
    return { status: 200, body: {}, outcome };
  } catch {
    return { status: 503, body: { error: "unavailable" } };
  }
}

export async function receiveSignedDelivery(
  input: Common & {
    sourceKey: Exclude<SignedSourceKey, "commerce.wix">;
    publicId: string;
    /** The provider's signature check against this connection's secrets (pure; constant time). */
    verify: (secrets: ConnectionSecrets) => boolean;
  }
): Promise<DeliveryResponse & { outcome?: IngestOutcome }> {
  if (!PUBLIC_ID_PATTERN.test(input.publicId)) return { status: 401, body: { error: "unauthorized" } };
  let conn;
  try {
    conn = await resolvePublicConnection(input.sourceKey, input.publicId);
  } catch {
    return { status: 503, body: { error: "unavailable" } };
  }
  if (!conn) return { status: 401, body: { error: "unauthorized" } };
  let secrets: ConnectionSecrets | null;
  try {
    secrets = await runWithTenantContext({ businessId: conn.businessId }, () => readConnectionSecrets(conn.businessId, conn.connectionId));
  } catch {
    return { status: 503, body: { error: "unavailable" } };
  }
  if (!secrets || !input.verify(secrets)) {
    logIntake("refused", { businessId: conn.businessId, sourceKey: input.sourceKey, code: "invalid_signature" });
    return { status: 401, body: { error: "invalid_signature" } };
  }
  return ingest(input.sourceKey, input.publicId, conn, input.parse, input.raw, input);
}

export async function receiveKeyedDelivery(
  input: Common & { sourceKey: "telephony.voicenter"; publicId: string; key: string }
): Promise<DeliveryResponse & { outcome?: IngestOutcome }> {
  let conn;
  try {
    conn = await resolveKeyedConnection(input.sourceKey, input.publicId, input.key);
  } catch {
    return { status: 503, body: { error: "unavailable" } };
  }
  if (!conn) return { status: 401, body: { error: "unauthorized" } };
  return ingest(input.sourceKey, input.publicId, conn, input.parse, input.raw, input);
}
