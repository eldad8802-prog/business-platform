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

export type PlatformAdminBusinessFilter = "all" | "new" | "inactive" | "no_onboarding";

export type PlatformAdminBusinessListItem = {
  id: number;
  name: string;
  createdAt: string;
  usersCount: number;
  /** Email of the business's first user (Dubiz has one user per business today). */
  ownerEmail: string | null;
  /** Most recent use of any session of any user of the business. */
  lastActiveAt: string | null;
  onboardingCompletedAt: string | null;
  lifecycle: "ACTIVE" | "ARCHIVED" | "DELETION_REQUESTED";
  counts: {
    billingDocuments: number;
    documentsNeedsReview: number;
    conversations: number;
    contentRuns: number;
  };
};

export type PlatformAdminBusinessesResponse = {
  items: PlatformAdminBusinessListItem[];
  query: { q: string | null; filter: PlatformAdminBusinessFilter };
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
  /** Which deployment answered (from VERCEL_ENV). */
  deployment: "production" | "preview" | "local";
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
    /** When that elevation ends (ISO), or null. */
    elevationExpiresAt: string | null;
    recoveryCodesRemaining: number;
    /** Passkey step-up: switched on here, and how many this admin holds. */
    passkeys: { available: boolean; count: number };
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

/**
 * Admin Control Center home (A1). Every figure is defined in
 * lib/services/platform-admin/platform-home.service.ts; a figure with no
 * trustworthy source is `null` with a reason — never a zero.
 */
export type PlatformAdminHomeResponse = {
  generatedAt: string;
  timeZone: "Asia/Jerusalem";
  /** The Jerusalem calendar day the "today" figures refer to (YYYY-MM-DD). */
  today: string;
  businesses: {
    total: number;
    /** Session used AND a completed (non-auth) product action, last 7 days. */
    active7d: number;
    active30d: number;
  };
  users: {
    total: number;
    /** Distinct users whose session was used in the last 24 hours. */
    seen24h: number;
  };
  signups: {
    today: number;
    /** Since Sunday 00:00, Jerusalem. */
    week: number;
    /** Since the 1st of the month 00:00, Jerusalem. */
    month: number;
    /** Oldest first; 30 entries ending today. */
    daily30: Array<{ day: string; count: number }>;
  };
  onboarding: {
    /** Only businesses created after the backfill stamp carry a real completion time. */
    reliableSince: string;
    cohort: number;
    completed: number;
  };
  /** Businesses that registered in the last 30 days, and how far they got. */
  funnel30d: {
    registered: number;
    /** null while email verification is not switched on in this environment. */
    emailVerified: number | null;
    returnedToLogin: number;
    onboarded: number;
    activated: number;
  };
  commercial: {
    status: "NO_SUBSCRIPTION_SYSTEM";
  };
  recentBusinesses: Array<{
    id: number;
    name: string;
    createdAt: string;
    ownerEmail: string | null;
  }>;
  recentAdminActions: Array<{
    id: number;
    action: string;
    actorUserId: number | null;
    targetType: string | null;
    targetId: string | null;
    createdAt: string;
  }>;
};
