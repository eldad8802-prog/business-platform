import { NextResponse } from "next/server";

import { openLink } from "@/lib/accountant/delivery.service";
import { hashAccountantLinkSecret, isLinkPublicId, isLinkSecret } from "@/lib/accountant/link";
import { packageDownloadName, PACKAGE_SIGNED_URL_TTL_SECONDS } from "@/lib/accountant/package-download";
import { periodLabelHe } from "@/lib/accountant/period";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { getClientIp } from "@/lib/security/rate-limit";
import { getStorageService, loadStorageConfig } from "@/lib/storage";
import { BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";
import { runTenantJob } from "@/lib/tenant/job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };

function refuse(status: number, code: string) {
  return NextResponse.json({ error: code }, { status, headers: NO_STORE });
}

/**
 * POST — the accountant's link (public, no session). Body: { publicId, token, mode: "info" | "download" }.
 *
 *   - the secret comes in the body (it lived in the URL fragment, so no log ever saw it);
 *   - per-IP rate limit, fail-closed;
 *   - the SECURITY DEFINER lookup returns ids only, and only when the public id AND sha256(secret) match;
 *   - everything else is read under RLS inside that business's tenant job;
 *   - expired / revoked links are refused (and the refusal is recorded); every download is recorded;
 *   - a download is a five-minute presigned URL to the approved object — never a lasting public URL.
 *
 * Unknown and malformed links get the same answer, so the endpoint reveals nothing about what exists.
 */
export async function POST(req: Request) {
  const decision = await checkRateLimit({ bucket: "ACCOUNTANT_LINK_PUBLIC", ip: getClientIp(req) });
  if (!decision.allowed) return buildRateLimitResponse(decision);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return refuse(404, "LINK_NOT_FOUND");
  }
  const { publicId, token, mode } = body ?? {};
  if (!isLinkPublicId(publicId) || !isLinkSecret(token) || (mode !== "info" && mode !== "download")) {
    return refuse(404, "LINK_NOT_FOUND");
  }

  const rows = await prisma.$queryRaw<Array<{ businessId: number; deliveryId: number }>>`
    SELECT "businessId", "deliveryId" FROM public.accountant_link_resolve(${publicId}, ${hashAccountantLinkSecret(token)})`;
  const hit = rows[0];
  if (!hit) return refuse(404, "LINK_NOT_FOUND");

  try {
    const now = new Date();
    const opened = await runTenantJob({ businessId: hit.businessId }, () =>
      openLink(hit.businessId, hit.deliveryId, now, mode === "download")
    );
    if (!opened.ok) return refuse(410, opened.reason === "expired" ? "LINK_EXPIRED" : opened.reason === "revoked" ? "LINK_REVOKED" : "LINK_UNAVAILABLE");

    if (mode === "info") {
      return NextResponse.json(
        {
          businessName: opened.businessName,
          periodLabel: periodLabelHe(opened.periodKey),
          expiresAt: opened.expiresAt.toISOString(),
        },
        { headers: NO_STORE }
      );
    }

    const storage = getStorageService();
    const name = packageDownloadName(opened.periodKey, opened.packageVersion);
    if (loadStorageConfig().provider === "local") {
      const object = await storage.getObject(opened.storageKey);
      return new Response(new Uint8Array(object.body), {
        headers: { ...NO_STORE, "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name}"` },
      });
    }
    const url = await storage.getSignedDownloadUrl(opened.storageKey, PACKAGE_SIGNED_URL_TTL_SECONDS);
    return NextResponse.json({ url, fileName: name }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof BusinessQuarantinedError) return refuse(410, "LINK_UNAVAILABLE");
    console.error("[accountant-link] open failed", { error: e instanceof Error ? e.name : "unknown" });
    return refuse(500, "INTERNAL");
  }
}
