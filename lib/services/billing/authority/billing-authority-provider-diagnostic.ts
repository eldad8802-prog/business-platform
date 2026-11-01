/**
 * Sanitized diagnostics from an undocumented authority HTTP error (401/403/…),
 * so a gateway rejection can be explained without a resend.
 *
 * Kept: the gateway transaction id header, the OAuth `error` code from
 * WWW-Authenticate, and the gateway's short text (httpMessage / moreInformation).
 * Every field is allowlisted and length-bounded; anything token-like is dropped.
 * Never kept: the body as a whole, any other header, tokens, payload values.
 */

export type ProviderDiagnostic = {
  transactionId: string | null;
  authError: string | null;
  gatewayMessage: string | null;
};

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SAFE_AUTH_ERROR = /^[a-z_]{1,40}$/;
const SAFE_TEXT = /^[A-Za-z0-9 .,:;'()/_-]{1,160}$/;
/** A long unbroken run looks like a token/hash — never keep it in free text. */
const TOKEN_LIKE = /[A-Za-z0-9_\-+/=]{32,}/;

export function sanitizeProviderId(value: unknown): string | null {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

export function sanitizeProviderAuthError(value: unknown): string | null {
  return typeof value === "string" && SAFE_AUTH_ERROR.test(value) ? value : null;
}

export function sanitizeProviderText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().slice(0, 160);
  return SAFE_TEXT.test(text) && !TOKEN_LIKE.test(text) ? text : null;
}

/** `Bearer realm="x", error="insufficient_scope"` → "insufficient_scope". */
export function parseWwwAuthenticateError(header: string | null): string | null {
  if (!header) return null;
  // The whole value must match — a prefix of something longer is never kept.
  const match = /\berror=(?:"([a-z_]{1,40})"|([a-z_]{1,40})(?=[\s,]|$))/i.exec(header);
  const value = match?.[1] ?? match?.[2];
  return value ? sanitizeProviderAuthError(value.toLowerCase()) : null;
}

export function extractProviderDiagnostic(
  headers: Pick<Headers, "get"> | null | undefined,
  body: unknown
): ProviderDiagnostic | null {
  const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const diagnostic: ProviderDiagnostic = {
    transactionId: sanitizeProviderId(headers?.get("x-global-transaction-id")),
    authError: parseWwwAuthenticateError(headers?.get("www-authenticate") ?? null),
    gatewayMessage:
      sanitizeProviderText(rec.moreInformation) ?? sanitizeProviderText(rec.httpMessage),
  };
  return diagnostic.transactionId || diagnostic.authError || diagnostic.gatewayMessage
    ? diagnostic
    : null;
}

/** Re-sanitizes for audit metadata (defense in depth). */
export function providerDiagnosticMetadata(
  diagnostic: ProviderDiagnostic | null | undefined
): Record<string, string | null> {
  return {
    providerTransactionId: sanitizeProviderId(diagnostic?.transactionId),
    providerAuthError: sanitizeProviderAuthError(diagnostic?.authError),
    providerGatewayMessage: sanitizeProviderText(diagnostic?.gatewayMessage),
  };
}
