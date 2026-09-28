/**
 * M1 Production proof — a payment whose webhook is genuinely never processed.
 *
 * Reconciliation exists for the payment Dubiz was never told about. Proving it
 * in Production needs exactly that payment: real (on the CardCom TEST terminal),
 * verified by CardCom, and never delivered to the processing path. Nothing may
 * be fabricated to get there, so the only honest lever is the one CardCom
 * itself uses — where it sends the notification.
 *
 * When suppression applies, the checkout is created with a WebHookUrl on the QA
 * sink, which accepts CardCom's callback with 200 and discards it unread — so
 * delivery succeeds from CardCom's side and nothing processes it on ours. The
 * payment exists only at CardCom until reconciliation asks.
 *
 * (The first version pointed at a path with NO route, answering 404. A checkout
 * issued that way — Production request 7 — never rendered CardCom's form. Whether
 * the 404 caused that is unproven; the 200 sink removes the only protocol
 * difference from a normal checkout either way.)
 *
 * TWO GATES, both required:
 *   - the environment flag holds this exact value — unset everywhere by default;
 *   - the request belongs to the ONE Production QA tenant, whose id is a
 *     reviewed repository constant (ops/tenant/collection-qa-tenant.identity.env,
 *     COLLECTION_QA_BUSINESS_ID, pinned by scripts/ci/collection-qa-tenant-guard).
 * A flag left on can therefore never touch a real business, and no owner can
 * turn it on for their own.
 */

/** COLLECTION_QA_BUSINESS_ID — the Production QA tenant (provisioned 2026-09-23). */
export const COLLECTION_QA_BUSINESS_ID = 38;

export const QA_WEBHOOK_SUPPRESSION_FLAG = "PAYMENTS_QA_SUPPRESS_WEBHOOK";
export const QA_WEBHOOK_SUPPRESSION_VALUE = "collection-qa-38";

/**
 * A route that accepts the callback with 200 and discards it unread
 * (app/api/payments/qa-webhook-sink/route.ts). With the flag off it answers 404.
 */
export const QA_WEBHOOK_SINK_PATH = "/api/payments/qa-webhook-sink";

export function isQaWebhookSuppressed(
  businessId: number,
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    (env[QA_WEBHOOK_SUPPRESSION_FLAG] ?? "").trim() === QA_WEBHOOK_SUPPRESSION_VALUE &&
    businessId === COLLECTION_QA_BUSINESS_ID
  );
}
