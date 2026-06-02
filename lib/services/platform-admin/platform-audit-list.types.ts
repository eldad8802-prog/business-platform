export type PlatformAuditRowTone = "info" | "warning" | "sensitive";

export type PlatformAuditListItem = {
  id: number;
  timestamp: string;
  actor: {
    id: number | null;
    email: string | null;
    name: string | null;
    display: string;
  };
  action: string;
  actionLabel: string;
  tone: PlatformAuditRowTone;
  target: {
    type: string | null;
    id: string | null;
    display: string | null;
  };
  detail: string | null;
  ip: string | null;
  userAgentShort: string | null;
};

export type PlatformAdminAuditResponse = {
  generatedAt: string;
  summary: {
    events24h: number;
    uniqueAdmins7d: number;
    mostCommonAction: {
      action: string;
      actionLabel: string;
      count: number;
    } | null;
  };
  items: PlatformAuditListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};
