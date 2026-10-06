/**
 * M7-C — the telephony sources Dubiz registers in Production. Each accepts nothing for a business until its
 * platform feature (telephony_cloudtalk / telephony_voicenter) is enabled for that business — all OFF by default.
 * Tenant resolution is ONLY the trusted connection (the endpoint id).
 */
import type { Prisma } from "@prisma/client";
import { makeCallAdapter } from "./adapter";
import { CLOUDTALK_SOURCE, hydrateCloudTalkCall } from "./cloudtalk";
import { VOICENTER_SOURCE } from "./voicenter";
import { resolvePublicConnection } from "@/lib/intake/acquisition/resolve";
import { lineLabelFor, readSecretsByPublicId } from "@/lib/intake/acquisition/connection.service";
import { isCall } from "./canonical";

export const cloudTalkAdapter = makeCallAdapter({
  sourceKey: CLOUDTALK_SOURCE,
  async resolveTenant(accountRef) {
    return (await resolvePublicConnection(CLOUDTALK_SOURCE, accountRef))?.businessId ?? null;
  },
  // The webhook carries no answered / missed: the outcome is read from CloudTalk's call history.
  hydrate: (ctx, event) =>
    hydrateCloudTalkCall(
      ctx,
      event,
      async (businessId, publicId) => {
        const s = await readSecretsByPublicId(businessId, CLOUDTALK_SOURCE, publicId);
        return s?.apiKeyId && s.apiKeySecret ? { apiKeyId: s.apiKeyId, apiKeySecret: s.apiKeySecret } : null;
      },
      (publicId, line) => lineLabelFor(CLOUDTALK_SOURCE, publicId, line)
    ),
});

export const voicenterAdapter = makeCallAdapter({
  sourceKey: VOICENTER_SOURCE,
  async resolveTenant(accountRef) {
    return (await resolvePublicConnection(VOICENTER_SOURCE, accountRef))?.businessId ?? null;
  },
  // M7-C — the owner's name for the dialled business line (a campaign number), as attribution.
  async hydrate(_ctx, event) {
    const call = event.payload;
    if (!isCall(call) || call.lineName || !event.providerAccountRef) return { kind: "unchanged" };
    const lineName = await lineLabelFor(VOICENTER_SOURCE, event.providerAccountRef, call.businessLine);
    return lineName ? { kind: "hydrated", payload: { ...call, lineName } as unknown as Prisma.InputJsonValue } : { kind: "unchanged" };
  },
});
