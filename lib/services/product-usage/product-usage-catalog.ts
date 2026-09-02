/** Stable feature keys — do not rename without migration plan. */
export const PRODUCT_USAGE_FEATURES = {
  AUTH_LOGIN: "auth.login",
  AUTH_REGISTER: "auth.register",
  AUTH_LOGOUT: "auth.logout",
  DOCUMENTS_INBOX: "documents.inbox",
  DOCUMENTS_UPLOAD: "documents.upload",
  DOCUMENTS_REVIEW_APPROVE: "documents.review.approve",
  BILLING_DOCUMENT_CREATE: "billing.document.create",
  BILLING_DOCUMENT_ISSUE: "billing.document.issue",
} as const;

export type ProductUsageFeatureKey =
  (typeof PRODUCT_USAGE_FEATURES)[keyof typeof PRODUCT_USAGE_FEATURES];

export const PRODUCT_USAGE_ACTIONS = {
  OPENED: "opened",
  COMPLETED: "completed",
  FAILED: "failed",
  ABANDONED: "abandoned",
  THROTTLED: "throttled",
} as const;

export type ProductUsageAction =
  (typeof PRODUCT_USAGE_ACTIONS)[keyof typeof PRODUCT_USAGE_ACTIONS];

export const PRODUCT_USAGE_OUTCOMES = {
  SUCCESS: "success",
  FAILURE: "failure",
  CANCEL: "cancel",
  TIMEOUT: "timeout",
} as const;

export type ProductUsageOutcome =
  (typeof PRODUCT_USAGE_OUTCOMES)[keyof typeof PRODUCT_USAGE_OUTCOMES];

export const PRODUCT_USAGE_SOURCES = {
  API: "api",
  SERVICE: "service",
  SYSTEM: "system",
} as const;
