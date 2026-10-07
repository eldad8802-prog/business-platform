/**
 * Transactional email — configuration, read from the environment at the moment of use.
 *
 * Every address and every switch is configuration; nothing here names a sender, a domain
 * or a key. The contract:
 *
 *   TRANSACTIONAL_EMAIL_ENABLED   exactly "true" turns delivery ON. Unset, "" or "false" is
 *                                 OFF (the default). Any other value is OFF *and* reported as
 *                                 a configuration error — a typo must never send mail, and must
 *                                 never be silently read as a decision either.
 *   RESEND_API_KEY                the provider credential. Required when ON.
 *   TRANSACTIONAL_EMAIL_FROM      the sender, `Name <address>` or a bare address. Required when ON.
 *   TRANSACTIONAL_EMAIL_REPLY_TO  optional reply-to address.
 *   APP_BASE_URL                  the public origin links point at (https). Required when ON.
 *
 * OFF means: rows are still written by the act that owes them (signup), and nothing reads,
 * claims or sends them. No outbound request is ever made while OFF.
 */

export type TransactionalEmailEnv = Record<string, string | undefined>;

export type DeliveryConfig = {
  apiKey: string;
  from: string;
  replyTo: string | null;
  appBaseUrl: string;
};

export type ConfigState =
  | { enabled: false; error: "invalid_enabled_value" | null }
  | { enabled: true; ok: true; config: DeliveryConfig }
  | { enabled: true; ok: false; missing: readonly string[] };

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const NAMED_ADDRESS = /^[^<>"\r\n]{1,80}\s<([^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+)>$/;

/** `Name <a@b.c>` or `a@b.c`. No line breaks (header injection), no quotes. */
export function isValidSender(value: string): boolean {
  return ADDRESS.test(value) || NAMED_ADDRESS.test(value);
}

export function isValidAddress(value: string): boolean {
  return ADDRESS.test(value);
}

/** An origin links can safely point at: https, or http only for localhost. No path, query or hash. */
export function normalizeAppBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

export function readTransactionalEmailConfig(env: TransactionalEmailEnv = process.env): ConfigState {
  const raw = env.TRANSACTIONAL_EMAIL_ENABLED?.trim();
  if (raw === undefined || raw === "" || raw === "false") return { enabled: false, error: null };
  if (raw !== "true") return { enabled: false, error: "invalid_enabled_value" };

  const missing: string[] = [];
  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  if (!apiKey) missing.push("RESEND_API_KEY");
  const from = env.TRANSACTIONAL_EMAIL_FROM?.trim() ?? "";
  if (!isValidSender(from)) missing.push("TRANSACTIONAL_EMAIL_FROM");
  const replyToRaw = env.TRANSACTIONAL_EMAIL_REPLY_TO?.trim() ?? "";
  if (replyToRaw && !isValidAddress(replyToRaw)) missing.push("TRANSACTIONAL_EMAIL_REPLY_TO");
  const appBaseUrl = normalizeAppBaseUrl(env.APP_BASE_URL?.trim() ?? "");
  if (!appBaseUrl) missing.push("APP_BASE_URL");

  if (missing.length > 0) return { enabled: true, ok: false, missing };
  return {
    enabled: true,
    ok: true,
    config: { apiKey, from, replyTo: replyToRaw || null, appBaseUrl: appBaseUrl! },
  };
}

export function isTransactionalEmailEnabled(env: TransactionalEmailEnv = process.env): boolean {
  return readTransactionalEmailConfig(env).enabled;
}
