/**
 * The raw evidence kept on a verified money row (`PaymentTransaction.rawPayload`).
 *
 * Before this module, a row recorded from a webhook kept the callback body and
 * a row recorded by reconciliation kept `{ source, verifiedAt }` — so anything
 * an adapter needed later (SUMIT's customer id, to refund) existed only when
 * the webhook happened to arrive. A payment discovered because its webhook was
 * LOST was therefore recorded correctly and then could never be refunded.
 *
 * Every row the authority writes now carries the same envelope:
 *
 *   {
 *     kind: "verified_payment",
 *     source: "WEBHOOK" | "RECONCILIATION",
 *     callback: <the callback body, or null>,
 *     verification: {               // from the provider's AUTHORITATIVE answer
 *       paymentMethod, providerDocumentIssued, environment, evidence
 *     }
 *   }
 *
 * Readers accept both the envelope and the shapes written before it existed,
 * so historical rows stay interpretable without a data migration.
 */

import type {
  ConnectionEnvironment,
  PaymentMethodKind,
  ProviderPaymentStatus,
} from "./providers/payment-provider.types";

export type VerifiedEvidence = Record<string, string | number | boolean | null>;

export interface VerifiedPaymentEnvelope {
  kind: "verified_payment";
  source: "WEBHOOK" | "RECONCILIATION";
  callback: unknown;
  verifiedAt: string;
  verification: {
    paymentMethod: PaymentMethodKind;
    providerDocumentIssued: boolean | null;
    environment: ConnectionEnvironment;
    evidence: VerifiedEvidence;
  };
}

const PAYMENT_METHODS: ReadonlySet<string> = new Set([
  "CARD",
  "BIT",
  "APPLE_PAY",
  "GOOGLE_PAY",
  "UNKNOWN",
]);

/** Keep only scalar, non-secret-shaped evidence; drop anything else. */
function sanitiseEvidence(evidence: ProviderPaymentStatus["evidence"]): VerifiedEvidence {
  const out: VerifiedEvidence = {};
  if (!evidence || typeof evidence !== "object") return out;
  for (const [key, value] of Object.entries(evidence)) {
    if (/pass|secret|token|key|card|cvv|pan/i.test(key)) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = typeof value === "string" ? value.slice(0, 200) : value;
    }
  }
  return out;
}

export function normalisePaymentMethod(value: unknown): PaymentMethodKind {
  return typeof value === "string" && PAYMENT_METHODS.has(value)
    ? (value as PaymentMethodKind)
    : "UNKNOWN";
}

export function buildVerifiedPaymentEnvelope(input: {
  source: "WEBHOOK" | "RECONCILIATION";
  callback: unknown;
  status: ProviderPaymentStatus;
  environment: ConnectionEnvironment;
  verifiedAt: Date;
}): VerifiedPaymentEnvelope {
  return {
    kind: "verified_payment",
    source: input.source,
    callback: input.source === "WEBHOOK" ? input.callback ?? null : null,
    verifiedAt: input.verifiedAt.toISOString(),
    verification: {
      paymentMethod: normalisePaymentMethod(input.status.paymentMethod),
      providerDocumentIssued:
        typeof input.status.providerDocumentIssued === "boolean"
          ? input.status.providerDocumentIssued
          : null,
      environment: input.environment,
      evidence: sanitiseEvidence(input.status.evidence),
    },
  };
}

function isEnvelope(raw: unknown): raw is VerifiedPaymentEnvelope {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === "verified_payment" &&
    typeof (raw as { verification?: unknown }).verification === "object"
  );
}

/** The provider-verified evidence on a row, or an empty object for legacy rows. */
export function readVerifiedEvidence(raw: unknown): VerifiedEvidence {
  return isEnvelope(raw) ? raw.verification.evidence ?? {} : {};
}

/** The callback body on a row: the envelope's, or (legacy) the row itself. */
export function readCallbackBody(raw: unknown): unknown {
  if (isEnvelope(raw)) return raw.callback;
  return raw;
}

/** How the customer paid, as recorded; UNKNOWN for legacy rows. */
export function readPaymentMethod(raw: unknown): PaymentMethodKind {
  return isEnvelope(raw) ? normalisePaymentMethod(raw.verification.paymentMethod) : "UNKNOWN";
}
