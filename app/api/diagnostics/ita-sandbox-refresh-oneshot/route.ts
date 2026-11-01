/**
 * TEMPORARY, PREVIEW-ONLY, ONE-SHOT: one controlled SANDBOX token refresh for
 * lab business 9 / connection 2 through the Kamatera egress.
 * See lib/services/billing/authority/ita-sandbox-refresh-oneshot.ts for the fuses.
 * Access control = Vercel Deployment Protection + a single-use ticket header.
 * Only that header is read. Removed by a revert after the single approved run.
 */

import { NextResponse, type NextRequest } from "next/server";
import { runSandboxRefreshOneshot } from "@/lib/services/billing/authority/ita-sandbox-refresh-oneshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const startedAt = new Date().toISOString();
  try {
    const result = await runSandboxRefreshOneshot({ ticket: req.headers.get("x-oneshot-ticket") });
    const body = {
      probe: "ITA_SANDBOX_REFRESH_ONESHOT",
      startedAt,
      finishedAt: new Date().toISOString(),
      region: process.env.VERCEL_REGION ?? null,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      ...result,
    };
    console.log("ITA_SANDBOX_REFRESH_ONESHOT", JSON.stringify(body));
    const status = result.outcome === "REFUSED_BY_FUSE" ? 409 : 200;
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("ITA_SANDBOX_REFRESH_ONESHOT_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json(
      { probe: "ITA_SANDBOX_REFRESH_ONESHOT", startedAt, error: "Probe failed" },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}
