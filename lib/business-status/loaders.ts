import {
  BillingDocumentStatus,
  BillingPdfRenderStatus,
  MessageDirection,
  MessageSenderType,
  Prisma,
  ReplySuggestionStatus,
  SupplierPurchaseDraftStatus,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4B: reads of FORCE-RLS'd tables run on a short tenant transaction
// when a tenant context is established (the business-status route always
// sets one); outside a context they read directly (legacy/tests).
async function dbStep<T>(
  fn: (db: Prisma.TransactionClient | typeof prisma) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx));
  }
  return fn(prisma);
}

import {
  BS_ATTENTION_PENDING_SUGGESTION_CAP,
  BS_ATTENTION_WAITING_CAP,
  BS_BILLING_PDF_FAILED_CAP,
  BS_BILLING_PENDING_CAP,
  BS_DOCUMENTS_CAP,
  BS_INVENTORY_CAP,
  BS_OPEN_CONVERSATION_SCAN_CAP,
  BS_SUPPLIER_CAP,
} from "./limits";

const SNIPPET_MAX = 140;

const PENDING_SUGGESTION_STATUSES: ReplySuggestionStatus[] = [
  "GENERATED",
  "SHOWN",
  "SELECTED",
];

export type AttentionWaitingRaw = {
  conversationId: number;
  customerName: string | null;
  channel: string;
  snippet: string | null;
  relevantAt: Date;
  conversationCreatedAt: Date;
  hasPendingSuggestion: boolean;
};

export type AttentionPendingSuggestionRaw = {
  conversationId: number;
  customerName: string | null;
  channel: string;
  suggestionSnippet: string | null;
  relevantAt: Date;
  conversationCreatedAt: Date;
};

export type DocumentNeedsReviewRaw = {
  id: number;
  createdAt: Date;
  source: string;
  vendorName: string | null;
  amount: number | null;
  confidenceScore: number | null;
};

export type InventoryAlertRaw = {
  id: number;
  type: string;
  message: string | null;
  createdAt: Date;
  itemId: number | null;
  itemName: string | null;
};

export type BillingDocRaw = {
  id: number;
  status: BillingDocumentStatus;
  customerNameSnapshot: string | null;
  totalAmount: Prisma.Decimal;
  currency: string;
  createdAt: Date;
  pdfRenderStatus: BillingPdfRenderStatus;
  pdfRenderError: string | null;
  documentNumberFormatted: string | null;
};

export type SupplierDraftRaw = {
  id: number;
  createdAt: Date;
  supplierName: string | null;
  externalOrderId: string | null;
  lineCount: number;
};

function truncateSnippet(text: string | null | undefined): string | null {
  if (text == null) return null;
  const t = text.trim();
  if (!t) return null;
  if (t.length <= SNIPPET_MAX) return t;
  return `${t.slice(0, SNIPPET_MAX - 1)}…`;
}

function pickLatestMessagePerConversation<
  T extends { conversationId: number; createdAt: Date },
>(rows: T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const row of rows) {
    if (!map.has(row.conversationId)) {
      map.set(row.conversationId, row);
    }
  }
  return map;
}

export async function loadAttentionWaiting(
  businessId: number
): Promise<AttentionWaitingRaw[]> {
  const openRows = await prisma.conversation.findMany({
    where: { businessId, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    take: BS_OPEN_CONVERSATION_SCAN_CAP,
    select: {
      id: true,
      channel: true,
      createdAt: true,
      customer: { select: { name: true } },
    },
  });

  const openIds = openRows.map((c) => c.id);
  const convById = new Map(openRows.map((c) => [c.id, c]));

  if (openIds.length === 0) return [];

  const recentMessages = await dbStep((db) => db.message.findMany({
    where: { businessId, conversationId: { in: openIds } },
    orderBy: { createdAt: "desc" },
    select: {
      conversationId: true,
      direction: true,
      senderType: true,
      contentText: true,
      createdAt: true,
    },
  }));

  const lastByConv = pickLatestMessagePerConversation(recentMessages);

  const candidates: Array<{
    conversationId: number;
    relevantAt: Date;
    snippet: string | null;
  }> = [];

  for (const [, msg] of lastByConv) {
    if (
      msg.direction === MessageDirection.INBOUND &&
      msg.senderType === MessageSenderType.CUSTOMER
    ) {
      candidates.push({
        conversationId: msg.conversationId,
        relevantAt: msg.createdAt,
        snippet: truncateSnippet(msg.contentText),
      });
    }
  }

  candidates.sort((a, b) => b.relevantAt.getTime() - a.relevantAt.getTime());
  const picked = candidates.slice(0, BS_ATTENTION_WAITING_CAP);
  const waitingConvIds = picked.map((c) => c.conversationId);

  let withSuggestion = new Set<number>();
  if (waitingConvIds.length > 0) {
    const suggestionRows = await dbStep((db) => db.replySuggestion.findMany({
      where: {
        businessId,
        conversationId: { in: waitingConvIds },
        status: { in: PENDING_SUGGESTION_STATUSES },
      },
      select: { conversationId: true },
    }));
    withSuggestion = new Set(suggestionRows.map((r) => r.conversationId));
  }

  const out: AttentionWaitingRaw[] = [];
  for (const c of picked) {
    const conv = convById.get(c.conversationId);
    if (!conv) continue;
    const name = conv.customer?.name?.trim() || null;
    out.push({
      conversationId: c.conversationId,
      customerName: name && name !== "" ? name : null,
      channel: conv.channel,
      snippet: c.snippet,
      relevantAt: c.relevantAt,
      conversationCreatedAt: conv.createdAt,
      hasPendingSuggestion: withSuggestion.has(c.conversationId),
    });
  }
  return out;
}

export async function loadAttentionPendingSuggestions(
  businessId: number,
  excludeConversationIds: Set<number>
): Promise<AttentionPendingSuggestionRaw[]> {
  const openRows = await prisma.conversation.findMany({
    where: { businessId, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    take: BS_OPEN_CONVERSATION_SCAN_CAP,
    select: { id: true },
  });
  const openIds = openRows.map((r) => r.id);
  if (openIds.length === 0) return [];

  const pendingSuggestions = await dbStep((db) => db.replySuggestion.findMany({
    where: {
      businessId,
      conversationId: { in: openIds },
      status: { in: PENDING_SUGGESTION_STATUSES },
    },
    orderBy: { createdAt: "desc" },
    select: {
      conversationId: true,
      text: true,
      createdAt: true,
    },
  }));

  const seenConv = new Set<number>();
  const picked: typeof pendingSuggestions = [];
  for (const s of pendingSuggestions) {
    if (excludeConversationIds.has(s.conversationId)) continue;
    if (seenConv.has(s.conversationId)) continue;
    seenConv.add(s.conversationId);
    picked.push(s);
    if (picked.length >= BS_ATTENTION_PENDING_SUGGESTION_CAP) break;
  }

  const convIdsNeeded = [...new Set(picked.map((s) => s.conversationId))];
  if (convIdsNeeded.length === 0) return [];

  const convRows = await prisma.conversation.findMany({
    where: {
      id: { in: convIdsNeeded },
      businessId,
      status: "OPEN",
    },
    select: {
      id: true,
      channel: true,
      createdAt: true,
      customer: { select: { name: true } },
    },
  });
  const convMap = new Map(convRows.map((c) => [c.id, c]));

  const out: AttentionPendingSuggestionRaw[] = [];
  for (const s of picked) {
    const conv = convMap.get(s.conversationId);
    if (!conv) continue;
    const name = conv.customer?.name?.trim() || null;
    out.push({
      conversationId: s.conversationId,
      customerName: name && name !== "" ? name : null,
      channel: conv.channel,
      suggestionSnippet: truncateSnippet(s.text),
      relevantAt: s.createdAt,
      conversationCreatedAt: conv.createdAt,
    });
  }
  return out;
}

export async function loadDocumentsNeedsReview(
  businessId: number
): Promise<DocumentNeedsReviewRaw[]> {
  const docs = await prisma.document.findMany({
    where: {
      businessId,
      status: "needs_review",
    },
    orderBy: { createdAt: "desc" },
    take: BS_DOCUMENTS_CAP,
    select: {
      id: true,
      createdAt: true,
      source: true,
      extractedData: {
        select: {
          amount: true,
          vendorName: true,
          confidenceScore: true,
        },
      },
    },
  });

  return docs.map((d) => ({
    id: d.id,
    createdAt: d.createdAt,
    source: d.source,
    vendorName: d.extractedData?.vendorName ?? null,
    amount: d.extractedData?.amount ?? null,
    confidenceScore: d.extractedData?.confidenceScore ?? null,
  }));
}

export async function loadInventoryAlertsUnresolved(
  businessId: number
): Promise<InventoryAlertRaw[]> {
  const alerts = await prisma.inventoryAlert.findMany({
    where: {
      businessId,
      isResolved: false,
    },
    orderBy: { createdAt: "desc" },
    take: BS_INVENTORY_CAP,
    select: {
      id: true,
      type: true,
      message: true,
      createdAt: true,
      itemId: true,
      item: {
        select: { name: true },
      },
    },
  });

  return alerts.map((a) => ({
    id: a.id,
    type: a.type,
    message: a.message,
    createdAt: a.createdAt,
    itemId: a.itemId,
    itemName: a.item?.name ?? null,
  }));
}

const BILLING_SELECT = {
  id: true,
  status: true,
  customerNameSnapshot: true,
  totalAmount: true,
  currency: true,
  createdAt: true,
  pdfRenderStatus: true,
  pdfRenderError: true,
  documentNumberFormatted: true,
} satisfies Prisma.BillingDocumentSelect;

export async function loadBillingPendingReview(
  businessId: number
): Promise<BillingDocRaw[]> {
  return prisma.billingDocument.findMany({
    where: {
      businessId,
      status: BillingDocumentStatus.PENDING_REVIEW,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: BS_BILLING_PENDING_CAP,
    select: BILLING_SELECT,
  });
}

export async function loadBillingPdfFailed(
  businessId: number
): Promise<BillingDocRaw[]> {
  return prisma.billingDocument.findMany({
    where: {
      businessId,
      pdfRenderStatus: BillingPdfRenderStatus.FAILED,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: BS_BILLING_PDF_FAILED_CAP,
    select: BILLING_SELECT,
  });
}

export async function loadSupplierPurchasesPending(
  businessId: number
): Promise<SupplierDraftRaw[]> {
  const drafts = await prisma.supplierPurchaseDraft.findMany({
    where: {
      businessId,
      status: SupplierPurchaseDraftStatus.PENDING_REVIEW,
    },
    orderBy: { createdAt: "desc" },
    take: BS_SUPPLIER_CAP,
    select: {
      id: true,
      createdAt: true,
      supplierName: true,
      externalOrderId: true,
      _count: { select: { lines: true } },
    },
  });

  return drafts.map((d) => ({
    id: d.id,
    createdAt: d.createdAt,
    supplierName: d.supplierName,
    externalOrderId: d.externalOrderId,
    lineCount: d._count.lines,
  }));
}
