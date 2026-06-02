import { prisma } from "@/lib/prisma";
import {
  BUSINESS_DOC_BACKLOG_THRESHOLD,
  MAX_ATTENTION_ITEMS,
  PLATFORM_DOC_BACKLOG_THRESHOLD,
  PLATFORM_SYSTEM_BUSINESS_NAME,
} from "./constants";
import { getPlatformAdminOverview } from "./platform-overview.service";
import type {
  PlatformAdminAttentionResponse,
  PlatformAttentionItem,
  PlatformAttentionSeverity,
} from "./types";

const DOCUMENT_NEEDS_REVIEW_STATUS = "needs_review";

const SEVERITY_RANK: Record<PlatformAttentionSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  info: 3,
};

function sortAttentionItems(items: PlatformAttentionItem[]): PlatformAttentionItem[] {
  return [...items].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
}

function buildPlatformLevelItems(
  overview: Awaited<ReturnType<typeof getPlatformAdminOverview>>
): PlatformAttentionItem[] {
  const items: PlatformAttentionItem[] = [];

  if (overview.billing.pdfRenderFailed > 0) {
    items.push({
      id: "platform:billing-pdf-failed",
      severity: "critical",
      category: "billing",
      title: "כשלי רינדור PDF בחשבוניות",
      detail: `${overview.billing.pdfRenderFailed} מסמכים עם pdfRenderStatus=FAILED`,
    });
  }

  if (overview.documents.needsReview >= PLATFORM_DOC_BACKLOG_THRESHOLD) {
    items.push({
      id: "platform:documents-backlog",
      severity: "high",
      category: "documents",
      title: "עומס מסמכים לבדיקה",
      detail: `${overview.documents.needsReview} מסמכים במצב needs_review`,
    });
  }

  if (overview.content.runsFailedLast7d > 0) {
    items.push({
      id: "platform:content-runs-failed",
      severity: "high",
      category: "content",
      title: "ריצות תוכן שנכשלו",
      detail: `${overview.content.runsFailedLast7d} בשבוע האחרון (${overview.content.runsFailed} סה״כ)`,
    });
  }

  if (overview.integrations.whatsappImportsFailed > 0) {
    items.push({
      id: "platform:whatsapp-import-failed",
      severity: "high",
      category: "integrations",
      title: "כשלי ייבוא WhatsApp",
      detail: `${overview.integrations.whatsappImportsFailed} ייבואים במצב failed`,
    });
  }

  if (overview.billing.byStatus.PENDING_REVIEW >= 5) {
    items.push({
      id: "platform:billing-pending-review",
      severity: "medium",
      category: "billing",
      title: "חשבוניות ממתינות לבדיקה",
      detail: `${overview.billing.byStatus.PENDING_REVIEW} במצב PENDING_REVIEW`,
    });
  }

  const disconnectedGmail =
    overview.integrations.gmailConnections -
    overview.integrations.gmailConnected;
  if (disconnectedGmail > 0 && overview.integrations.gmailConnections > 0) {
    items.push({
      id: "platform:gmail-not-connected",
      severity: "medium",
      category: "integrations",
      title: "חיבורי Gmail לא פעילים",
      detail: `${disconnectedGmail} מתוך ${overview.integrations.gmailConnections} לא במצב connected`,
    });
  }

  return items;
}

async function buildPerBusinessItems(): Promise<PlatformAttentionItem[]> {
  const rows = await prisma.business.findMany({
    where: {
      name: { not: PLATFORM_SYSTEM_BUSINESS_NAME },
      documentsV2: {
        some: { status: DOCUMENT_NEEDS_REVIEW_STATUS },
      },
    },
    select: {
      id: true,
      name: true,
      _count: {
        select: {
          documentsV2: {
            where: { status: DOCUMENT_NEEDS_REVIEW_STATUS },
          },
        },
      },
    },
    take: 40,
  });

  return rows
    .filter((row) => row._count.documentsV2 >= BUSINESS_DOC_BACKLOG_THRESHOLD)
    .sort((a, b) => b._count.documentsV2 - a._count.documentsV2)
    .slice(0, 6)
    .map((row) => {
      const count = row._count.documentsV2;
      const severity: PlatformAttentionSeverity =
        count >= 10 ? "high" : "medium";
      return {
        id: `business:${row.id}:documents`,
        severity,
        category: "documents",
        title: `עסק ${row.name} — תור מסמכים`,
        detail: `${count} מסמכים ממתינים לבדיקה`,
        businessId: row.id,
        businessName: row.name,
      };
    });
}

export async function getPlatformAdminAttention(): Promise<PlatformAdminAttentionResponse> {
  const [overview, businessItems] = await Promise.all([
    getPlatformAdminOverview(),
    buildPerBusinessItems(),
  ]);

  const merged = sortAttentionItems([
    ...buildPlatformLevelItems(overview),
    ...businessItems,
  ]).slice(0, MAX_ATTENTION_ITEMS);

  return {
    generatedAt: new Date().toISOString(),
    items: merged,
  };
}
