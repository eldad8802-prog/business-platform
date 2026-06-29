/**
 * Payment provider connection management.
 *
 * Connecting a provider stores the merchant credential ENCRYPTED at rest. The
 * plaintext secret is never persisted and never returned — every public output
 * goes through `toPublicConnection`, which strips all credential material.
 *
 * Depends only on the `PaymentStore` port and an injected credential encryptor,
 * so it is unit-testable without a database or the real crypto key.
 */

import { ValidationError } from "@/lib/errors";
import type { EncryptedCredentialMaterial } from "./payment-crypto.service";
import type {
  PaymentConnectionRecord,
  PaymentProvider,
  PaymentStore,
  PublicPaymentConnection,
} from "./payments.types";
import { recordPaymentAuditEvent } from "./payment-audit.service";

export interface ConnectProviderInput {
  businessId: number;
  provider?: PaymentProvider;
  merchantId: string;
  /** Plaintext provider credential. Encrypted before storage, never returned. */
  credential: string;
  isActive?: boolean;
  /** Authenticated user who connected the provider (for the audit trail). */
  actorUserId?: number | null;
}

export interface PaymentConnectionDeps {
  store: PaymentStore;
  encryptCredential: (
    plaintext: string,
    businessId: number,
    provider: PaymentProvider
  ) => EncryptedCredentialMaterial;
}

const DEFAULT_PROVIDER: PaymentProvider = "TRANZILA";

export function toPublicConnection(
  record: PaymentConnectionRecord
): PublicPaymentConnection {
  return {
    id: record.id,
    businessId: record.businessId,
    provider: record.provider,
    merchantId: record.merchantId,
    isActive: record.isActive,
    hasCredential: record.credentialEncrypted != null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function assertPositiveInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
}

export async function connectPaymentProvider(
  input: ConnectProviderInput,
  deps: PaymentConnectionDeps
): Promise<PublicPaymentConnection> {
  assertPositiveInt(input.businessId, "businessId");

  const provider = input.provider ?? DEFAULT_PROVIDER;
  const merchantId = (input.merchantId ?? "").trim();
  if (!merchantId) {
    throw new ValidationError("merchantId is required");
  }
  if (typeof input.credential !== "string" || input.credential.length === 0) {
    throw new ValidationError("credential is required");
  }

  const encrypted = deps.encryptCredential(
    input.credential,
    input.businessId,
    provider
  );

  const saved = await deps.store.upsertConnection({
    businessId: input.businessId,
    provider,
    merchantId,
    credentialEncrypted: encrypted.credentialEncrypted,
    credentialIv: encrypted.credentialIv,
    credentialTag: encrypted.credentialTag,
    encryptionKeyId: encrypted.encryptionKeyId,
    isActive: input.isActive ?? true,
  });

  // audit the connection change. NEVER record credential material — only the
  // non-secret shape (provider, merchant id, active flag).
  await recordPaymentAuditEvent(deps.store, {
    businessId: input.businessId,
    actorUserId: input.actorUserId ?? null,
    eventType: "PAYMENT_CONNECTION_UPSERTED",
    source: input.actorUserId != null ? "USER" : "SYSTEM",
    summary: `Payment provider ${provider} connection ${saved.id} saved`,
    metadata: {
      provider,
      merchantId,
      isActive: saved.isActive,
    },
  });

  return toPublicConnection(saved);
}

export async function listPaymentConnections(
  businessId: number,
  deps: PaymentConnectionDeps
): Promise<PublicPaymentConnection[]> {
  assertPositiveInt(businessId, "businessId");
  const records = await deps.store.listConnections(businessId);
  return records.map(toPublicConnection);
}
