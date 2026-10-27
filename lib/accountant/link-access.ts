/**
 * The accountant's link, server side — one path for every portal request (R3). SERVER-ONLY.
 *
 *   1. the secret comes in the body (it lived in the URL fragment, so no log ever saw it);
 *   2. per-IP rate limit, fail-closed (the caller picks the bucket);
 *   3. the SECURITY DEFINER lookup returns ids only, and only when the public id AND sha256(secret) match;
 *   4. everything else runs inside that business's tenant job, under RLS;
 *   5. the business must have the accountant workflow enabled (today: business 9 only) — a link of any
 *      other business answers as if it did not exist;
 *   6. checkLinkAccess: not revoked, not expired, accepted by the provider, the package sealed with the
 *      approved sha256 — a refusal is recorded.
 *
 * Unknown, malformed, foreign and disabled links all get the same 404 answer, so the endpoint reveals nothing.
 */
import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { getClientIp } from "@/lib/security/rate-limit";
import { BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";
import { runTenantJob } from "@/lib/tenant/job";

import { checkLinkAccess, type LinkOpen } from "./delivery.service";
import { AccountantError, accountantWorkflowEnabled } from "./http";
import { hashAccountantLinkSecret, isLinkPublicId, isLinkSecret } from "./link";
import type { SealedPackage } from "./package-reports";

export const LINK_NO_STORE = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export function linkRefusal(status: number, code: string): Response {
  return NextResponse.json({ error: code }, { status, headers: LINK_NO_STORE });
}

export type OpenedLink = Extract<LinkOpen, { ok: true }> & { businessId: number; sealed: SealedPackage };

/**
 * Runs `handler` for a valid, live link of an enabled business, inside its tenant job. Everything that is
 * not that — including any AccountantError the handler throws — becomes a closed JSON answer.
 */
export async function withAccountantLink(
  req: Request,
  bucket: "ACCOUNTANT_LINK_PUBLIC" | "ACCOUNTANT_LINK_FILE",
  handler: (link: OpenedLink, body: Record<string, unknown>, now: Date) => Promise<Response>
): Promise<Response> {
  const decision = await checkRateLimit({ bucket, ip: getClientIp(req) });
  if (!decision.allowed) return buildRateLimitResponse(decision);

  let body: Record<string, unknown>;
  try {
    body = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return linkRefusal(404, "LINK_NOT_FOUND");
  }
  const { publicId, token } = body;
  if (!isLinkPublicId(publicId) || !isLinkSecret(token)) return linkRefusal(404, "LINK_NOT_FOUND");

  const rows = await prisma.$queryRaw<Array<{ businessId: number; deliveryId: number }>>`
    SELECT "businessId", "deliveryId" FROM public.accountant_link_resolve(${publicId}, ${hashAccountantLinkSecret(token)})`;
  const hit = rows[0];
  if (!hit) return linkRefusal(404, "LINK_NOT_FOUND");
  if (!(await accountantWorkflowEnabled(hit.businessId))) return linkRefusal(404, "LINK_NOT_FOUND");

  try {
    return await runTenantJob({ businessId: hit.businessId }, async () => {
      const now = new Date();
      const opened = await checkLinkAccess(hit.businessId, hit.deliveryId, now, { recordRefusal: true, countDownload: false });
      if (!opened.ok) {
        return linkRefusal(410, opened.reason === "expired" ? "LINK_EXPIRED" : opened.reason === "revoked" ? "LINK_REVOKED" : "LINK_UNAVAILABLE");
      }
      const sealed: SealedPackage = {
        businessId: hit.businessId,
        periodKey: opened.periodKey,
        version: opened.packageVersion,
        storageKey: opened.storageKey,
        sha256: opened.packageSha256,
      };
      return handler({ ...opened, businessId: hit.businessId, sealed }, body, now);
    });
  } catch (e) {
    if (e instanceof BusinessQuarantinedError) return linkRefusal(410, "LINK_UNAVAILABLE");
    if (e instanceof AccountantError) return linkRefusal(e.status, e.code);
    console.error("[accountant-link] portal request failed", { error: e instanceof Error ? e.name : "unknown" });
    return linkRefusal(500, "INTERNAL");
  }
}
