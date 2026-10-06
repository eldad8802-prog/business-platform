/**
 * M6 — shared plumbing for the owner's acquisition-connection API (authenticated, tenant-scoped).
 * A source's management actions are available only while that source is enabled for the business.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { AppError } from "@/lib/errors";
import { ACQUISITION_SOURCE_KEYS, CONNECTION_SOURCE_KEYS, SOURCE_FEATURE, type AcquisitionSourceKey, type ConnectionSourceKey } from "./gate";
import type { ConnectionView } from "./connection.service";

export type OwnerCtx = { businessId: number; userId: number };

export async function withOwner(
  req: Request,
  fn: (ctx: OwnerCtx) => Promise<NextResponse>
): Promise<NextResponse> {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return await runWithTenantContext({ businessId: user.businessId }, () => fn({ businessId: user.businessId, userId: user.id }));
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.statusCode });
    console.error("[acquisition-owner-api]", e instanceof Error ? e.name : "error");
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Every connection source (lead, commerce, telephony) → enabled for this business? (all OFF by default) */
export async function enabledSources(businessId: number): Promise<Record<ConnectionSourceKey, boolean>> {
  const out = {} as Record<ConnectionSourceKey, boolean>;
  for (const s of CONNECTION_SOURCE_KEYS) out[s] = (await resolveFeatureAccess(businessId, SOURCE_FEATURE[s])).allowed;
  return out;
}

export function isSourceKey(v: unknown): v is AcquisitionSourceKey {
  return typeof v === "string" && (ACQUISITION_SOURCE_KEYS as readonly string[]).includes(v);
}

/** Where the provider must send: built from the request's own origin (never a stored host). */
export function endpointUrl(req: Request, c: Pick<ConnectionView, "sourceKey" | "publicId">): string | null {
  const origin = new URL(req.url).origin;
  if (c.sourceKey === "web.form") return `${origin}/api/intake/acquisition/web/${c.publicId}`;
  if (c.sourceKey === "google.lead_form") return `${origin}/api/intake/acquisition/google/${c.publicId}`;
  // M7-B / M7-C. Voicenter's URL carries its key, shown once at creation; the stored view shows where it goes.
  if (c.sourceKey === "commerce.woocommerce") return `${origin}/api/intake/commerce/woocommerce/${c.publicId}`;
  if (c.sourceKey === "telephony.cloudtalk") return `${origin}/api/intake/telephony/cloudtalk/${c.publicId}`;
  if (c.sourceKey === "telephony.voicenter") return `${origin}/api/intake/telephony/voicenter/${c.publicId}/<key>`;
  if (c.sourceKey === "commerce.wix") return `${origin}/api/intake/commerce/wix`;
  return null;
}
