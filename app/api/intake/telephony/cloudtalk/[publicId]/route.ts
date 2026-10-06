/**
 * POST /api/intake/telephony/cloudtalk/<publicId> — a CloudTalk account's webhook endpoint (M7-C).
 *
 * Svix signature (svix-id / svix-timestamp / svix-signature) with the endpoint's own secret (whsec_…, the owner
 * copies it from CloudTalk → Account → Webhooks into Dubiz), verified on the RAW body with a 5-minute replay
 * window BEFORE parsing. The CloudTalk account (company_id) is bound to the connection on its first verified
 * delivery and every later delivery must come from the same account; one live mapping per account.
 * Only `call.ended` is recorded (as a reference — the outcome is read from CloudTalk's call history).
 *
 *   200  recorded / duplicate / another event type / source OFF
 *   401  unknown / paused / revoked endpoint, bad or stale signature, another CloudTalk account
 *   400  authenticated but malformed
 *   503  rate-limited or the store is unavailable (CloudTalk retries up to 50 times over ~11.5 h)
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { runWithTenantContext } from "@/lib/tenant/context";
import { BODY_LIMITS, BodyTooLargeError, readBodyLimited } from "@/lib/intake/acquisition/http";
import { ingestAcquisition } from "@/lib/intake/acquisition/ingest";
import { resolvePublicConnection } from "@/lib/intake/acquisition/resolve";
import { bindExternalResource, readConnectionSecrets } from "@/lib/intake/acquisition/connection.service";
import { verifySvix } from "@/lib/intake/acquisition/signatures";
import { PUBLIC_ID_PATTERN } from "@/lib/intake/acquisition/keys";
import { logIntake } from "@/lib/intake/core/observability";
import { CLOUDTALK_SOURCE, parseCloudTalkWebhook } from "@/lib/intake/calls/cloudtalk";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await ctx.params;
  if (!PUBLIC_ID_PATTERN.test(publicId)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let raw: string;
  try {
    raw = await readBodyLimited(req, BODY_LIMITS[CLOUDTALK_SOURCE]);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ error: "too_large" }, { status: 413 });
    throw e;
  }
  let conn;
  try {
    conn = await resolvePublicConnection(CLOUDTALK_SOURCE, publicId);
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  if (!conn) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { businessId, connectionId } = conn;
  const secrets = await runWithTenantContext({ businessId }, () => readConnectionSecrets(businessId, connectionId)).catch(() => null);
  const headers = { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") };
  if (!secrets || !verifySvix(raw, headers, secrets.signingSecret, new Date())) {
    logIntake("refused", { businessId, sourceKey: CLOUDTALK_SOURCE, code: "invalid_signature" });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  const parsed = parseCloudTalkWebhook(raw);
  if (!parsed.ok) return NextResponse.json({ error: "malformed", code: parsed.code }, { status: 400 });

  // The CloudTalk account behind this endpoint: bound once, then every delivery must match it.
  if (parsed.companyId) {
    let bound: "bound" | "same" | "mismatch";
    try {
      bound = await runWithTenantContext({ businessId }, () => bindExternalResource(connectionId, parsed.companyId!));
    } catch (e) {
      // Another business already holds this CloudTalk account live (one live mapping per account).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") bound = "mismatch";
      else return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
    if (bound === "mismatch") {
      logIntake("refused", { businessId, sourceKey: CLOUDTALK_SOURCE, code: "account_mismatch" });
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  if (!("receipt" in parsed)) return NextResponse.json({}, { status: 200 });

  const limit = await checkRateLimit({ bucket: "ACQUISITION_INTAKE", business: businessId });
  if (!limit.allowed && limit.outcome === "rate_limited") {
    return NextResponse.json({ error: "rate_limited" }, { status: 503, headers: { "retry-after": String(limit.retryAfterSeconds) } });
  }
  try {
    await ingestAcquisition({ sourceKey: CLOUDTALK_SOURCE, accountRef: publicId, businessId, connectionId, receipts: [parsed.receipt] });
    return NextResponse.json({}, { status: 200 });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
