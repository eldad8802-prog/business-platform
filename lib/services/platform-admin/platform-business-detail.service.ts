import {
  BillingDocumentStatus,
  BillingPdfRenderStatus,
  ConversationStatus,
  EmailConnectionStatus,
  WhatsAppAttachmentImportStatus,
} from "@prisma/client";
import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { PRODUCT_USAGE_FEATURES } from "@/lib/services/product-usage/product-usage-catalog";
import { PLATFORM_SYSTEM_BUSINESS_NAME } from "./constants";
import type {
  BusinessAttentionSignal,
  BusinessOperationalStatus,
  PlatformAdminBusinessDetailResponse,
} from "./platform-business-detail.types";

const WINDOW_DAYS = 7;
const INACTIVE_DAYS = 14;
const DOCUMENT_NEEDS_REVIEW = "needs_review";
const STUCK_DOC_DAYS = 7;

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function maxDate(dates: (Date | null | undefined)[]): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date);
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

function statusLabel(status: BusinessOperationalStatus): string {
  switch (status) {
    case "healthy":
      return "תקין";
    case "attention_needed":
      return "דורש תשומת לב";
    case "struggling":
      return "במצוקה תפעולית";
    case "inactive":
      return "לא פעיל";
  }
}

function computeOperationalStatus(input: {
  lastActivityAt: Date | null;
  attentionCount: number;
  severeIssues: boolean;
}): BusinessOperationalStatus {
  const inactiveSince = daysAgo(INACTIVE_DAYS);
  if (!input.lastActivityAt || input.lastActivityAt < inactiveSince) {
    return "inactive";
  }
  if (input.severeIssues || input.attentionCount >= 3) {
    return "struggling";
  }
  if (input.attentionCount > 0) {
    return "attention_needed";
  }
  return "healthy";
}

function buildAttentionSignals(input: {
  pdfFailures: number;
  needsReview: number;
  stuckNeedsReview: number;
  pendingReview: number;
  waitingForReply: number;
  whatsappFailures: number;
  gmailConnected: boolean;
  usersCount: number;
  logins7d: number;
  hasProfile: boolean;
}): BusinessAttentionSignal[] {
  const items: BusinessAttentionSignal[] = [];

  if (input.pdfFailures > 0) {
    items.push({
      id: "billing-pdf-failed",
      severity: "critical",
      category: "billing",
      title: "כשלי PDF בחשבוניות",
      detail: `${input.pdfFailures} מסמכים`,
    });
  }
  if (input.needsReview >= 3) {
    items.push({
      id: "documents-backlog",
      severity: "high",
      category: "documents",
      title: "תור מסמכים לבדיקה",
      detail: `${input.needsReview} במצב needs_review`,
    });
  }
  if (input.stuckNeedsReview > 0) {
    items.push({
      id: "documents-stuck",
      severity: "medium",
      category: "documents",
      title: "מסמכים תקועים בבדיקה",
      detail: `${input.stuckNeedsReview} מעל ${STUCK_DOC_DAYS} ימים`,
    });
  }
  if (input.pendingReview > 0) {
    items.push({
      id: "billing-pending",
      severity: "medium",
      category: "billing",
      title: "חשבוניות ממתינות לבדיקה",
      detail: `${input.pendingReview} במצב PENDING_REVIEW`,
    });
  }
  if (input.waitingForReply > 0) {
    items.push({
      id: "inbox-waiting",
      severity: "high",
      category: "inbox",
      title: "שיחות ממתינות לתשובה",
      detail: `${input.waitingForReply} שיחות עם inbound ללא מענה`,
    });
  }
  if (input.whatsappFailures > 0) {
    items.push({
      id: "whatsapp-failed",
      severity: "high",
      category: "integrations",
      title: "כשלי ייבוא WhatsApp",
      detail: `${input.whatsappFailures} ייבואים`,
    });
  }
  if (!input.gmailConnected) {
    items.push({
      id: "gmail-missing",
      severity: "info",
      category: "integrations",
      title: "Gmail לא מחובר",
    });
  }
  if (!input.hasProfile) {
    items.push({
      id: "onboarding-profile",
      severity: "info",
      category: "onboarding",
      title: "פרופיל עסק לא הושלם",
    });
  }
  if (input.usersCount > 0 && input.logins7d === 0) {
    items.push({
      id: "no-logins",
      severity: "medium",
      category: "usage",
      title: "אין התחברויות בשבוע האחרון",
    });
  }

  const rank = { critical: 0, high: 1, medium: 2, info: 3 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 10);
}

export async function getPlatformAdminBusinessDetail(
  businessId: number
): Promise<PlatformAdminBusinessDetailResponse> {
  if (!businessId || Number.isNaN(businessId)) {
    throw new NotFoundError("Business not found");
  }

  const since7d = daysAgo(WINDOW_DAYS);
  const stuckBefore = daysAgo(STUCK_DOC_DAYS);

  const business = await prisma.business.findFirst({
    where: {
      id: businessId,
      name: { not: PLATFORM_SYSTEM_BUSINESS_NAME },
    },
    select: {
      id: true,
      name: true,
      createdAt: true,
      archivedAt: true,
      archivedByUserId: true,
      profile: { select: { id: true } },
      users: {
        select: {
          id: true,
          lastLoginAt: true,
        },
      },
      _count: {
        select: {
          users: true,
          documentsV2: true,
        },
      },
    },
  });

  if (!business) {
    throw new NotFoundError("Business not found");
  }

  const [
    docsNeedsReview,
    docsStuck,
    recentDocs,
    billingGroups,
    billingPdfFailed,
    convOpen,
    convWaiting,
    lastMessage,
    emailConn,
    whatsappFailed,
    lastUsageEvent,
    usageGroups,
    loginEvents7d,
    usageUsers7d,
  ] = await Promise.all([
    prisma.document.count({
      where: { businessId, status: DOCUMENT_NEEDS_REVIEW },
    }),
    prisma.document.count({
      where: {
        businessId,
        status: DOCUMENT_NEEDS_REVIEW,
        createdAt: { lt: stuckBefore },
      },
    }),
    prisma.document.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, createdAt: true, status: true, source: true },
    }),
    prisma.billingDocument.groupBy({
      by: ["status"],
      where: { businessId },
      _count: { _all: true },
    }),
    prisma.billingDocument.count({
      where: {
        businessId,
        pdfRenderStatus: BillingPdfRenderStatus.FAILED,
      },
    }),
    prisma.conversation.count({
      where: { businessId, status: ConversationStatus.OPEN },
    }),
    prisma.conversation.count({
      where: {
        businessId,
        status: ConversationStatus.OPEN,
        unansweredInboundCount: { gte: 1 },
      },
    }),
    prisma.conversation.aggregate({
      where: { businessId },
      _max: { lastMessageAt: true },
    }),
    prisma.emailConnection.findFirst({
      where: { businessId },
      orderBy: { lastSyncedAt: "desc" },
      select: {
        status: true,
        emailAddress: true,
        lastSyncedAt: true,
      },
    }),
    prisma.whatsAppAttachmentImport.count({
      where: {
        businessId,
        status: WhatsAppAttachmentImportStatus.failed,
      },
    }),
    prisma.productUsageEvent.findFirst({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.productUsageEvent.groupBy({
      by: ["featureKey", "action"],
      where: {
        businessId,
        createdAt: { gte: since7d },
        featureKey: { not: PRODUCT_USAGE_FEATURES.AUTH_LOGIN },
      },
      _count: { _all: true },
    }),
    prisma.productUsageEvent.count({
      where: {
        businessId,
        featureKey: PRODUCT_USAGE_FEATURES.AUTH_LOGIN,
        action: "completed",
        createdAt: { gte: since7d },
      },
    }),
    prisma.productUsageEvent.findMany({
      where: {
        businessId,
        userId: { not: null },
        createdAt: { gte: since7d },
      },
      distinct: ["userId"],
      select: { userId: true },
    }),
  ]);

  const billingCounts = {
    drafts: 0,
    pendingReview: 0,
    issued: 0,
  };
  for (const row of billingGroups) {
    if (row.status === BillingDocumentStatus.DRAFT) {
      billingCounts.drafts = row._count._all;
    } else if (row.status === BillingDocumentStatus.PENDING_REVIEW) {
      billingCounts.pendingReview = row._count._all;
    } else if (row.status === BillingDocumentStatus.ISSUED) {
      billingCounts.issued = row._count._all;
    }
  }

  const featureMap = new Map<
    string,
    { opened: number; completed: number; failed: number }
  >();
  for (const row of usageGroups) {
    const entry = featureMap.get(row.featureKey) ?? {
      opened: 0,
      completed: 0,
      failed: 0,
    };
    if (row.action === "opened") entry.opened += row._count._all;
    else if (row.action === "completed") entry.completed += row._count._all;
    else if (row.action === "failed") entry.failed += row._count._all;
    featureMap.set(row.featureKey, entry);
  }

  let topFeature: { featureKey: string; total: number } | null = null;
  let frictionFeature: {
    featureKey: string;
    completionRate: number;
    opened: number;
  } | null = null;
  let lowestCompletion = 1;

  for (const [featureKey, counts] of featureMap.entries()) {
    const total = counts.opened + counts.completed + counts.failed;
    if (!topFeature || total > topFeature.total) {
      topFeature = { featureKey, total };
    }
    if (counts.opened >= 3) {
      const rate = counts.completed / counts.opened;
      if (rate < lowestCompletion) {
        lowestCompletion = rate;
        frictionFeature = {
          featureKey,
          completionRate: Math.round(rate * 1000) / 1000,
          opened: counts.opened,
        };
      }
    }
  }
  if (frictionFeature && lowestCompletion >= 0.5) {
    frictionFeature = null;
  }

  const lastUserLogin = maxDate(business.users.map((u) => u.lastLoginAt));
  const lastActivityAt = maxDate([
    lastUserLogin,
    lastUsageEvent?.createdAt,
    lastMessage._max.lastMessageAt,
    recentDocs[0]?.createdAt,
  ]);

  const gmailConnected =
    emailConn?.status === EmailConnectionStatus.connected;

  const attentionSignals = buildAttentionSignals({
    pdfFailures: billingPdfFailed,
    needsReview: docsNeedsReview,
    stuckNeedsReview: docsStuck,
    pendingReview: billingCounts.pendingReview,
    waitingForReply: convWaiting,
    whatsappFailures: whatsappFailed,
    gmailConnected,
    usersCount: business._count.users,
    logins7d: loginEvents7d,
    hasProfile: Boolean(business.profile),
  });

  const severeIssues =
    billingPdfFailed > 0 || docsNeedsReview >= 5 || convWaiting >= 3;

  const operationalStatus = computeOperationalStatus({
    lastActivityAt,
    attentionCount: attentionSignals.length,
    severeIssues,
  });

  return {
    generatedAt: new Date().toISOString(),
    business: {
      id: business.id,
      name: business.name,
      createdAt: business.createdAt.toISOString(),
      archivedAt: business.archivedAt?.toISOString() ?? null,
      archivedByUserId: business.archivedByUserId,
      usersCount: business._count.users,
      lastActivityAt: lastActivityAt?.toISOString() ?? null,
      operationalStatus,
      operationalStatusLabel: statusLabel(operationalStatus),
    },
    usage: {
      windowDays: WINDOW_DAYS,
      logins7d: loginEvents7d,
      activeUsers7d: usageUsers7d.length,
      topFeature,
      frictionFeature,
    },
    documents: {
      total: business._count.documentsV2,
      needsReview: docsNeedsReview,
      stuckNeedsReview: docsStuck,
      recentUploads: recentDocs.map((d) => ({
        id: d.id,
        createdAt: d.createdAt.toISOString(),
        status: d.status,
        source: d.source,
      })),
    },
    billing: {
      ...billingCounts,
      pdfFailures: billingPdfFailed,
    },
    conversations: {
      open: convOpen,
      waitingForReply: convWaiting,
      lastMessageAt: lastMessage._max.lastMessageAt?.toISOString() ?? null,
    },
    integrations: {
      gmailConnected,
      gmailEmail: emailConn?.emailAddress ?? null,
      gmailLastSyncedAt: emailConn?.lastSyncedAt?.toISOString() ?? null,
      whatsappImportFailures: whatsappFailed,
    },
    attentionSignals,
  };
}
