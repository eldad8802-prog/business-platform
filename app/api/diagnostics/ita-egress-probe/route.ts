/**
 * TEMPORARY, PREVIEW-ONLY diagnostic: ITA token-endpoint reachability through
 * the dedicated authority egress (post-whitelist route proof).
 *
 * Path: POST /api/diagnostics/ita-egress-probe
 *
 * Runs the EXISTING credential-less token network probe exactly once, with no
 * overrides, so it uses exactly what the real token exchange uses: the endpoint
 * from the Sandbox authority env config and the billing-authority-egress
 * transport (mTLS CONNECT gateway, destination allowlist, one tunnel attempt,
 * 10s hard timeout). Nothing else.
 *
 * SAFETY
 *   - PREVIEW-ONLY FUSE: unless VERCEL_ENV === "preview" this answers 410 and
 *     does nothing else. Production, Development, local and unknown are refused.
 *   - No application-level admin guard, deliberately and only on this throwaway
 *     route: the Preview database has no PLATFORM_ADMIN user, so the canonical
 *     guard is unsatisfiable there. Vercel Deployment Protection (SSO) fronts
 *     every Preview deployment and is unchanged.
 *   - No caller-controlled target: the request (URL, query, headers, body) is
 *     never read. The target comes only from env and is re-checked against the
 *     ITA allowlist by the egress transport.
 *   - Credential-less: empty body, no Authorization header, no client id or
 *     secret, no code, no token. No DB reads or writes, no session, no audit.
 *   - Sanitized output only (the probe's own sanitized result).
 *
 * THROWAWAY: removed in a separate cleanup commit right after the Phase 3
 * evidence is collected. Not for main.
 */

import { NextResponse } from "next/server";
import {
  runAuthorityTokenNetworkProbe,
  type AuthorityTokenProbeResult,
} from "@/lib/services/billing/authority/billing-authority-token-probe.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type ItaEgressProbeDeps = {
  vercelEnv?: () => string | null;
  probe?: () => Promise<AuthorityTokenProbeResult>;
  now?: () => Date;
};

export async function handleItaEgressProbe(
  deps: ItaEgressProbeDeps = {}
): Promise<NextResponse> {
  const vercelEnv = (deps.vercelEnv ?? (() => process.env.VERCEL_ENV?.trim() || null))();
  if (vercelEnv !== "preview") {
    return NextResponse.json({ error: "Gone" }, { status: 410 });
  }

  const probe = deps.probe ?? (() => runAuthorityTokenNetworkProbe());
  const now = deps.now ?? (() => new Date());

  const startedAt = now().toISOString();
  try {
    const result = await probe();
    const finishedAt = now().toISOString();
    // Correlation marker for the gateway log window. Sanitized fields only.
    console.log(
      "ITA_EGRESS_PROBE",
      JSON.stringify({ startedAt, finishedAt, ...result })
    );
    return NextResponse.json(
      { startedAt, finishedAt, ...result },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    // Configuration failures surface here; log the error name only.
    console.error(
      "ITA_EGRESS_PROBE_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json(
      { startedAt, error: "Probe failed before network I/O" },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}

export async function POST() {
  return handleItaEgressProbe();
}
