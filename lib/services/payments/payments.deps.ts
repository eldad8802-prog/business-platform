/**
 * Production dependency wiring for the payments services.
 *
 * Wires the Prisma-backed store, the provider registry, and the credential
 * decryptor. Routes call `createPaymentRequest(input, paymentRequestDeps())`
 * and `processPaymentWebhook(input, paymentWebhookDeps())` — they never reach
 * for Prisma or a provider directly.
 */

import { decryptPaymentCredential } from "./payment-crypto.service";
import { createPaymentPrismaStore } from "./payment-store.prisma";
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
  // Per-provider webhook secret from env (optional in foundation stage).
  if (provider === "TRANZILA") {
    return process.env.TRANZILA_WEBHOOK_SECRET ?? null;
  }
  return null;
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
  };
}
