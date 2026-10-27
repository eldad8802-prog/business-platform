/** Internal business row for platform admins (User.businessId is required). */
export const PLATFORM_SYSTEM_BUSINESS_NAME = "__PLATFORM_SYSTEM__";

export const PLATFORM_AUDIT_ACTIONS = {
  OVERVIEW_VIEWED: "PLATFORM_ADMIN_OVERVIEW_VIEWED",
  BUSINESSES_LIST_VIEWED: "PLATFORM_ADMIN_BUSINESSES_LIST_VIEWED",
  ATTENTION_VIEWED: "PLATFORM_ADMIN_ATTENTION_VIEWED",
  USAGE_OVERVIEW_VIEWED: "PLATFORM_ADMIN_USAGE_OVERVIEW_VIEWED",
  BUSINESS_DETAIL_VIEWED: "PLATFORM_ADMIN_BUSINESS_DETAIL_VIEWED",
  AUDIT_VIEWED: "PLATFORM_ADMIN_AUDIT_VIEWED",
  /** The accountant package monitoring page (G5 milestone 1). */
  ACCOUNTANT_OPS_VIEWED: "PLATFORM_ADMIN_ACCOUNTANT_OPS_VIEWED",
  /** @deprecated No longer written; kept for audit viewer labels on legacy rows. */
  SESSION_VIEWED: "PLATFORM_ADMIN_SESSION_VIEWED",
  AREA_ENTERED: "PLATFORM_ADMIN_AREA_ENTERED",
  FEATURE_ACCESS_UPDATED: "PLATFORM_FEATURE_ACCESS_UPDATED",
  /** An indeterminate refund resolved from evidence at the provider (MFA). */
  PAYMENT_REVERSAL_RESOLVED: "PLATFORM_PAYMENT_REVERSAL_RESOLVED",
  /** Admin Control Center home (A1). */
  HOME_VIEWED: "PLATFORM_ADMIN_HOME_VIEWED",
  /** A second factor was proven and an elevation issued (metadata.method). */
  STEP_UP_SUCCEEDED: "PLATFORM_ADMIN_STEP_UP_SUCCEEDED",
  /** A second-factor proof was refused (metadata.method, metadata.reason). */
  STEP_UP_FAILED: "PLATFORM_ADMIN_STEP_UP_FAILED",
  /** An authenticator app was confirmed for this admin. */
  MFA_ENROLLED: "PLATFORM_ADMIN_MFA_ENROLLED",
  /** The authenticator app was replaced by a new one (old one inactive from that moment). */
  MFA_REPLACED: "PLATFORM_ADMIN_MFA_REPLACED",
  PASSKEY_REGISTERED: "PLATFORM_ADMIN_PASSKEY_REGISTERED",
  PASSKEY_REVOKED: "PLATFORM_ADMIN_PASSKEY_REVOKED",
} as const;

/** Throttle window for AREA_ENTERED per admin (minutes). */
export const PLATFORM_ADMIN_AREA_ENTERED_THROTTLE_MINUTES = 15;

/** Platform-wide document backlog before surfacing in attention feed. */
export const PLATFORM_DOC_BACKLOG_THRESHOLD = 10;

/** Per-business document backlog threshold. */
export const BUSINESS_DOC_BACKLOG_THRESHOLD = 3;

export const MAX_ATTENTION_ITEMS = 12;
