export type PlatformAdminOverviewResponse = {
  generatedAt: string;
  totals: {
    businesses: number;
    users: number;
  };
  billing: {
    byStatus: {
      DRAFT: number;
      PENDING_REVIEW: number;
      ISSUED: number;
    };
    pdfRenderFailed: number;
  };
  documents: {
    needsReview: number;
  };
  content: {
    runsFailed: number;
    runsFailedLast7d: number;
  };
  conversations: {
    total: number;
    open: number;
    activeRecent: number;
  };
  integrations: {
    gmailConnections: number;
    gmailConnected: number;
    whatsappImportsFailed: number;
  };
};

export type PlatformAdminBusinessListItem = {
  id: number;
  name: string;
  createdAt: string;
  usersCount: number;
  counts: {
    billingDocuments: number;
    documentsNeedsReview: number;
    conversations: number;
    contentRuns: number;
  };
};

export type PlatformAdminBusinessesResponse = {
  items: PlatformAdminBusinessListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export type PlatformAdminSessionResponse = {
  admin: {
    id: number;
    email: string;
    name: string | null;
  };
  serverTime: string;
  environment: string;
  /**
   * CASA 3.3.1 step-up state. Lets the admin UI decide whether to prompt for
   * enrollment or for a code, without ever exposing the seed or any code.
   */
  mfa: {
    /** Whether enforcement is on in this environment. */
    required: boolean;
    /** Whether this admin has a confirmed authenticator. */
    enrolled: boolean;
    /** Whether THIS request carried a valid, unexpired elevation. */
    elevated: boolean;
    recoveryCodesRemaining: number;
  };
};

export type PlatformAttentionSeverity =
  | "critical"
  | "high"
  | "medium"
  | "info";

export type PlatformAttentionCategory =
  | "billing"
  | "documents"
  | "content"
  | "integrations"
  | "platform";

export type PlatformAttentionItem = {
  id: string;
  severity: PlatformAttentionSeverity;
  category: PlatformAttentionCategory;
  title: string;
  detail?: string;
  businessId?: number;
  businessName?: string;
};

export type PlatformAdminAttentionResponse = {
  generatedAt: string;
  items: PlatformAttentionItem[];
};
