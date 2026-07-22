import type {
  DocumentsHubNextPending,
  InboxFinancialPulse,
  InboxListItem,
  InboxPagination,
  InboxScope,
} from "./inbox-types";

type ApiItem = {
  documentId: number;
  createdAt: string;
  groupMonth: string;
  status: string;
  source: string;
  mimeType: string;
  preview: InboxListItem["preview"];
  extracted: InboxListItem["extracted"];
  financial?: InboxListItem["financial"];
  confidenceDots: InboxListItem["confidenceDots"];
  quickApprove: { eligible: boolean };
};

type ApiSuccessBody = {
  success: true;
  scope: InboxScope;
  financialPulse: InboxFinancialPulse;
  items: ApiItem[];
  pagination: InboxPagination;
};

function normalizeItem(raw: ApiItem): InboxListItem {
  return {
    documentId: raw.documentId,
    createdAt: raw.createdAt,
    groupMonth: raw.groupMonth,
    status: raw.status,
    source: raw.source,
    mimeType: raw.mimeType,
    preview: raw.preview,
    extracted: raw.extracted,
    financial: raw.financial,
    confidenceDots: raw.confidenceDots,
    quickApproveEligible: raw.quickApprove.eligible,
  };
}

export type DocumentsInboxSnapshot = {
  scope: InboxScope;
  financialPulse: InboxFinancialPulse;
  items: InboxListItem[];
  pagination: InboxPagination;
};

type ApiHubSummaryBody = {
  success: true;
  scope: InboxScope;
  financialPulse: InboxFinancialPulse;
  /** Net cash-flow of the previous Jerusalem month; null when there is no prior data. */
  previousNet: number | null;
  nextPending: DocumentsHubNextPending;
  items: [];
  pagination: InboxPagination;
};

export type DocumentsHubSnapshot = {
  scope: InboxScope;
  financialPulse: InboxFinancialPulse;
  previousNet: number | null;
  nextPending: DocumentsHubNextPending;
};

export async function fetchDocumentsHubSummary(
  token: string,
  query?: { month?: string }
): Promise<DocumentsHubSnapshot> {
  const sp = new URLSearchParams();
  sp.set("summaryOnly", "1");
  if (query?.month) sp.set("month", query.month);

  const url = `/api/documents/inbox?${sp.toString()}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (res.status === 401) {
    throw new Error("Unauthorized");
  }

  const json = (await res.json()) as ApiHubSummaryBody | { error?: string };

  if (!res.ok) {
    throw new Error(
      typeof (json as { error?: string }).error === "string"
        ? (json as { error: string }).error
        : "Request failed"
    );
  }

  const body = json as ApiHubSummaryBody;
  if (!body.success) {
    throw new Error("Invalid hub summary response");
  }

  return {
    scope: body.scope,
    financialPulse: body.financialPulse,
    previousNet: body.previousNet ?? null,
    nextPending: body.nextPending ?? null,
  };
}

export async function fetchDocumentsInbox(
  token: string,
  query?: { month?: string; cursor?: string; limit?: number }
): Promise<DocumentsInboxSnapshot> {
  const sp = new URLSearchParams();
  if (query?.month) sp.set("month", query.month);
  if (query?.cursor) sp.set("cursor", query.cursor);
  if (query?.limit != null) sp.set("limit", String(query.limit));

  const qs = sp.toString();
  const url = qs ? `/api/documents/inbox?${qs}` : "/api/documents/inbox";

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (res.status === 401) {
    throw new Error("Unauthorized");
  }

  const json = (await res.json()) as ApiSuccessBody | { error?: string };

  if (!res.ok) {
    throw new Error(
      typeof (json as { error?: string }).error === "string"
        ? (json as { error: string }).error
        : "Request failed"
    );
  }

  const body = json as ApiSuccessBody;
  if (!body.success) {
    throw new Error("Invalid inbox response");
  }

  return {
    scope: body.scope,
    financialPulse: body.financialPulse,
    items: body.items.map(normalizeItem),
    pagination: body.pagination,
  };
}
