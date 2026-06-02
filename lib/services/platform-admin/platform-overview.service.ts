import {
  BillingDocumentStatus,
  BillingPdfRenderStatus,
  ContentRunStatus,
  ConversationStatus,
  EmailConnectionStatus,
  WhatsAppAttachmentImportStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PLATFORM_SYSTEM_BUSINESS_NAME } from "./constants";
import type { PlatformAdminOverviewResponse } from "./types";

const DOCUMENT_NEEDS_REVIEW_STATUS = "needs_review";
const ACTIVE_RECENT_DAYS = 7;

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function countByBillingStatus(
  rows: Array<{ status: BillingDocumentStatus; _count: { _all: number } }>
): PlatformAdminOverviewResponse["billing"]["byStatus"] {
  const counts = {
    DRAFT: 0,
    PENDING_REVIEW: 0,
    ISSUED: 0,
  };

  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = row._count._all;
    }
  }

  return counts;
}

export async function getPlatformAdminOverview(): Promise<PlatformAdminOverviewResponse> {
  const activeRecentSince = daysAgo(ACTIVE_RECENT_DAYS);
  const runsFailedSince = daysAgo(ACTIVE_RECENT_DAYS);

  const businessWhere = {
    name: { not: PLATFORM_SYSTEM_BUSINESS_NAME },
  };

  const [
    businesses,
    users,
    billingByStatus,
    billingPdfFailed,
    documentsNeedsReview,
    contentRunsFailed,
    contentRunsFailedLast7d,
    conversationsTotal,
    conversationsOpen,
    conversationsActiveRecent,
    gmailConnections,
    gmailConnected,
    whatsappImportsFailed,
  ] = await Promise.all([
    prisma.business.count({ where: businessWhere }),
    prisma.user.count({
      where: {
        business: businessWhere,
      },
    }),
    prisma.billingDocument.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    prisma.billingDocument.count({
      where: { pdfRenderStatus: BillingPdfRenderStatus.FAILED },
    }),
    prisma.document.count({
      where: { status: DOCUMENT_NEEDS_REVIEW_STATUS },
    }),
    prisma.contentRun.count({
      where: { status: ContentRunStatus.FAILED },
    }),
    prisma.contentRun.count({
      where: {
        status: ContentRunStatus.FAILED,
        createdAt: { gte: runsFailedSince },
      },
    }),
    prisma.conversation.count(),
    prisma.conversation.count({
      where: { status: ConversationStatus.OPEN },
    }),
    prisma.conversation.count({
      where: { lastMessageAt: { gte: activeRecentSince } },
    }),
    prisma.emailConnection.count(),
    prisma.emailConnection.count({
      where: { status: EmailConnectionStatus.connected },
    }),
    prisma.whatsAppAttachmentImport.count({
      where: { status: WhatsAppAttachmentImportStatus.failed },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      businesses,
      users,
    },
    billing: {
      byStatus: countByBillingStatus(billingByStatus),
      pdfRenderFailed: billingPdfFailed,
    },
    documents: {
      needsReview: documentsNeedsReview,
    },
    content: {
      runsFailed: contentRunsFailed,
      runsFailedLast7d: contentRunsFailedLast7d,
    },
    conversations: {
      total: conversationsTotal,
      open: conversationsOpen,
      activeRecent: conversationsActiveRecent,
    },
    integrations: {
      gmailConnections,
      gmailConnected,
      whatsappImportsFailed,
    },
  };
}
