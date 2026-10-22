import { BS_GLOBAL_ITEM_CAP } from "./limits";
import {
  loadAttentionPendingSuggestions,
  loadAttentionWaiting,
  loadBillingPdfFailed,
  loadBillingPendingReview,
  loadDocumentsNeedsReview,
  loadInventoryAlertsUnresolved,
  loadLeadsNeedingAttention,
  loadSupplierPurchasesPending,
  loadPayablesOverdue,
  loadPayablesDueSoon,
  loadBillingStaleDrafts,
  loadStalePaymentLinks,
} from "./loaders";
import { finalizeBusinessStatusItem } from "./priority";
import { evaluatePaperworkInsight } from "./paperwork-insight";
import type { Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";
import { STATUS_HE_T } from "./i18n";
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
import { translateLeadsNeedingAttention } from "./translators/leads";
import { translateInventoryAlerts } from "./translators/inventory";
import { translateSupplierPurchasesPending } from "./translators/supplier";
import {
  translatePayablesDueSoon,
  translatePayablesOverdue,
} from "./translators/payables";
import {
  translateBillingStaleDrafts,
  translateStalePaymentLinks,
} from "./translators/forgotten-money";

/**
 * Read-only aggregation for Business Status MVP v1.
 * Five domains in parallel; unified sort; global cap.
 *
 * `i18n` is the interface language of the request (route handlers pass `getServerI18n()`); without it the
 * text is the Hebrew it always was. Background consumers (knowledge, notifications) keep the Hebrew default.
 */
export async function getBusinessStatusSnapshot(
  businessId: number,
  i18n: { t: Translator; locale: Locale } = { t: STATUS_HE_T, locale: "he" }
): Promise<BusinessStatusSnapshot> {
  const { t, locale } = i18n;
  // One clock for the whole snapshot: two domains deriving "today" a few
  // milliseconds apart could disagree across a midnight boundary.
  const now = new Date();
  const paperworkInsightPromise = evaluatePaperworkInsight(businessId, t);

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
    leadRows,
    payablesOverdueRows,
    payablesDueSoonRows,
    staleDraftRows,
    stalePaymentLinkRows,
    paperworkInsight,
  ] = await Promise.all([
    loadAttentionPendingSuggestions(businessId, excludeConvIds),
    loadDocumentsNeedsReview(businessId),
    loadInventoryAlertsUnresolved(businessId),
    loadBillingPendingReview(businessId),
    loadBillingPdfFailed(businessId),
    loadSupplierPurchasesPending(businessId),
    loadLeadsNeedingAttention(businessId, now),
    loadPayablesOverdue(businessId, now),
    loadPayablesDueSoon(businessId, now),
    loadBillingStaleDrafts(businessId, now),
    loadStalePaymentLinks(businessId, now),
    paperworkInsightPromise,
  ]);

  const builds = [
    ...translateAttentionWaiting(waitingRows, t),
    ...translateAttentionPendingSuggestions(pendingSuggestionRows, t),
    ...translateDocumentsNeedsReview(documentRows, t),
    ...translateInventoryAlerts(inventoryRows, t),
    ...translateBillingPendingReview(billingPendingRows, t, locale),
    ...translateBillingPdfFailed(billingFailedRows, t),
    ...translateSupplierPurchasesPending(supplierRows, t),
    ...translateLeadsNeedingAttention(leadRows, now, t),
    ...translatePayablesOverdue(payablesOverdueRows, now, t, locale),
    ...translatePayablesDueSoon(payablesDueSoonRows, now, t, locale),
    ...translateBillingStaleDrafts(staleDraftRows, now, t, locale),
    ...translateStalePaymentLinks(stalePaymentLinkRows, now, t, locale),
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
