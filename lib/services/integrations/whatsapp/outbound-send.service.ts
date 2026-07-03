/**
 * Outbound WhatsApp text — orchestration (Stage 1 MVP, text only).
 *
 * Composes existing infrastructure, adds NO new provider and NO new state:
 *   1. `getAccessTokenForBusiness` — decrypts the per-business token + phone id
 *      (returns null unless the connection is CONNECTED → multi-tenant safe).
 *   2. `sendWhatsAppText` — the Graph call (in graph.service).
 *   3. on an auth failure (401/403/190) → `markRevokedByMeta` (existing) so the
 *      connection is flagged and the reconnect banner appears.
 *
 * Returns a small outcome the caller persists (sendStatus / providerMessageId)
 * and maps to a friendly user message. No token/text is logged here.
 */

import {
  getAccessTokenForBusiness,
  markRevokedByMeta,
} from "./connection.service";
import { sendWhatsAppText } from "./graph.service";

export type OutboundSendOutcome =
  | { ok: true; providerMessageId: string }
  | {
      ok: false;
      reason: "not_connected" | "no_recipient" | "revoked" | "window" | "error";
      code: string;
      message: string;
    };

export async function sendWhatsAppTextForBusiness(input: {
  businessId: number;
  toPhone: string | null | undefined;
  text: string | null | undefined;
}): Promise<OutboundSendOutcome> {
  const text = (input.text ?? "").trim();
  if (!text) {
    return { ok: false, reason: "error", code: "empty_text", message: "Empty text" };
  }

  const to = (input.toPhone ?? "").replace(/\D/g, "");
  if (to.length < 8) {
    return { ok: false, reason: "no_recipient", code: "no_recipient", message: "No recipient phone" };
  }

  const creds = await getAccessTokenForBusiness(input.businessId);
  if (!creds) {
    return {
      ok: false,
      reason: "not_connected",
      code: "not_connected",
      message: "No active WhatsApp connection",
    };
  }

  const result = await sendWhatsAppText({
    phoneNumberId: creds.phoneNumberId,
    accessToken: creds.token,
    toPhone: to,
    text,
  });

  if (result.ok) {
    return { ok: true, providerMessageId: result.providerMessageId };
  }

  if (result.kind === "auth") {
    await markRevokedByMeta(input.businessId, {
      code: result.code,
      message: result.message,
    });
    return { ok: false, reason: "revoked", code: result.code, message: result.message };
  }

  if (result.kind === "window") {
    return { ok: false, reason: "window", code: result.code, message: result.message };
  }

  return { ok: false, reason: "error", code: result.code, message: result.message };
}
