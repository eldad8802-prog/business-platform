/**
 * CardCom provider — IDENTITY PLACEHOLDER ONLY (I1).
 *
 * CardCom is the ratified first payment provider, but NONE of its integration
 * is implemented yet: no LowProfile/Create, no GetLpResult verification, no
 * webhook parsing, no credentials. This stub exists only so CardCom is a known
 * provider identity in the registry and the type system.
 *
 * It MUST fail clearly if invoked:
 *   - createPaymentLink / getPaymentStatus → throw PaymentProviderError
 *     (NOT_IMPLEMENTED), so no CardCom payment can ever be created or confirmed.
 *   - verifyWebhook → { ok: false } (contract: never throw) — a CardCom webhook
 *     can never authenticate, so nothing can move to PAID.
 *   - parseWebhook → UNKNOWN outcome (contract: never throw) — never matches,
 *     never settles.
 *
 * This is consistent with the Payments Authority Principle: a provider with no
 * verification path may never confirm PAID.
 */

import type { PaymentProvider } from "../../payments.types";
import {
  PaymentProviderError,
  type CreatePaymentLinkInput,
  type CreatePaymentLinkResult,
  type GetPaymentStatusInput,
  type ParsedWebhookEvent,
  type ParseWebhookInput,
  type PaymentProviderAdapter,
  type ProviderPaymentStatus,
  type VerifyWebhookInput,
  type VerifyWebhookResult,
} from "../payment-provider.types";

const CARDCOM_PROVIDER: PaymentProvider = "CARDCOM";
const NOT_IMPLEMENTED = "CARDCOM_NOT_IMPLEMENTED";

export const cardComProvider: PaymentProviderAdapter = {
  provider: CARDCOM_PROVIDER,

  async createPaymentLink(
    _input: CreatePaymentLinkInput
  ): Promise<CreatePaymentLinkResult> {
    throw new PaymentProviderError(
      CARDCOM_PROVIDER,
      NOT_IMPLEMENTED,
      "CardCom integration is not implemented yet (I1 identity placeholder)."
    );
  },

  verifyWebhook(_input: VerifyWebhookInput): VerifyWebhookResult {
    return { ok: false, reason: NOT_IMPLEMENTED };
  },

  parseWebhook(_input: ParseWebhookInput): ParsedWebhookEvent {
    return {
      providerEventId: null,
      eventType: NOT_IMPLEMENTED,
      providerRequestId: null,
      providerTransactionId: null,
      outcome: "UNKNOWN",
      amount: null,
      currency: null,
    };
  },

  async getPaymentStatus(
    _input: GetPaymentStatusInput
  ): Promise<ProviderPaymentStatus> {
    throw new PaymentProviderError(
      CARDCOM_PROVIDER,
      NOT_IMPLEMENTED,
      "CardCom verification is not implemented yet (I1 identity placeholder)."
    );
  },
};
