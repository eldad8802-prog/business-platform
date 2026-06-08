export type BusinessOperationalStatus =
  | "healthy"
  | "attention_needed"
  | "struggling"
  | "inactive";

export type BusinessAttentionSignal = {
  id: string;
  severity: "critical" | "high" | "medium" | "info";
  category: string;
  title: string;
  detail?: string;
};

export type PlatformAdminBusinessDetailResponse = {
  generatedAt: string;
  business: {
    id: number;
    name: string;
    createdAt: string;
    archivedAt: string | null;
    archivedByUserId: number | null;
    usersCount: number;
    lastActivityAt: string | null;
    operationalStatus: BusinessOperationalStatus;
    operationalStatusLabel: string;
  };
  usage: {
    windowDays: number;
    logins7d: number;
    activeUsers7d: number;
    topFeature: { featureKey: string; total: number } | null;
    frictionFeature: {
      featureKey: string;
      completionRate: number;
      opened: number;
    } | null;
  };
  documents: {
    total: number;
    needsReview: number;
    stuckNeedsReview: number;
    recentUploads: Array<{
      id: number;
      createdAt: string;
      status: string;
      source: string;
    }>;
  };
  billing: {
    drafts: number;
    pendingReview: number;
    issued: number;
    pdfFailures: number;
  };
  conversations: {
    open: number;
    waitingForReply: number;
    lastMessageAt: string | null;
  };
  integrations: {
    gmailConnected: boolean;
    gmailEmail: string | null;
    gmailLastSyncedAt: string | null;
    whatsappImportFailures: number;
  };
  attentionSignals: BusinessAttentionSignal[];
};
