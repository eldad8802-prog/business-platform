/**
 * The PLATFORM WhatsApp transport — how a customer message leaves Dubiz (G1, appointments completion program).
 * SERVER-ONLY.
 *
 * One central number (Dubiz's), the official Meta Cloud API, template messages only. WHATSAPP_PLATFORM_SEND_MODE:
 *   off       HARD STOP (the documented WhatsApp emergency control, owner item 8): nothing is sent, nothing is
 *             simulated; the worker's lane DEFERS every owed message (error 'send_stopped', re-checked every 10
 *             minutes, never past its own expiry — so nothing is lost while it can still be useful, and nothing is
 *             duplicated: a deferred row is the same row) and the verification API refuses ('send_stopped'). It stops
 *             customer WhatsApp ONLY — every other notification keeps working (unlike notifications_engine OFF).
 *   live      real sends — only with WHATSAPP_PLATFORM_PHONE_NUMBER_ID and WHATSAPP_PLATFORM_ACCESS_TOKEN;
 *   anything else / unset: simulate (the default) — nothing leaves the server, the row is recorded SENT with a
 *             provider id `sim:<uuid>`. `live` with a credential missing is reported as `live_misconfigured` and still
 *             simulates (fail safe: never a send with half a configuration). Tests use simulate only.
 * Read per call (never cached at module load), like every other env switch in this codebase.
 *
 * How fast `off` takes effect: an env change on Vercel applies to NEW deployments, so it needs a redeploy (minutes).
 * There is no DB-backed switch for customer WhatsApp alone: the platform emergency switches are per feature key
 * (PlatformFeaturePolicy.emergencyDisabled, immediate) and the nearest keys stop more than WhatsApp — `public_booking`
 * also closes the public link, `notifications_engine` stops every push. A dedicated key would need a new
 * PlatformFeatureDefinition row (a data migration), which is out of scope (one migration package). Those two remain
 * additional, immediate stops: the customer-message gate requires both (customer-entitlement.ts).
 *
 * Never logs the token, the recipient, the parameters or the text.
 */
import { randomUUID } from "node:crypto";

import { sendWhatsAppTemplate, type SendTemplateResult } from "@/lib/services/integrations/whatsapp/graph.service";

export type PlatformSendMode = "off" | "simulate" | "live";

export type PlatformConfig =
  | { mode: "off"; phoneNumberId: string | null }
  | { mode: "simulate"; reason: "default" | "live_misconfigured"; phoneNumberId: string | null }
  | { mode: "live"; phoneNumberId: string; accessToken: string };

type Env = Record<string, string | undefined>;

export function platformConfig(env: Env = process.env): PlatformConfig {
  const wanted = env.WHATSAPP_PLATFORM_SEND_MODE?.trim().toLowerCase();
  const phoneNumberId = env.WHATSAPP_PLATFORM_PHONE_NUMBER_ID?.trim() || null;
  const accessToken = env.WHATSAPP_PLATFORM_ACCESS_TOKEN?.trim() || null;
  if (wanted === "off") return { mode: "off", phoneNumberId };
  if (wanted !== "live") return { mode: "simulate", reason: "default", phoneNumberId };
  if (!phoneNumberId || !accessToken || !/^[0-9]{5,30}$/.test(phoneNumberId)) {
    return { mode: "simulate", reason: "live_misconfigured", phoneNumberId };
  }
  return { mode: "live", phoneNumberId, accessToken };
}

/** Is customer WhatsApp hard-stopped (WHATSAPP_PLATFORM_SEND_MODE=off)? */
export function platformSendStopped(env: Env = process.env): boolean {
  return platformConfig(env).mode === "off";
}

/**
 * The platform's phone_number_id as the status webhook knows it — set whenever the env names one (in every mode, so a
 * status Meta sends for the central number is never routed to a business's Inbox).
 */
export function platformPhoneNumberId(env: Env = process.env): string | null {
  const id = env.WHATSAPP_PLATFORM_PHONE_NUMBER_ID?.trim();
  return id && /^[0-9]{5,30}$/.test(id) ? id : null;
}

export const SIMULATED_PREFIX = "sim:";

export type TemplateMessage = {
  /** E.164 (+972…). */
  toPhone: string;
  templateName: string;
  languageCode: string;
  bodyParams: readonly string[];
  /** AUTHENTICATION templates: the code for Meta's copy-code button. */
  otpButtonCode?: string;
  /** Echoed by Meta in this message's status webhooks (the attempt's fence — whatsapp-worker.ts). */
  callbackData?: string;
  /** Aborts the request before the caller's lease ends. */
  signal?: AbortSignal;
};

export type TransportResult =
  | { kind: "sent"; providerMessageId: string; simulated: boolean }
  /** Meta answered and did NOT accept it: safe to retry. */
  | { kind: "transient"; code: string }
  | { kind: "permanent"; code: string }
  /** Meta MAY have accepted it (5xx, timeout, abort, network): never resent blindly. */
  | { kind: "uncertain"; code: string }
  /** WHATSAPP_PLATFORM_SEND_MODE=off: nothing was attempted. */
  | { kind: "stopped" };

export type TransportDeps = {
  env?: Env;
  /** Test seam for the live path (never used by the tests to reach the network: they stay in simulate or a fake). */
  send?: (input: Parameters<typeof sendWhatsAppTemplate>[0]) => Promise<SendTemplateResult>;
};

export async function sendPlatformTemplate(msg: TemplateMessage, deps: TransportDeps = {}): Promise<TransportResult> {
  const cfg = platformConfig(deps.env ?? process.env);
  if (cfg.mode === "off") return { kind: "stopped" };
  if (cfg.mode === "simulate") {
    return { kind: "sent", providerMessageId: `${SIMULATED_PREFIX}${randomUUID()}`, simulated: true };
  }
  const send = deps.send ?? sendWhatsAppTemplate;
  const r = await send({
    phoneNumberId: cfg.phoneNumberId,
    accessToken: cfg.accessToken,
    toPhone: msg.toPhone,
    templateName: msg.templateName,
    languageCode: msg.languageCode,
    bodyParams: msg.bodyParams,
    ...(msg.otpButtonCode ? { otpButtonCode: msg.otpButtonCode } : {}),
    ...(msg.callbackData ? { callbackData: msg.callbackData } : {}),
    ...(msg.signal ? { signal: msg.signal } : {}),
  });
  if (r.ok) return { kind: "sent", providerMessageId: r.providerMessageId, simulated: false };
  if (r.kind === "uncertain") return { kind: "uncertain", code: r.code };
  // An auth failure is the platform's configuration, not this message (Meta answered: not accepted): retried with
  // backoff, bounded, so a fixed token still delivers what is not yet expired.
  if (r.kind === "transient" || r.kind === "auth") return { kind: "transient", code: r.code };
  return { kind: "permanent", code: r.code };
}
