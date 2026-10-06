/**
 * Send-certainty model for POST /Invoices/v2/Approval.
 *
 * Invariant: Dubiz never re-sends an Approval request unless it can PROVE the
 * previous one was not transmitted to the authority.
 *
 *   NOT_SENT        — provably never left Dubiz (config/pre-send failure, or a
 *                     transport failure that can only happen before the request
 *                     is written: TCP refused, DNS, proxy CONNECT refused, TLS
 *                     handshake/certificate rejection). Persisted as FAILED with
 *                     an AUTHORITY_NOT_SENT_* code; the only re-executable state.
 *   POSSIBLY_SENT   — everything else without a definitive provider answer.
 *                     The submission stays SUBMITTED (never executable) and is
 *                     marked with an AUTHORITY_OUTCOME_UNCERTAIN_* code. No
 *                     automatic or user-triggered re-POST; resolution is manual.
 *
 * No provider reconciliation endpoint is assumed: none is proven safe.
 * Pure — no I/O.
 */

export type SendCertainty = "NOT_SENT" | "POSSIBLY_SENT";

export const AUTHORITY_NOT_SENT_PREFIX = "AUTHORITY_NOT_SENT_" as const;
export const AUTHORITY_OUTCOME_UNCERTAIN_PREFIX = "AUTHORITY_OUTCOME_UNCERTAIN_" as const;

export type AuthorityNotSentReason =
  | "CONFIGURATION"
  | "NETWORK"
  | "LOCAL_VALIDATION";

export type AuthorityOutcomeUncertainReason =
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER"
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "UNEXPECTED_STATUS"
  | "MALFORMED_RESPONSE"
  | "NOT_ACCEPTABLE"
  | "NOT_APPROVED_AMBIGUOUS"
  | "APPROVED_NO_CONFIRMATION"
  | "APPROVED_PERSIST_FAILED"
  | "DECISION_ALREADY_REPORTED"
  | "UNKNOWN";

export function buildAuthorityNotSentErrorCode(reason: AuthorityNotSentReason): string {
  return `${AUTHORITY_NOT_SENT_PREFIX}${reason}`;
}

export function buildAuthorityOutcomeUncertainErrorCode(
  reason: AuthorityOutcomeUncertainReason
): string {
  return `${AUTHORITY_OUTCOME_UNCERTAIN_PREFIX}${reason}`;
}

/** A FAILED submission is re-executable ONLY when its failure is provably not-sent. */
export function isAuthorityNotSentErrorCode(errorCode: string | null | undefined): boolean {
  return typeof errorCode === "string" && errorCode.startsWith(AUTHORITY_NOT_SENT_PREFIX);
}

export function isAuthorityOutcomeUncertainErrorCode(
  errorCode: string | null | undefined
): boolean {
  return (
    typeof errorCode === "string" &&
    errorCode.startsWith(AUTHORITY_OUTCOME_UNCERTAIN_PREFIX)
  );
}

/**
 * Transport error codes that can only be raised while establishing the
 * connection (TCP → proxy TLS → CONNECT tunnel → ITA TLS handshake), i.e.
 * before any request byte is written. Allowlist: anything not listed here is
 * POSSIBLY_SENT. ECONNRESET / UND_ERR_SOCKET / timeouts are deliberately absent:
 * they can occur after the request was written.
 */
const NOT_SENT_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  // TLS to the egress proxy failed (undici SecureProxyConnectionError).
  "UND_ERR_PRX_TLS",
  // Egress fail-fast remap of a tunnel *connect* failure (billing-authority-egress.ts).
  "ITA_EGRESS_TUNNEL_CLOSED",
  // Certificate rejection during a TLS handshake (no application data yet).
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** undici ProxyAgent: the proxy answered the CONNECT with a non-200 status. */
const PROXY_TUNNEL_REFUSED_MESSAGE = /^Proxy response \(\d{3}\) !== 200 when HTTP Tunneling$/;

/** Codes collected along an error's `cause` chain (bounded depth). */
export function collectTransportErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

function causeChainHasProxyTunnelRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    const message = (current as { message?: unknown }).message;
    const code = (current as { code?: unknown }).code;
    if (
      code === "UND_ERR_ABORTED" &&
      typeof message === "string" &&
      PROXY_TUNNEL_REFUSED_MESSAGE.test(message)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export type TransportFailureAssessment = {
  sendCertainty: SendCertainty;
  /** First allowlisted code that proved NOT_SENT, else the first code seen (diagnostic only). */
  transportCode: string | null;
};

/**
 * Classifies a thrown transport failure (fetch rejected). Never inspects
 * messages except the single undici proxy-tunnel refusal shape.
 */
export function assessTransportFailure(error: unknown): TransportFailureAssessment {
  const codes = collectTransportErrorCodes(error);
  const provingCode = codes.find((code) => NOT_SENT_TRANSPORT_CODES.has(code));
  if (provingCode) return { sendCertainty: "NOT_SENT", transportCode: provingCode };
  if (causeChainHasProxyTunnelRefusal(error)) {
    return { sendCertainty: "NOT_SENT", transportCode: "PROXY_TUNNEL_REFUSED" };
  }
  return { sendCertainty: "POSSIBLY_SENT", transportCode: codes[0] ?? null };
}

/** Diagnostic codes are only persisted if they look like codes (no free text). */
export function sanitizeTransportCode(code: string | null | undefined): string | null {
  if (typeof code !== "string") return null;
  return /^[A-Z0-9_]{2,64}$/.test(code) ? code : null;
}
