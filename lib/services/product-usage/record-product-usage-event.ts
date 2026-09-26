import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { PRODUCT_USAGE_SOURCES } from "./product-usage-catalog";
import type { RecordProductUsageEventInput } from "./product-usage.types";

const KILL_SWITCH_ENV = "PRODUCT_USAGE_TRACKING";

export function isProductUsageTrackingEnabled(): boolean {
  const raw = process.env[KILL_SWITCH_ENV]?.trim().toLowerCase();
  return raw !== "false";
}

export function readSessionIdFromRequest(req: Request): string | null {
  const value = req.headers.get("x-session-id")?.trim();
  return value || null;
}

function buildMetadata(
  metadata: Record<string, unknown> | null | undefined
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!metadata || Object.keys(metadata).length === 0) {
    return Prisma.JsonNull;
  }
  return {
    schemaVersion: 1,
    source: PRODUCT_USAGE_SOURCES.API,
    data: metadata,
  } as Prisma.InputJsonValue;
}

/**
 * Best-effort usage write — never throws to callers.
 */
export async function recordProductUsageEvent(
  input: RecordProductUsageEventInput
): Promise<void> {
  if (!isProductUsageTrackingEnabled()) {
    return;
  }

  try {
    // sec(C)/M-14(a): an attributed event is written inside its own tenant's
    // transaction (GUC set), so under the prepared FORCE RLS policy
    // (ops/security/sec-c-phase3-rls.sql) the runtime can only ever write events
    // for the business it is acting for. createMany, not create: the runtime holds
    // INSERT only on this table (no SELECT for INSERT ... RETURNING).
    const businessId = input.businessId ?? null;
    const write = (db: Pick<typeof prisma, "productUsageEvent">) =>
      db.productUsageEvent.createMany({
      data: {
        businessId,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        featureKey: input.featureKey,
        action: input.action,
        outcome: input.outcome ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        durationMs: input.durationMs ?? null,
        source: input.source ?? PRODUCT_USAGE_SOURCES.API,
        metadata: buildMetadata(input.metadata),
      },
    });
    if (businessId !== null && Number.isInteger(businessId) && businessId > 0) {
      await tenantTx(businessId, (tx) => write(tx));
    } else {
      await write(prisma);
    }
  } catch (error) {
    console.error("recordProductUsageEvent error:", error);
  }
}
