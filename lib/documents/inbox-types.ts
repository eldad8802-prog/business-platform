/**
 * Client-side shapes for GET /api/documents/inbox (matches API JSON; no ocrText).
 */

export type InboxConfidenceDotLevel = "high" | "medium" | "low";

export type InboxConfidenceDots = {
  amount: InboxConfidenceDotLevel;
  vendor: InboxConfidenceDotLevel;
  dateProxy: InboxConfidenceDotLevel;
};

export type InboxPreview = {
  kind: "pdf" | "image" | "unsupported";
  fileAvailable: boolean;
  thumbnailReady: false;
};

export type InboxExtracted = {
  amount: number | null;
  vendorName: string | null;
  date: string | null;
  direction: string | null;
  category: string | null;
  confidenceScore: number | null;
  amountConfidence: string | null;
  vendorConfidence: string | null;
  categoryConfidence: string | null;
} | null;

export type InboxFinancial = {
  amount: number;
  vendorName: string;
  date: string;
  direction: string;
  category: string;
  approvedAt: string;
};

/** Normalized row for Inbox UI (subset / stable names). */
export type InboxListItem = {
  documentId: number;
  createdAt: string;
  groupMonth: string;
  status: string;
  source: string;
  mimeType: string;
  preview: InboxPreview;
  extracted: InboxExtracted;
  financial?: InboxFinancial;
  confidenceDots: InboxConfidenceDots;
  quickApproveEligible: boolean;
};

export type InboxFinancialPulse = {
  period: {
    month: string;
    from: string;
    toExclusive: string;
  };
  fromFinancialRecords: {
    income: number;
    expense: number;
    net: number;
    recordCount: number;
  };
  inboxDocumentCounts: {
    pendingReview: number;
    approvedDocuments: number;
  };
};

export type InboxScope = {
  month: string;
  timezone: string;
};

export type InboxPagination = {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
};

/** Hub summary mode (`summaryOnly=1`) — next document awaiting review in scope month. */
export type DocumentsHubNextPending = {
  documentId: number;
  status: string;
  extracted: {
    amount: number | null;
    vendorName: string | null;
  } | null;
} | null;
