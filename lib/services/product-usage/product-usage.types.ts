import type {
  ProductUsageAction,
  ProductUsageFeatureKey,
  ProductUsageOutcome,
} from "./product-usage-catalog";

export type RecordProductUsageEventInput = {
  businessId?: number | null;
  userId?: number | null;
  sessionId?: string | null;
  featureKey: ProductUsageFeatureKey | string;
  action: ProductUsageAction | string;
  outcome?: ProductUsageOutcome | string | null;
  entityType?: string | null;
  entityId?: string | null;
  durationMs?: number | null;
  source?: string;
  metadata?: Record<string, unknown> | null;
};
