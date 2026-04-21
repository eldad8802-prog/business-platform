import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

type AuditLogInput = {
  businessId: number;
  eventType: string;
  entityType: string;
  entityId?: number | null;
  payload?: Record<string, unknown> | null;
};

export async function logAuditEvent(input: AuditLogInput) {
  const { businessId, eventType, entityType, entityId, payload } = input;

  if (!businessId || Number.isNaN(businessId)) {
    return;
  }

  try {
    await prisma.learningEvent.create({
      data: {
        businessId,
        eventType,
        entityType,
        entityId: entityId ?? null,
        payload: payload
          ? (payload as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  } catch (error) {
    console.error("logAuditEvent error:", error);
  }
}