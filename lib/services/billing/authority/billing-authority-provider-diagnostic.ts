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

/**
 * Documented 400 validation errors (`message.errors[]`): code, field, location and a
 * short message, so a rejection can be explained without a resend. Bounded to
 * the first PROVIDER_VALIDATION_ERRORS_MAX entries. Messages may be Hebrew;
 * digit runs ≥ 5 (dealer / id numbers) are masked, and a message with any other
 * character (e.g. `@`, quotes, URLs) or a token-like run is dropped entirely.
 */
export type ProviderValidationError = {
  code: number | null;
  param: string | null;
  location: string | null;
  message: string | null;
};

export const PROVIDER_VALIDATION_ERRORS_MAX = 10;
const SAFE_PARAM = /^[A-Za-z_][A-Za-z0-9_.[\]]{0,63}$/;
const SAFE_LOCATION = /^[a-z_]{1,20}$/;
const SAFE_MESSAGE = /^[A-Za-z0-9א-ת .,:;'()/_#-]{1,160}$/;

export function sanitizeProviderMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().slice(0, 160).replace(/\d{5,}/g, "#");
  return SAFE_MESSAGE.test(text) && !TOKEN_LIKE.test(text) ? text : null;
}

export function sanitizeProviderValidationErrors(errors: unknown): ProviderValidationError[] {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, PROVIDER_VALIDATION_ERRORS_MAX).map((raw) => {
    const e = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const code = typeof e.code === "number" && Number.isInteger(e.code) && e.code > 0 && e.code < 100_000 ? e.code : null;
    const location = typeof e.location === "string" ? e.location.toLowerCase() : null;
    return {
      code,
      param: typeof e.param === "string" && SAFE_PARAM.test(e.param) ? e.param : null,
      location: location && SAFE_LOCATION.test(location) ? location : null,
      message: sanitizeProviderMessage(e.message),
    };
  });
}

/** Audit metadata for a documented 400 rejection (re-sanitized, defense in depth). */
export function providerValidationMetadata(
  errors: unknown,
  transactionId: unknown
): Record<string, unknown> {
  return {
    providerValidationErrors: sanitizeProviderValidationErrors(errors),
    providerValidationErrorCount: Array.isArray(errors) ? errors.length : 0,
    providerTransactionId: sanitizeProviderId(transactionId),
  };
}
