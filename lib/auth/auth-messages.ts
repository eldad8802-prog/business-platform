/**
 * The words every identity screen shows — login, signup, email verification and password reset — in
 * one place. Routes answer with `{ error, code }`: `error` is what the person reads (the clients
 * render it as is), `code` is what a client branches on. Nothing here names whether an address has
 * an account.
 *
 * The text lives in the i18n dictionary (`api.auth.*`, lib/i18n/messages/areas/api.ts). The Hebrew
 * exports below stay for existing callers and tests; routes pass their request translator so an
 * English-interface user reads English. Without a translator every helper answers in Hebrew.
 */
import { apiHe } from "@/lib/i18n/messages/areas/api";
import { interpolate, type Translator } from "@/lib/i18n/translate";

export const AUTH_MESSAGES_HE = apiHe.auth.messages;

export type AuthMessageKey = keyof typeof AUTH_MESSAGES_HE;

/** One identity message in the request's language (Hebrew when no translator is given). */
export function authMessage(key: AuthMessageKey, t?: Translator): string {
  return t ? t(`api.auth.messages.${key}`) : AUTH_MESSAGES_HE[key];
}

/**
 * The temporary sign-in lock, with the time left. Worded about the ADDRESS that was typed, never about
 * an account, and given identically whether or not that address has one.
 */
export function loginLockedMessage(retryAfterMs: number, t?: Translator): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  if (t) {
    const left = minutes === 1 ? t("api.auth.lockOneMinute") : t("api.auth.lockMinutes", { minutes });
    return t("api.auth.loginLocked", { left });
  }
  const left = minutes === 1 ? apiHe.auth.lockOneMinute : interpolate(apiHe.auth.lockMinutes, { minutes });
  return interpolate(apiHe.auth.loginLocked, { left });
}

/** What a link check / consume answers, as the database functions name it. */
export type EmailTokenStatus = "VALID" | "INVALID" | "EXPIRED" | "USED" | "SUPERSEDED";

/** Client-facing code + message for a link that cannot be used (Hebrew when no translator is given). */
export function emailTokenProblem(status: Exclude<EmailTokenStatus, "VALID">, t?: Translator): { code: string; error: string } {
  switch (status) {
    case "EXPIRED":
      return { code: "TOKEN_EXPIRED", error: authMessage("tokenExpired", t) };
    case "USED":
      return { code: "TOKEN_USED", error: authMessage("tokenUsed", t) };
    case "SUPERSEDED":
      return { code: "TOKEN_SUPERSEDED", error: authMessage("tokenSuperseded", t) };
    default:
      return { code: "TOKEN_INVALID", error: authMessage("tokenInvalid", t) };
  }
}
