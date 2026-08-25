import {
  BillingDocumentStatus,
  BillingPdfRenderStatus,
  ContentRunStatus,
  ConversationStatus,
  EmailConnectionStatus,
  WhatsAppAttachmentImportStatus,
} from "@prisma/client";
import { getPrismaAdmin } from "@/lib/prisma-admin";
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
    getPrismaAdmin().business.count({ where: businessWhere }),
    getPrismaAdmin().user.count({
      where: {
        business: businessWhere,
      },
    }),
    getPrismaAdmin().billingDocument.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    getPrismaAdmin().billingDocument.count({
      where: { pdfRenderStatus: BillingPdfRenderStatus.FAILED },
    }),
    getPrismaAdmin().document.count({
      where: { status: DOCUMENT_NEEDS_REVIEW_STATUS },
    }),
    getPrismaAdmin().contentRun.count({
      where: { status: ContentRunStatus.FAILED },
    }),
    getPrismaAdmin().contentRun.count({
      where: {
        status: ContentRunStatus.FAILED,
        createdAt: { gte: runsFailedSince },
      },
    }),
    getPrismaAdmin().conversation.count(),
    getPrismaAdmin().conversation.count({
      where: { status: ConversationStatus.OPEN },
    }),
    getPrismaAdmin().conversation.count({
      where: { lastMessageAt: { gte: activeRecentSince } },
    }),
    getPrismaAdmin().emailConnection.count(),
    getPrismaAdmin().emailConnection.count({
      where: { status: EmailConnectionStatus.connected },
    }),
    getPrismaAdmin().whatsAppAttachmentImport.count({
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
