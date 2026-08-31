import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/security/rate-limit";
import {
  PLATFORM_ADMIN_AREA_ENTERED_THROTTLE_MINUTES,
  PLATFORM_AUDIT_ACTIONS,
} from "./constants";

type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

export type LogPlatformAuditEventInput = {
  actorUserId?: number | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  req?: Request;
  ip?: string | null;
  userAgent?: string | null;
};

function readUserAgent(req: Request): string | null {
  const value = req.headers.get("user-agent")?.trim();
  return value || null;
}

export async function createPlatformAuditEventTx(
  tx: PrismaTx,
  input: LogPlatformAuditEventInput
): Promise<void> {
  const ip =
    input.ip ?? (input.req ? getClientIp(input.req) : null);
  const userAgent =
    input.userAgent ?? (input.req ? readUserAgent(input.req) : null);

  // D2/PW-2: createMany, not create. Prisma’s create emits INSERT ... RETURNING,
  // which requires SELECT privilege on the table. The audit trail is append-only,
  // and the control-plane role must hold INSERT and nothing else on it, so the
  // append deliberately returns nothing.
  await tx.platformAuditEvent.createMany({
    data: {
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata
        ? (input.metadata as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      ip: ip === "unknown" ? null : ip,
      userAgent,
    },
  });
}

/**
 * Best-effort platform audit write — never throws to callers.
 *
 * D2/P7-W2-GATE migration ratchet: migrated admin routes pass the sanctioned
 * admin client (`{ db: getPrismaAdmin() }`) so the append runs as the admin
 * role; not-yet-migrated routes still default to the tenant singleton. The
 * default is removed as the remaining admin routes migrate — never add new
 * callers relying on it.
 */
export async function logPlatformAuditEvent(
  input: LogPlatformAuditEventInput,
  options?: { db?: PrismaTx }
): Promise<void> {
  try {
    await createPlatformAuditEventTx(options?.db ?? prisma, input);
  } catch (error) {
    console.error("logPlatformAuditEvent error:", error);
  }
}

/**
 * Records admin area entry at most once per throttle window per actor.
 * Best-effort — never throws; session/auth must not depend on this.
 */
export async function logPlatformAdminAreaEnteredIfDue(
  actorUserId: number,
  req?: Request
): Promise<void> {
  try {
    const since = new Date(
      Date.now() - PLATFORM_ADMIN_AREA_ENTERED_THROTTLE_MINUTES * 60 * 1000
    );

    const recent = await prisma.platformAuditEvent.findFirst({
      where: {
        actorUserId,
        action: PLATFORM_AUDIT_ACTIONS.AREA_ENTERED,
        createdAt: { gte: since },
      },
      select: { id: true },
    });

    if (recent) {
      return;
    }

    await logPlatformAuditEvent({
      actorUserId,
      action: PLATFORM_AUDIT_ACTIONS.AREA_ENTERED,
      targetType: "SYSTEM",
      req,
    });
  } catch (error) {
    console.error("logPlatformAdminAreaEnteredIfDue error:", error);
  }
}
