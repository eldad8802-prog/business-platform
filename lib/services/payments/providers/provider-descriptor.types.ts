/**
 * Provider descriptor — the declarative contract that makes the payments
 * connection layer provider-driven.
 *
 * Each provider publishes a descriptor (co-located with its adapter, registered
 * in the provider registry) describing:
 *   - its merchant/terminal identifier field  (stored in the `merchantId` column)
 *   - its credential fields                    (stored as an encrypted JSON blob)
 *   - its capabilities                         (what the provider can do)
 *
 * The generic connection route validates + builds the credential from this
 * descriptor, the catalog endpoint exposes it to the UI (metadata only, never
 * values), and the UI renders its form from it. Adding a provider = adapter +
 * descriptor + registry entry — no new UI, no new route.
 */

import type { PaymentProvider } from "../payments.types";

export type CredentialFieldType = "text" | "secret";

export interface CredentialField {
  /** Stable key used both in the request body and in the encrypted JSON blob. */
  key: string;
  /** Human label for the UI (rendered from the catalog). */
  label: string;
  type: CredentialFieldType;
  required: boolean;
}

/**
 * Declarative capability flags. These DESCRIBE the provider; they do not by
 * themselves change behavior (e.g. the webhook authority is still gated on the
 * adapter actually implementing `getPaymentStatus`). They let the system and UI
 * reason about a provider without duck-typing.
 */
export interface ProviderCapabilities {
  hostedCheckout: boolean;
  verification: boolean;
  refund: boolean;
  sandbox: boolean;
  webhooks: boolean;
  tokens: boolean;
}

export interface ProviderMerchantField {
  /** Request-body key for the terminal/merchant id (→ `merchantId` column). */
  key: string;
  label: string;
}

export interface ProviderDescriptor {
  key: PaymentProvider;
  label: string;
  merchantIdField: ProviderMerchantField;
  credentialFields: CredentialField[];
  capabilities: ProviderCapabilities;
}

/** Catalog shape returned by GET /api/payments/providers (metadata only). */
export type ProviderCatalogEntry = ProviderDescriptor;
