import { Prisma } from "@prisma/client";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const CONTENT_EVENT_VARIANT_SELECTED = "VARIANT_SELECTED";
export const CONTENT_EVENT_CONTENT_EDITED = "CONTENT_EDITED";

export type ContentDecisionEventType =
  | typeof CONTENT_EVENT_VARIANT_SELECTED
  | typeof CONTENT_EVENT_CONTENT_EDITED;

export class ContentDecisionNotFoundError extends Error {
  constructor() {
    super("Content run not found");
    this.name = "ContentDecisionNotFoundError";
  }
}

/** Decision evidence. The edited text stays in the operational response, not here. */
export function contentDecisionPayload(variantKey: string) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: "user" as const,
    data: { variantKey },
  };
}

function decisionKey(
  eventType: ContentDecisionEventType,
  contentRunId: number,
  contentVariantId: number
) {
  return `${eventType}:${contentRunId}:${contentVariantId}`;
}

export async function recordContentDecision(input: {
  businessId: number;
  actorUserId: number;
  contentRunId: number;
  variantKey: string;
  eventType: ContentDecisionEventType;
}): Promise<{ eventId: number; created: boolean; variantKey: string }> {
  const variantKey = input.variantKey.trim();
  if (!variantKey) throw new ContentDecisionNotFoundError();

  const variant = await tenantTx(input.businessId, (tx) =>
    tx.contentVariant.findFirst({
      where: {
        variantKey,
        businessId: input.businessId,
        contentRunId: input.contentRunId,
        contentRun: { businessId: input.businessId },
      },
      select: { id: true, variantKey: true, contentRunId: true, businessId: true },
    })
  );

  if (!variant || variant.businessId !== input.businessId) {
    throw new ContentDecisionNotFoundError();
  }

  const idempotencyKey = decisionKey(
    input.eventType,
    variant.contentRunId,
    variant.id
  );
  const payload = contentDecisionPayload(variant.variantKey);

  try {
    const created = await tenantTx(input.businessId, (tx) =>
      tx.contentEvent.create({
      data: {
        businessId: input.businessId,
        contentRunId: variant.contentRunId,
        contentVariantId: variant.id,
        actorUserId: input.actorUserId,
        eventType: input.eventType,
        idempotencyKey,
        payload,
      },
      select: { id: true },
    }));
    return { eventId: created.id, created: true, variantKey: variant.variantKey };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await tenantTx(input.businessId, (tx) =>
        tx.contentEvent.findFirst({
        where: { businessId: input.businessId, idempotencyKey },
        select: { id: true, contentVariantId: true, eventType: true },
      }));
      if (
        existing &&
        existing.contentVariantId === variant.id &&
        existing.eventType === input.eventType
      ) {
        return {
          eventId: existing.id,
          created: false,
          variantKey: variant.variantKey,
        };
      }
    }
    throw error;
  }
}
