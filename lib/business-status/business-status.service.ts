import { BS_GLOBAL_ITEM_CAP } from "./limits";
import {
  loadAttentionPendingSuggestions,
  loadAttentionWaiting,
  loadBillingPdfFailed,
  loadBillingPendingReview,
  loadDocumentsNeedsReview,
  loadInventoryAlertsUnresolved,
  loadSupplierPurchasesPending,
} from "./loaders";
import { finalizeBusinessStatusItem } from "./priority";
import { evaluatePaperworkInsight } from "./paperwork-insight";
import type { BusinessStatusSnapshot } from "./types";
import {
  translateAttentionPendingSuggestions,
  translateAttentionWaiting,
} from "./translators/attention";
import {
  translateBillingPdfFailed,
  translateBillingPendingReview,
} from "./translators/billing";
import { translateDocumentsNeedsReview } from "./translators/documents";
import { translateInventoryAlerts } from "./translators/inventory";
import { translateSupplierPurchasesPending } from "./translators/supplier";

/**
 * Read-only aggregation for Business Status MVP v1.
 * Five domains in parallel; unified sort; global cap.
 */
export async function getBusinessStatusSnapshot(
  businessId: number
): Promise<BusinessStatusSnapshot> {
  const paperworkInsightPromise = evaluatePaperworkInsight(businessId);

  const waitingRows = await loadAttentionWaiting(businessId);
  const excludeConvIds = new Set(
    waitingRows.map((w) => w.conversationId)
  );

  const [
    pendingSuggestionRows,
    documentRows,
    inventoryRows,
    billingPendingRows,
    billingFailedRows,
    supplierRows,
    paperworkInsight,
  ] = await Promise.all([
    loadAttentionPendingSuggestions(businessId, excludeConvIds),
    loadDocumentsNeedsReview(businessId),
    loadInventoryAlertsUnresolved(businessId),
    loadBillingPendingReview(businessId),
    loadBillingPdfFailed(businessId),
    loadSupplierPurchasesPending(businessId),
    paperworkInsightPromise,
  ]);

  const builds = [
    ...translateAttentionWaiting(waitingRows),
    ...translateAttentionPendingSuggestions(pendingSuggestionRows),
    ...translateDocumentsNeedsReview(documentRows),
    ...translateInventoryAlerts(inventoryRows),
    ...translateBillingPendingReview(billingPendingRows),
    ...translateBillingPdfFailed(billingFailedRows),
    ...translateSupplierPurchasesPending(supplierRows),
  ];

  const items = builds
    .map(finalizeBusinessStatusItem)
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, BS_GLOBAL_ITEM_CAP);

  return {
    generatedAt: new Date().toISOString(),
    businessId,
    items,
    paperworkInsight,
  };
}
