/**
 * Run: npx tsx components/collection/thread/refund-outcome.test.ts
 *
 * F1 — a refund the provider completed must never be announced as refused.
 *
 * The contract is proven from the SERVICE side, not restated: the real refund
 * service runs against the in-memory store with a provider that completes the
 * reversal, and whatever outcome it returns is what the screen is handed. If the
 * service ever renames its success outcome, this fails — which is exactly how
 * the original defect ("SETTLED" on screen, "REFUNDED" from the API) would have
 * been caught.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  refundOutcomeNotice,
  UNRECOGNISED_REFUND_OUTCOME_NOTICE,
} from "./refund-outcome";
import { refundPaymentRequest } from "@/lib/services/payments/payment-refund.service";
import { createInMemoryPaymentStore } from "@/lib/services/payments/payment-store.memory";
import type {
  PaymentProviderAdapter,
  RefundPaymentResult,
} from "@/lib/services/payments/providers/payment-provider.types";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

const REFUSAL_WORDING = /לא ביצעה|נכשל|נדחה/;

function provider(outcome: RefundPaymentResult["outcome"]): PaymentProviderAdapter {
  return {
    provider: "CARDCOM",
    supportedCurrencies: ["ILS"],
    async createPaymentLink() {
      return { paymentUrl: "https://pay.example/x", providerRequestId: "x" };
    },
    async verifyWebhook() {
      return { ok: true as const };
    },
    parseWebhook() {
      return {
        providerEventId: null,
        eventType: null,
        providerRequestId: null,
        providerTransactionId: null,
        outcome: "UNKNOWN" as const,
        amount: null,
        currency: null,
      };
    },
    async refundPayment() {
      return { providerRefundId: outcome === "REFUNDED" ? "r-1" : null, outcome };
    },
  };
}

async function refundThroughService(outcome: RefundPaymentResult["outcome"]) {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true, merchantId: "m-1" });
  const request = await store.createPaymentRequest({
    businessId: 1,
    customerId: null,
    billingDocumentId: null,
    provider: "CARDCOM",
    amount: "100.00",
    currency: "ILS",
    description: "f1",
    status: "PAID",
    expiresAt: null,
  });
  await store.createTransaction({
    paymentRequestId: request.id,
    provider: "CARDCOM",
    providerTransactionId: `settle-${request.id}`,
    amount: "100.00",
    currency: "ILS",
    status: "PAID",
    rawPayload: null,
  });
  return refundPaymentRequest(
    { businessId: 1, actorUserId: 7, requestId: request.id, amount: "40.00" },
    {
      store,
      resolveProvider: () => provider(outcome),
      decryptConnectionCredential: () => JSON.stringify({ apiName: "a", apiPassword: "p" }),
    }
  );
}

async function main() {
  // The real service, a provider that completed the refund.
  const done = await refundThroughService("REFUNDED");
  const doneNotice = refundOutcomeNotice(done.outcome);
  ok("the service reports a completed refund", done.outcome === "REFUNDED", String(done.outcome));
  ok("a completed refund is announced as done", doneNotice === "ההחזר בוצע.", doneNotice);
  ok("a completed refund is never worded as a refusal", !REFUSAL_WORDING.test(doneNotice), doneNotice);

  // The real service, a provider whose answer was lost.
  const unknown = await refundThroughService("UNKNOWN");
  const unknownNotice = refundOutcomeNotice(unknown.outcome);
  ok("an unestablished refund is reported as UNKNOWN", unknown.outcome === "UNKNOWN");
  ok("an unestablished refund is announced as pending", /עוד לא ידועה/.test(unknownNotice), unknownNotice);
  ok("an unestablished refund is never worded as a refusal", !REFUSAL_WORDING.test(unknownNotice));

  // Anything the screen does not recognise — including the old "SETTLED" — is
  // neither success nor refusal.
  for (const stray of ["SETTLED", "FAILED", "", null, undefined, "toString", "__proto__"]) {
    const notice = refundOutcomeNotice(stray as string | null | undefined);
    ok(
      `unrecognised outcome ${JSON.stringify(stray)} is neutral`,
      notice === UNRECOGNISED_REFUND_OUTCOME_NOTICE && !REFUSAL_WORDING.test(notice),
      notice
    );
  }

  // The screen routes the API answer through this mapping, and keeps no
  // private outcome comparison of its own that could drift again.
  const screen = readFileSync(
    join(process.cwd(), "components/collection/thread/customer-thread-screen.tsx"),
    "utf8"
  );
  // Only the refund POST's handling is pinned: the settlement-retry button on
  // the same screen legitimately compares its own (settlement) outcomes.
  const at = screen.indexOf("/refund`, {");
  const refundBlock = at >= 0 ? screen.slice(at, at + 600) : "";
  ok("the refund POST is present on the thread screen", at >= 0);
  ok("the refund answer goes through refundOutcomeNotice", /refundOutcomeNotice\(r\.outcome\)/.test(refundBlock));
  ok(
    "the refund answer is not compared to a literal on the screen",
    !/r\.outcome\s*===/.test(refundBlock)
  );
  ok("the thread screen no longer claims a refusal from an outcome", !/לא ביצעה את ההחזר/.test(screen));

  console.log(
    failures.length === 0
      ? `refund-outcome (F1): ${pass} passed, 0 failed`
      : `refund-outcome (F1): ${failures.length} FAILED`
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
