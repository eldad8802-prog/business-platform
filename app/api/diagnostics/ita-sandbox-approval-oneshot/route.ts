/**
 * TEMPORARY, PREVIEW-ONLY, ONE-SHOT: issue one pre-seeded synthetic DRAFT tax
 * invoice of lab business 9 → one SANDBOX Approval through the Kamatera egress.
 * See lib/services/billing/authority/ita-sandbox-approval-oneshot.ts for the fuses.
 * Access control = Vercel Deployment Protection + a single-use ticket header.
 * Only the ticket and mode headers are read. Removed by a revert after the run.
 */

import { NextResponse, type NextRequest } from "next/server";
import { runSandboxApprovalOneshot } from "@/lib/services/billing/authority/ita-sandbox-approval-oneshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const startedAt = new Date().toISOString();
  try {
    const mode = req.headers.get("x-oneshot-mode") === "preflight" ? "preflight" : "run";
    const result = await runSandboxApprovalOneshot({ ticket: req.headers.get("x-oneshot-ticket"), mode });
    const body = {
      probe: "ITA_SANDBOX_APPROVAL_ONESHOT",
      mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      region: process.env.VERCEL_REGION ?? null,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      ...result,
    };
    console.log("ITA_SANDBOX_APPROVAL_ONESHOT", JSON.stringify(body));
    const status = result.outcome === "REFUSED_BY_FUSE" ? 409 : 200;
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("ITA_SANDBOX_APPROVAL_ONESHOT_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json(
      { probe: "ITA_SANDBOX_APPROVAL_ONESHOT", startedAt, error: "Probe failed" },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}
