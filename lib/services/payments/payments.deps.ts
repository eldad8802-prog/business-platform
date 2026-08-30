/**
 * Production dependency wiring for the payments services.
 *
 * Wires the Prisma-backed store, the provider registry, and the credential
 * decryptor. Routes call `createPaymentRequest(input, paymentRequestDeps())`
 * and `processPaymentWebhook(input, paymentWebhookDeps())` — they never reach
 * for Prisma or a provider directly.
 */

import { ensurePaymentPostedEvent } from "@/lib/services/financial-events/financial-event.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  decryptPaymentCredential,
  encryptPaymentCredential,
} from "./payment-crypto.service";
import { createPaymentPrismaStore } from "./payment-store.prisma";
import type { PaymentConnectionDeps } from "./payment-connection.service";
import type {
  CreatePaymentRequestDeps,
} from "./payment-request.service";
import type { ProcessWebhookDeps } from "./payment-webhook.service";
import type { PaymentConnectionRecord, PaymentProvider } from "./payments.types";
import { resolvePaymentProvider } from "./providers/provider-registry";

function decryptConnectionCredential(
  connection: PaymentConnectionRecord
): string | null {
  if (!connection.credentialEncrypted) return null;
  return decryptPaymentCredential(
    {
      credentialEncrypted: connection.credentialEncrypted,
      credentialIv: connection.credentialIv,
      credentialTag: connection.credentialTag,
    },
    connection.businessId,
    connection.provider
  );
}

function resolveWebhookSecret(provider: PaymentProvider): string | null {
  // Provider-driven convention: `<PROVIDER>_WEBHOOK_SECRET` (optional).
  // Preserves the existing TRANZILA_WEBHOOK_SECRET and adds new providers with
  // zero code change (e.g. CARDCOM_WEBHOOK_SECRET).
  return process.env[`${provider}_WEBHOOK_SECRET`] ?? null;
}

export function paymentRequestDeps(): CreatePaymentRequestDeps {
  return {
    store: createPaymentPrismaStore(),
    resolveProvider: resolvePaymentProvider,
    decryptConnectionCredential,
  };
}

export function paymentWebhookDeps(): ProcessWebhookDeps {
  return {
    store: createPaymentPrismaStore(),
    resolveProvider: resolvePaymentProvider,
    resolveWebhookSecret,
    decryptConnectionCredential,
    // Financial Control projection: verified PAID -> FinancialEvent(PAYMENT).
    // Best-effort and idempotent on the transaction id; never breaks the flow.
    onVerifiedPaid: async (e) => {
      try {
        // D2/P7-W4E-A: FinancialEvent is FORCE-RLS'd, so a bare
        // prisma.$transaction here would post ZERO events in silence. The hook
        // fires from inside the webhook's tenant context (derived from the
        // VERIFIED stored PaymentRequest), and the context is re-asserted from
        // the event's own businessId so the hook is still correct if a future
        // caller invokes it with no ambient context. Idempotency stays where it
        // belongs: the DB unique on (businessId, sourceType, sourceKey).
        await runWithTenantContext({ businessId: e.businessId }, () =>
          withTenantTransaction((tx) =>
            ensurePaymentPostedEvent(tx, {
              businessId: e.businessId,
              paymentRequestId: e.paymentRequestId,
              transactionId: e.transactionId,
              amount: e.amount,
              currency: e.currency,
              occurredAt: e.occurredAt,
            })
          )
        );
      } catch (err) {
        console.error("onVerifiedPaid (FinancialEvent PAYMENT) error:", err);
      }
    },
  };
}

export function paymentConnectionDeps(): PaymentConnectionDeps {
  return {
    store: createPaymentPrismaStore(),
    encryptCredential: encryptPaymentCredential,
  };
}
