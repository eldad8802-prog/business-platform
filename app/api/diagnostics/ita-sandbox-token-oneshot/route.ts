/**
 * TEMPORARY, PREVIEW-ONLY, ONE-SHOT: credential-less ITA Sandbox token-endpoint
 * reachability through the Kamatera egress gateway.
 * See lib/services/billing/authority/ita-sandbox-token-oneshot.ts for the fuses.
 * Access control = Vercel Deployment Protection + a single-use ticket header.
 * Only that header is read. Removed right after the single approved run.
 */

import { NextResponse, type NextRequest } from "next/server";
import { runSandboxTokenOneshot } from "@/lib/services/billing/authority/ita-sandbox-token-oneshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const startedAt = new Date().toISOString();
  try {
    const result = await runSandboxTokenOneshot({ ticket: req.headers.get("x-oneshot-ticket") });
    const body = {
      probe: "ITA_SANDBOX_TOKEN_ONESHOT",
      startedAt,
      finishedAt: new Date().toISOString(),
      region: process.env.VERCEL_REGION ?? null,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      ...result,
    };
    console.log("ITA_SANDBOX_TOKEN_ONESHOT", JSON.stringify(body));
    const status = result.outcome === "REFUSED_BY_FUSE" ? 409 : 200;
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("ITA_SANDBOX_TOKEN_ONESHOT_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json(
      { probe: "ITA_SANDBOX_TOKEN_ONESHOT", startedAt, error: "Probe failed" },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}
