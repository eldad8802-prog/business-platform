/**
 * TEMPORARY Platform-Admin diagnostic: Tax Authority token-endpoint NETWORK probe.
 *
 * Path: POST /api/platform-admin/diagnostics/tax-authority-token-probe
 *
 * Runs the credential-less network probe once, from the same Node.js runtime and
 * egress the OAuth callback uses, to classify the token-exchange NETWORK_ERROR
 * (DNS / TLS / timeout / refused / reset) WITHOUT an OAuth roundtrip.
 *
 * This is a THROWAWAY operational tool — it must be removed in a follow-up PR
 * immediately after a single run. It is NOT part of the product API or the OAuth
 * flow. Protected solely by the canonical Platform-Admin guard used across
 * app/api/platform-admin/* (Bearer + PLATFORM_ADMIN role + email allowlist),
 * which fails closed. No feature flag, no secret header, no new env var.
 *
 * Returns only sanitized diagnostics — never the URL/host/IP/headers/body/
 * certificate/tokens/secrets/stack/raw message. No DB writes, no audit events.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdminOrResponse,
  type PlatformAdminUser,
} from "@/lib/auth/platform-admin";
import {
  runAuthorityTokenNetworkProbe,
  type AuthorityTokenProbeResult,
} from "@/lib/services/billing/authority/billing-authority-token-probe.service";

// Node.js runtime (match the OAuth callback); never statically optimized/cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type TokenProbeHandlerDeps = {
  authorize?: (req: Request) => Promise<PlatformAdminUser | NextResponse>;
  probe?: () => Promise<AuthorityTokenProbeResult>;
};

/**
 * Testable handler: canonical Platform-Admin authorization (fail-closed) → single
 * credential-less probe. Non-admins never reach the probe.
 */
export async function handleAuthorityTokenProbe(
  req: NextRequest,
  deps: TokenProbeHandlerDeps = {}
): Promise<NextResponse> {
  const authorize = deps.authorize ?? requirePlatformAdminOrResponse;
  const probe = deps.probe ?? runAuthorityTokenNetworkProbe;

  try {
    const auth = await authorize(req);
    if (auth instanceof NextResponse) {
      // 401/403 straight from the canonical guard — probe never runs.
      return auth;
    }

    const result = await probe();
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    // Log only the error name — never the message/stack (may carry config).
    console.error(
      "TAX_AUTHORITY_TOKEN_PROBE_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return handleAuthorityTokenProbe(req);
}
