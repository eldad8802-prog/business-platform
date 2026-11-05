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
 *       paymentMethod, providerDocumentIssued, environment, evidence,
 *       providerDocument?            // ONLY on a foreign-currency request of a
 *     }                              // PROVIDER_ISSUES connection: the verified
 *   }                                // document, or null when none was stated
 *
 * Readers accept both the envelope and the shapes written before it existed,
 * so historical rows stay interpretable without a data migration.
 */

import type {
  ConnectionEnvironment,
  PaymentMethodKind,
  ProviderIssuedDocument,
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
    /**
     * Present ONLY when the recording path checked for the provider's own
     * document (a foreign-currency request on a PROVIDER_ISSUES connection):
     * the verified document, or null when the provider stated none. Absent on
     * every other row, so an ILS row is written exactly as before.
     */
    providerDocument?: ProviderIssuedDocument | null;
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

/**
 * A provider-issued document only in its exact, displayable shape: digits for
 * the number, a short name for the type, an https link or null. Anything else
 * is no document — so nothing an adapter returns can reach a screen unchecked.
 */
export function verifiedProviderDocument(value: unknown): ProviderIssuedDocument | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { number?: unknown; type?: unknown; url?: unknown };
  const number = typeof v.number === "string" ? v.number.trim() : "";
  const type = typeof v.type === "string" ? v.type.trim() : "";
  if (!/^\d{1,20}$/.test(number) || /^0+$/.test(number)) return null;
  if (!/^[A-Za-z0-9]{1,64}$/.test(type)) return null;
  let url: string | null = null;
  if (typeof v.url === "string" && v.url.trim() !== "") {
    try {
      const u = new URL(v.url.trim());
      url = u.protocol === "https:" && u.username === "" && u.password === "" ? u.toString() : null;
    } catch {
      url = null;
    }
  }
  return { number, type, url };
}

export function buildVerifiedPaymentEnvelope(input: {
  source: "WEBHOOK" | "RECONCILIATION";
  callback: unknown;
  status: ProviderPaymentStatus;
  environment: ConnectionEnvironment;
  verifiedAt: Date;
  /** Only when the document was checked: the verified document or null. */
  providerDocument?: ProviderIssuedDocument | null;
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
      ...(input.providerDocument !== undefined
        ? { providerDocument: input.providerDocument === null ? null : verifiedProviderDocument(input.providerDocument) }
        : {}),
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

/**
 * The provider-issued document recorded on a row:
 *   a document → the provider stated it (verified shape)
 *   null       → it was checked and the provider stated none
 *   undefined  → it was never checked (every ILS row, every legacy row)
 */
export function readProviderDocument(raw: unknown): ProviderIssuedDocument | null | undefined {
  if (!isEnvelope(raw)) return undefined;
  const verification = raw.verification as { providerDocument?: unknown };
  if (!("providerDocument" in verification)) return undefined;
  return verification.providerDocument == null ? null : verifiedProviderDocument(verification.providerDocument);
}

/** How the customer paid, as recorded; UNKNOWN for legacy rows. */
export function readPaymentMethod(raw: unknown): PaymentMethodKind {
  return isEnvelope(raw) ? normalisePaymentMethod(raw.verification.paymentMethod) : "UNKNOWN";
}
