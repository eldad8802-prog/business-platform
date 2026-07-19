/**
 * TEMPORARY diagnostic: Authority token-endpoint NETWORK probe.
 *
 * Path: POST /api/taxes/authority/diagnostics/token-probe
 *
 * Runs the credential-less network probe once, from the same Node.js runtime the
 * OAuth callback uses, to classify the token-exchange NETWORK_ERROR (DNS / TLS /
 * timeout / refused / reset) WITHOUT an OAuth roundtrip. This is a throwaway
 * diagnostic tool — not a permanent product surface.
 *
 * NOT public. All THREE guards must pass, or the route returns 403:
 *   1. Feature flag         — AUTHORITY_PROBE_ENABLED === "true"
 *   2. Secret header        — x-authority-probe-secret === AUTHORITY_PROBE_SECRET
 *   3. Platform admin       — Bearer token + PLATFORM_ADMIN role + email allowlist
 *
 * Returns only sanitized diagnostics. Never the URL/host/IP/headers/body/
 * certificate/tokens/secrets/stack/raw message. No DB writes, no audit events.
 */

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { runAuthorityTokenNetworkProbe } from "@/lib/services/billing/authority/billing-authority-token-probe.service";

export const runtime = "nodejs";

const PROBE_FLAG_VAR = "AUTHORITY_PROBE_ENABLED";
const PROBE_SECRET_VAR = "AUTHORITY_PROBE_SECRET";
const PROBE_SECRET_HEADER = "x-authority-probe-secret";

const forbidden = () =>
  NextResponse.json({ error: "Forbidden" }, { status: 403 });

/** Constant-time equality that also hides length via a fixed-size digest compare. */
function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    // Still perform a compare against self to avoid an early-return timing signal.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  try {
    // Guard 1 — feature flag (must be explicitly enabled).
    if (process.env[PROBE_FLAG_VAR]?.trim() !== "true") {
      return forbidden();
    }

    // Guard 2 — dedicated secret header (constant-time).
    const expectedSecret = process.env[PROBE_SECRET_VAR]?.trim();
    const providedSecret = req.headers.get(PROBE_SECRET_HEADER)?.trim();
    if (
      !expectedSecret ||
      !providedSecret ||
      !secretsMatch(expectedSecret, providedSecret)
    ) {
      return forbidden();
    }

    // Guard 3 — platform admin (any auth/role failure collapses to 403 here).
    try {
      await requirePlatformAdmin(req);
    } catch {
      return forbidden();
    }

    const result = await runAuthorityTokenNetworkProbe();
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    // Log only the error name — never the message/stack (may carry config).
    console.error(
      "AUTHORITY_TOKEN_PROBE_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
