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
import { getProviderDescriptor } from "./providers/provider-registry";

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

export interface ConnectProviderFromFieldsInput {
  businessId: number;
  /** Raw provider key from the request; validated against the registry. */
  provider: string;
  /**
   * All submitted values, keyed by descriptor field keys — the merchant-id
   * field (or a `merchantId` fallback) plus the credential fields. The
   * descriptor decides which keys are consumed; extra keys are ignored.
   */
  fields: Record<string, unknown>;
  isActive?: boolean;
  actorUserId?: number | null;
}

/**
 * Descriptor-driven connect: validates the provider + fields against its
 * ProviderDescriptor, builds the encrypted credential blob (JSON of the
 * credentialFields), then delegates to connectPaymentProvider. This is the
 * single code path for the generic connection route AND the backward-compatible
 * per-provider wrappers, so all providers store an identical JSON credential.
 */
export async function connectProviderFromDescriptor(
  input: ConnectProviderFromFieldsInput,
  deps: PaymentConnectionDeps
): Promise<PublicPaymentConnection> {
  const descriptor = getProviderDescriptor(input.provider);
  if (!descriptor) {
    throw new ValidationError(
      `Unknown payment provider: ${String(input.provider)}`
    );
  }

  const merchantRaw =
    input.fields[descriptor.merchantIdField.key] ?? input.fields.merchantId;
  const merchantId = (typeof merchantRaw === "string" ? merchantRaw : "").trim();
  if (!merchantId) {
    throw new ValidationError(`${descriptor.merchantIdField.label} is required`);
  }

  const credentialObject: Record<string, string> = {};
  for (const field of descriptor.credentialFields) {
    const raw = input.fields[field.key];
    const value = typeof raw === "string" ? raw : "";
    const normalized = field.type === "secret" ? value : value.trim();
    if (field.required && normalized.length === 0) {
      throw new ValidationError(`${field.label} is required`);
    }
    if (normalized.length > 0) credentialObject[field.key] = normalized;
  }

  return connectPaymentProvider(
    {
      businessId: input.businessId,
      provider: descriptor.key,
      merchantId,
      credential: JSON.stringify(credentialObject),
      isActive: input.isActive,
      actorUserId: input.actorUserId ?? null,
    },
    deps
  );
}

export async function listPaymentConnections(
  businessId: number,
  deps: PaymentConnectionDeps
): Promise<PublicPaymentConnection[]> {
  assertPositiveInt(businessId, "businessId");
  const records = await deps.store.listConnections(businessId);
  return records.map(toPublicConnection);
}
