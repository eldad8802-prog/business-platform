import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/errors";
import {
  formatActorDisplay,
  formatAuditActionLabel,
  formatAuditActionTone,
  formatAuditDetail,
  formatAuditTargetDisplay,
  shortenUserAgent,
} from "./platform-audit-format";
import type {
  PlatformAdminAuditResponse,
  PlatformAuditListItem,
} from "./platform-audit-list.types";

export type ListPlatformAuditInput = {
  page: number;
  limit: number;
  action?: string;
  actorUserId?: number;
};

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

export function parseListPlatformAuditQuery(
  searchParams: URLSearchParams
): ListPlatformAuditInput {
  const pageParam = searchParams.get("page") ?? "1";
  const limitParam = searchParams.get("limit") ?? "30";
  const page = Number(pageParam);
  const limit = Number(limitParam);

  if (Number.isNaN(page) || page < 1) {
    throw new ValidationError("page must be a positive number");
  }
  if (Number.isNaN(limit) || limit < 1 || limit > 100) {
    throw new ValidationError("limit must be a number between 1 and 100");
  }

  const actionRaw = searchParams.get("action")?.trim();
  const action =
    actionRaw && actionRaw.length > 0 && actionRaw.length <= 128
      ? actionRaw
      : undefined;

  let actorUserId: number | undefined;
  const actorParam = searchParams.get("actorUserId");
  if (actorParam !== null && actorParam !== "") {
    const parsed = Number(actorParam);
    if (Number.isNaN(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
      throw new ValidationError("actorUserId must be a positive integer");
    }
    actorUserId = parsed;
  }

  return { page, limit, action, actorUserId };
}

function buildWhere(input: ListPlatformAuditInput): Prisma.PlatformAuditEventWhereInput {
  const where: Prisma.PlatformAuditEventWhereInput = {};
  if (input.action) {
    where.action = input.action;
  }
  if (input.actorUserId) {
    where.actorUserId = input.actorUserId;
  }
  return where;
}

async function getAuditSummary(): Promise<PlatformAdminAuditResponse["summary"]> {
  const since24h = daysAgo(1);
  const since7d = daysAgo(7);

  const [events24h, uniqueAdmins, actionGroups] = await Promise.all([
    prisma.platformAuditEvent.count({
      where: { createdAt: { gte: since24h } },
    }),
    prisma.platformAuditEvent.findMany({
      where: {
        createdAt: { gte: since7d },
        actorUserId: { not: null },
      },
      distinct: ["actorUserId"],
      select: { actorUserId: true },
    }),
    prisma.platformAuditEvent.groupBy({
      by: ["action"],
      where: { createdAt: { gte: since7d } },
      _count: { _all: true },
    }),
  ]);

  const top = [...actionGroups].sort(
    (a, b) => b._count._all - a._count._all
  )[0];
  const mostCommonAction = top
    ? {
        action: top.action,
        actionLabel: formatAuditActionLabel(top.action),
        count: top._count._all,
      }
    : null;

  return {
    events24h,
    uniqueAdmins7d: uniqueAdmins.length,
    mostCommonAction,
  };
}

type AuditEventRow = {
  id: number;
  createdAt: Date;
  actorUserId: number | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  ip: string | null;
  userAgent: string | null;
  actorUser: { email: string; name: string | null } | null;
};

function mapRow(row: AuditEventRow): PlatformAuditListItem {
  const email = row.actorUser?.email ?? null;
  const name = row.actorUser?.name ?? null;
  const actorId = row.actorUserId;

  return {
    id: row.id,
    timestamp: row.createdAt.toISOString(),
    actor: {
      id: actorId,
      email,
      name,
      display: formatActorDisplay({ email, name, id: actorId }),
    },
    action: row.action,
    actionLabel: formatAuditActionLabel(row.action),
    tone: formatAuditActionTone(row.action),
    target: {
      type: row.targetType,
      id: row.targetId,
      display: formatAuditTargetDisplay(row.targetType, row.targetId),
    },
    detail: formatAuditDetail(row.action, row.metadata),
    ip: row.ip,
    userAgentShort: shortenUserAgent(row.userAgent),
  };
}

export async function listPlatformAuditEvents(
  input: ListPlatformAuditInput
): Promise<PlatformAdminAuditResponse> {
  const where = buildWhere(input);
  const skip = (input.page - 1) * input.limit;

  const [summary, rows, total] = await Promise.all([
    getAuditSummary(),
    prisma.platformAuditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: input.limit,
      select: {
        id: true,
        createdAt: true,
        actorUserId: true,
        action: true,
        targetType: true,
        targetId: true,
        metadata: true,
        ip: true,
        userAgent: true,
        actorUser: {
          select: { email: true, name: true },
        },
      },
    }),
    prisma.platformAuditEvent.count({ where }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    summary,
    items: rows.map(mapRow),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit) || 0,
    },
  };
}
