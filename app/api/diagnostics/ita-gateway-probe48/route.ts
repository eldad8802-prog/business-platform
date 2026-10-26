/**
 * TEMPORARY, PREVIEW-ONLY: 48h ITA egress gateway stability probe.
 * See lib/services/billing/authority/ita-gateway-probe48.ts for the fuses.
 * Access control = Vercel Deployment Protection (no app-level secret).
 * The request is never read. Removed after the measurement window.
 */

import { NextResponse } from "next/server";
import { runProbe48 } from "@/lib/services/billing/authority/ita-gateway-probe48";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST() {
  const startedAt = new Date().toISOString();
  try {
    const result = await runProbe48();
    const body = {
      probe: "ITA_GATEWAY_PROBE48",
      startedAt,
      finishedAt: new Date().toISOString(),
      region: process.env.VERCEL_REGION ?? null,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      ...result,
    };
    console.log("ITA_GATEWAY_PROBE48", JSON.stringify(body));
    const status = result.outcome === "REFUSED_BY_FUSE" ? 409 : 200;
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("ITA_GATEWAY_PROBE48_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json(
      { probe: "ITA_GATEWAY_PROBE48", startedAt, error: "Probe failed" },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}
