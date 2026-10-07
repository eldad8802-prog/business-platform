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
  parseWelcomePayload,
  renderWelcome,
  type RenderedEmail,
  type WelcomePayload,
} from "./templates/welcome";

/** Resend keeps an Idempotency-Key for 24 hours. No kind may outlive it. */
export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RenderContext = { appBaseUrl: string };

export type EmailKindSpec<P> = {
  ttlMs: number;
  parse: (payload: unknown) => P | null;
  render: (payload: P, ctx: RenderContext) => RenderedEmail;
};

export const WELCOME_TTL_MS = 24 * 60 * 60 * 1000;

export const EMAIL_KINDS = {
  WELCOME: {
    ttlMs: WELCOME_TTL_MS,
    parse: parseWelcomePayload,
    render: renderWelcome,
  } satisfies EmailKindSpec<WelcomePayload>,
} as const;

export type EmailKind = keyof typeof EMAIL_KINDS;

export function isEmailKind(value: string): value is EmailKind {
  return Object.prototype.hasOwnProperty.call(EMAIL_KINDS, value);
}

/** One WELCOME per user, ever: a signup creates the user, so its id names the act. */
export function welcomeDedupeKey(userId: number): string {
  return `welcome:user:${userId}`;
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
