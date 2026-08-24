/**
 * GET  /api/integrations/whatsapp/connection
 *   Returns the authenticated user's business WhatsApp connection in a
 *   sanitized shape (no token, no IV, no tag). Always 200; the body's
 *   `connection` is `null` when no row exists.
 *
 * POST /api/integrations/whatsapp/connection
 *   Manual provisioning for Bot-MVP-1. Encrypts the access token and
 *   creates/replaces a `WhatsAppConnection` row.
 *
 *   Two-layer gate (defense in depth):
 *     1. `WHATSAPP_MANUAL_SEED_ENABLED=1` env flag must be set.
 *     2. Calling user role must be `PLATFORM_ADMIN`.
 *
 *   Body (JSON):
 *     {
 *       businessId:         number,   // target — admin can seed any business
 *       phoneNumberId:      string,
 *       displayPhoneNumber: string,
 *       wabaId:             string,
 *       accessToken:        string
 *     }
 *
 *   This endpoint exists ONLY for the MVP-1 sprint. Embedded Signup will
 *   replace it; the route can be deleted at that point.
 */

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import {
  findPublicByBusinessId,
  manualSeedConnection,
} from "@/lib/services/integrations/whatsapp/connection.service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const connection = await findPublicByBusinessId(user.businessId);
  return NextResponse.json({ connection }, { status: 200 });
}

export async function POST(req: Request) {
  // ── Gate 1: env flag ────────────────────────────────────────────────
  if (process.env.WHATSAPP_MANUAL_SEED_ENABLED !== "1") {
    return NextResponse.json(
      { error: "Manual seed is disabled in this environment." },
      { status: 404 } // 404 — pretend the route doesn't exist when disabled
    );
  }

  // ── Gate 2: canonical platform-admin auth (role + allowlist, fail-closed).
  // D2/P7-W2-GATE hardening: this admin-semantics route must never be
  // reachable through a weaker path than requirePlatformAdmin.
  const adminOrResponse = await requirePlatformAdminOrResponse(req);
  if (adminOrResponse instanceof NextResponse) {
    return adminOrResponse;
  }

  // ── Body parsing ────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const businessId = Number(body.businessId);
  const phoneNumberId =
    typeof body.phoneNumberId === "string" ? body.phoneNumberId.trim() : "";
  const displayPhoneNumber =
    typeof body.displayPhoneNumber === "string"
      ? body.displayPhoneNumber.trim()
      : "";
  const wabaId = typeof body.wabaId === "string" ? body.wabaId.trim() : "";
  const accessToken =
    typeof body.accessToken === "string" ? body.accessToken : "";

  if (
    !Number.isInteger(businessId) ||
    businessId <= 0 ||
    !phoneNumberId ||
    !displayPhoneNumber ||
    !wabaId ||
    !accessToken
  ) {
    return NextResponse.json(
      {
        error:
          "businessId, phoneNumberId, displayPhoneNumber, wabaId, accessToken are required",
      },
      { status: 400 }
    );
  }

  try {
    const connection = await manualSeedConnection({
      businessId,
      phoneNumberId,
      displayPhoneNumber,
      wabaId,
      accessToken,
    });
    return NextResponse.json({ connection }, { status: 201 });
  } catch (err) {
    // Errors here are typically: missing/invalid encryption key, invalid
    // input that slipped past the basic checks above, or DB conflict on
    // `phoneNumberId`. We do not echo `err.message` verbatim — it could
    // contain hints about the encryption key configuration.
    console.error("[whatsapp-connection-seed]", err);
    return NextResponse.json(
      { error: "Failed to create or update connection" },
      { status: 500 }
    );
  }
}
