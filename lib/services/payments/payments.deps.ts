/**
 * Production dependency wiring for the payments services.
 *
 * Wires the Prisma-backed store, the provider registry, and the credential
 * decryptor. Routes call `createPaymentRequest(input, paymentRequestDeps())`
 * and `processPaymentWebhook(input, paymentWebhookDeps())` — they never reach
 * for Prisma or a provider directly.
 */

import { prisma } from "@/lib/prisma";
import { ensurePaymentPostedEvent } from "@/lib/services/financial-events/financial-event.service";
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
        await prisma.$transaction((tx) =>
          ensurePaymentPostedEvent(tx, {
            businessId: e.businessId,
            paymentRequestId: e.paymentRequestId,
            transactionId: e.transactionId,
            amount: e.amount,
            currency: e.currency,
            occurredAt: e.occurredAt,
          })
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
