/**
 * Inbound email document ingestion — the one server-side switch.
 *
 * Flag: `INBOUND_EMAIL_ENABLED`
 *   - `"true"`  -> the feature is on
 *   - anything else, INCLUDING UNSET -> the feature is off
 *
 * The default is OFF, and "off" is what a missing, empty, mistyped or
 * differently-cased value means. This follows the same fail-closed convention
 * as `PUBLIC_SIGNUP_ENABLED` in `lib/auth/signup-gate.ts`: a flag that opens a
 * new external ingress path must never be opened by accident, and the most
 * likely accident is an env var that was never set in one environment.
 *
 * No `NEXT_PUBLIC_` prefix, deliberately. This is read on the server only, so
 * it cannot be flipped from a browser. Server components resolve it and pass
 * the boolean down.
 *
 * # Why the domain lives behind the same gate
 *
 * An inbound address is meaningless without the domain it belongs to, and a
 * wrong domain would mint addresses that can never receive mail. So the domain
 * is required rather than defaulted: there is no sensible fallback for "which
 * domain is ours", and guessing one would produce addresses that look valid
 * and silently never work.
 */

/** True only when inbound email is explicitly enabled. */
export function isInboundEmailEnabled(): boolean {
  return process.env.INBOUND_EMAIL_ENABLED === "true";
}

export type InboundEmailDiagnostics = {
  flagRaw: string | undefined;
  enabled: boolean;
  domainConfigured: boolean;
  reasonIfDisabled: string;
};

/** Non-secret diagnostics. Safe to log; never returned to a client. */
export function getInboundEmailDiagnostics(): InboundEmailDiagnostics {
  const raw = process.env.INBOUND_EMAIL_ENABLED;
  const enabled = raw === "true";
  const domain = process.env.INBOUND_EMAIL_DOMAIN?.trim();
  return {
    flagRaw: raw,
    enabled,
    domainConfigured: Boolean(domain),
    reasonIfDisabled: enabled
      ? "ok"
      : `INBOUND_EMAIL_ENABLED is not "true" (got: ${
          raw === undefined ? "undefined" : JSON.stringify(raw)
        })`,
  };
}

/** Thrown when the feature is used without being configured. */
export class InboundEmailNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundEmailNotConfiguredError";
  }
}

/**
 * The domain inbound addresses belong to, e.g. `in.example.com`.
 *
 * Throws rather than defaulting. A default here would be a silent misroute.
 */
export function requireInboundEmailDomain(): string {
  const domain = process.env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!domain) {
    throw new InboundEmailNotConfiguredError(
      "INBOUND_EMAIL_DOMAIN is not set. Inbound email cannot mint or resolve addresses without it."
    );
  }
  return domain;
}

/**
 * Single gate every future consumer must pass through: the flag AND the
 * domain. Returns the domain so a caller cannot check the flag and then forget
 * to resolve the domain.
 */
export function requireInboundEmailEnabled(): { domain: string } {
  if (!isInboundEmailEnabled()) {
    throw new InboundEmailNotConfiguredError(
      "Inbound email is disabled. Set INBOUND_EMAIL_ENABLED=true to enable it."
    );
  }
  return { domain: requireInboundEmailDomain() };
}
