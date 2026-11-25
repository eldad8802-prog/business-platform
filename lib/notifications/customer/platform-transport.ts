/**
 * The PLATFORM WhatsApp transport — how a customer message leaves Dubiz (G1, appointments completion program).
 * SERVER-ONLY.
 *
 * One central number (Dubiz's), the official Meta Cloud API, template messages only. Owner rule: real sending stays
 * IMPOSSIBLE until the owner approves it — the mode is `simulate` unless ALL of these hold:
 *   WHATSAPP_PLATFORM_SEND_MODE=live
 *   WHATSAPP_PLATFORM_PHONE_NUMBER_ID  (the central number's phone_number_id)
 *   WHATSAPP_PLATFORM_ACCESS_TOKEN     (a system-user token of the platform's WhatsApp Business Account)
 * Any other value, or a missing credential, is `simulate`: nothing leaves the server, the row is recorded SENT with a
 * provider id `sim:<uuid>` (so the whole pipeline — one row per message, metering, status updates — is exercised).
 * `live` with a credential missing is reported as `live_misconfigured` and still simulates (fail safe: never a send
 * with half a configuration). Tests use simulate only and never make a network call.
 *
 * Never logs the token, the recipient, the parameters or the text.
 */
import { randomUUID } from "node:crypto";

import { sendWhatsAppTemplate, type SendTemplateResult } from "@/lib/services/integrations/whatsapp/graph.service";

export type PlatformSendMode = "simulate" | "live";

export type PlatformConfig =
  | { mode: "simulate"; reason: "default" | "live_misconfigured"; phoneNumberId: string | null }
  | { mode: "live"; phoneNumberId: string; accessToken: string };

type Env = Record<string, string | undefined>;

export function platformConfig(env: Env = process.env): PlatformConfig {
  const wanted = env.WHATSAPP_PLATFORM_SEND_MODE?.trim().toLowerCase();
  const phoneNumberId = env.WHATSAPP_PLATFORM_PHONE_NUMBER_ID?.trim() || null;
  const accessToken = env.WHATSAPP_PLATFORM_ACCESS_TOKEN?.trim() || null;
  if (wanted !== "live") return { mode: "simulate", reason: "default", phoneNumberId };
  if (!phoneNumberId || !accessToken || !/^[0-9]{5,30}$/.test(phoneNumberId)) {
    return { mode: "simulate", reason: "live_misconfigured", phoneNumberId };
  }
  return { mode: "live", phoneNumberId, accessToken };
}

/**
 * The platform's phone_number_id as the status webhook knows it — set whenever the env names one (in simulate mode
 * too, so a status Meta sends for the central number is never routed to a business's Inbox).
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
};

export type TransportResult =
  | { kind: "sent"; providerMessageId: string; simulated: boolean }
  | { kind: "transient"; code: string }
  | { kind: "permanent"; code: string };

export type TransportDeps = {
  env?: Env;
  /** Test seam for the live path (never used by the tests to reach the network: they stay in simulate). */
  send?: (input: Parameters<typeof sendWhatsAppTemplate>[0]) => Promise<SendTemplateResult>;
};

export async function sendPlatformTemplate(msg: TemplateMessage, deps: TransportDeps = {}): Promise<TransportResult> {
  const cfg = platformConfig(deps.env ?? process.env);
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
  });
  if (r.ok) return { kind: "sent", providerMessageId: r.providerMessageId, simulated: false };
  // An auth failure is the platform's configuration, not this message: retried (with backoff, bounded) so a fixed
  // token still delivers what is not yet expired.
  if (r.kind === "transient" || r.kind === "auth") return { kind: "transient", code: r.code };
  return { kind: "permanent", code: r.code };
}
