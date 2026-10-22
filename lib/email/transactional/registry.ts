/**
 * The kinds of transactional email Dubiz sends. A new kind is an entry here — never a migration:
 * the table stores `kind` as validated text (`^[A-Z][A-Z0-9_]{1,63}$`) and its parameters as a
 * JSON object captured at enqueue.
 *
 * Each kind declares:
 *   ttlMs        how long after enqueue the email may still be sent. Past it the row is EXPIRED,
 *                never sent. It must not exceed the provider's idempotency window (24h at Resend),
 *                so every retry of a row is still covered by the same idempotency key.
 *   dedupeKey    the stable idempotency key of the act that owes the email.
 *   parse/render the payload contract and the rendering. An unparseable payload is a permanent
 *                failure — retrying cannot fix it.
 */

import {
  parseAccountLinkPayload,
  renderEmailVerify,
  renderPasswordReset,
  type AccountLinkPayload,
} from "./templates/account-links";
import {
  parseWelcomePayload,
  renderWelcome,
  type RenderedEmail,
  type WelcomePayload,
} from "./templates/welcome";

/** Resend keeps an Idempotency-Key for 24 hours. No kind may outlive it. */
export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * `locale`: the row's stored TransactionalEmail.locale. "en" renders English (LTR); anything else — absent,
 * "he", an unknown value — renders Hebrew, exactly as before.
 */
export type RenderContext = { appBaseUrl: string; locale?: string | null };

export type EmailKindSpec<P> = {
  ttlMs: number;
  parse: (payload: unknown) => P | null;
  render: (payload: P, ctx: RenderContext) => RenderedEmail;
};

export const WELCOME_TTL_MS = 24 * 60 * 60 * 1000;
/** A verification link lives 24h; an email that cannot go out within 12h is better re-requested. */
export const EMAIL_VERIFY_TTL_MS = 12 * 60 * 60 * 1000;
/** A reset link lives 1h: an email that cannot go out within it carries a dead link. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export const EMAIL_KINDS = {
  WELCOME: {
    ttlMs: WELCOME_TTL_MS,
    parse: parseWelcomePayload,
    render: renderWelcome,
  } satisfies EmailKindSpec<WelcomePayload>,
  EMAIL_VERIFY: {
    ttlMs: EMAIL_VERIFY_TTL_MS,
    parse: parseAccountLinkPayload,
    render: renderEmailVerify,
  } satisfies EmailKindSpec<AccountLinkPayload>,
  PASSWORD_RESET: {
    ttlMs: PASSWORD_RESET_TTL_MS,
    parse: parseAccountLinkPayload,
    render: renderPasswordReset,
  } satisfies EmailKindSpec<AccountLinkPayload>,
} as const;

export type EmailKind = keyof typeof EMAIL_KINDS;

export function isEmailKind(value: string): value is EmailKind {
  return Object.prototype.hasOwnProperty.call(EMAIL_KINDS, value);
}

/** One WELCOME per user, ever: a signup creates the user, so its id names the act. */
export function welcomeDedupeKey(userId: number): string {
  return `welcome:user:${userId}`;
}

/** One email per issued link: the token id names the act (a re-request mints a new token). */
export function accountLinkDedupeKey(kind: "EMAIL_VERIFY" | "PASSWORD_RESET", tokenId: string): string {
  return `${kind === "EMAIL_VERIFY" ? "email_verify" : "password_reset"}:token:${tokenId}`;
}

/** Renders a stored row's payload, or null when the kind is unknown or the payload invalid. */
export function renderStored(
  kind: string,
  payload: unknown,
  ctx: RenderContext
): RenderedEmail | null {
  if (!isEmailKind(kind)) return null;
  const spec = EMAIL_KINDS[kind] as EmailKindSpec<unknown>;
  const parsed = spec.parse(payload);
  if (parsed === null) return null;
  return spec.render(parsed, ctx);
}
