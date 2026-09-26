/**
 * L-16 — WhatsApp document intake from senders who are NOT on the business's
 * allowlist.
 *
 * The routing gate lets media from any sender into the document pipeline when
 * the business is identified (`senderTrust: "conversation"`), which means an
 * arbitrary phone number can make the business pay for media download + OCR
 * and put a document into its review queue. Whether such media should be
 * dropped entirely is a PRODUCT decision (see the sec(D) PR body). Until it is
 * made, the conservative boundary here:
 *
 *   1. The Document is recorded with source {@link WHATSAPP_UNVERIFIED_SOURCE},
 *      so every surface labels it "unverified sender" and nothing treats it as
 *      trusted (quick-approve is disabled for it in the inbox).
 *   2. A per-sender AND per-business quota bounds untrusted media, checked
 *      BEFORE the media is downloaded or OCR'd.
 */

import { consumeRateLimit } from "@/lib/security/rate-limit";

export type WhatsAppSenderTrust = "allowlist" | "conversation";

export const WHATSAPP_TRUSTED_SOURCE = "whatsapp" as const;
export const WHATSAPP_UNVERIFIED_SOURCE = "whatsapp_unverified" as const;

export type WhatsAppDocumentSource =
  | typeof WHATSAPP_TRUSTED_SOURCE
  | typeof WHATSAPP_UNVERIFIED_SOURCE;

export function documentSourceForSenderTrust(
  trust: WhatsAppSenderTrust | undefined
): WhatsAppDocumentSource {
  // Absent trust is treated as UNtrusted: fail toward the label, not away from it.
  return trust === "allowlist" ? WHATSAPP_TRUSTED_SOURCE : WHATSAPP_UNVERIFIED_SOURCE;
}

export function isUntrustedDocumentSource(source: string | null | undefined): boolean {
  return source === WHATSAPP_UNVERIFIED_SOURCE;
}

export const UNTRUSTED_MEDIA_QUOTA = {
  perSenderPerDay: 10,
  perBusinessPerDay: 60,
} as const;

export type UntrustedQuotaResult =
  | { allowed: true }
  | { allowed: false; scope: "sender" | "business" };

export type UntrustedQuotaLimiter = (params: {
  key: string;
  limit: number;
  windowMs: number;
}) => Promise<{ allowed: boolean }>;

const DAY_MS = 24 * 60 * 60_000;

export async function consumeUntrustedMediaQuota(
  input: { businessId: number; sender: string },
  limiter: UntrustedQuotaLimiter = consumeRateLimit
): Promise<UntrustedQuotaResult> {
  const sender = await limiter({
    key: `whatsapp:untrusted-media:sender:${input.businessId}:${input.sender}`,
    limit: UNTRUSTED_MEDIA_QUOTA.perSenderPerDay,
    windowMs: DAY_MS,
  });
  if (!sender.allowed) return { allowed: false, scope: "sender" };
  const business = await limiter({
    key: `whatsapp:untrusted-media:business:${input.businessId}`,
    limit: UNTRUSTED_MEDIA_QUOTA.perBusinessPerDay,
    windowMs: DAY_MS,
  });
  if (!business.allowed) return { allowed: false, scope: "business" };
  return { allowed: true };
}
