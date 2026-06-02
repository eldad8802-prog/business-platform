import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
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
    await prisma.productUsageEvent.create({
      data: {
        businessId: input.businessId ?? null,
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
  } catch (error) {
    console.error("recordProductUsageEvent error:", error);
  }
}
