/**
 * POST /api/integrations/whatsapp/embedded-signup  (Ticket 4)
 *
 * Receives the Embedded Signup result captured client-side (Ticket 3):
 *   { code, phoneNumberId, wabaId }
 *
 * Orchestrates the connect flow ATOMICALLY:
 *   1. exchange `code` → access token   (App Secret, server-side)
 *   2. fetch display_phone_number       (Graph, with that token)
 *   2.5 subscribe the WABA to our app   (Graph POST /{waba-id}/subscribed_apps)
 *   3. persist WhatsAppConnection       (encrypted token, status=CONNECTED)
 *
 * The persist (step 3) is the ONLY DB write and it runs LAST. If any earlier
 * step fails, nothing is written — no half-connected row, no empty ERROR row,
 * no stored token. On a reconnect, an existing CONNECTED row is left untouched
 * on failure.
 *
 * Business isolation: the connection is always saved to the AUTHENTICATED
 * user's businessId. Any businessId in the request body is ignored.
 *
 * The access token / code are never logged and never returned.
 *
 * Out of scope (later tickets): outbound, echo events, token refresh, revoke.
 */

import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import {
  exchangeCodeForToken,
  fetchPhoneNumberDisplay,
  subscribeWabaToApp,
} from "@/lib/services/integrations/whatsapp/graph.service";
import { persistFromEmbeddedSignup } from "@/lib/services/integrations/whatsapp/connection.service";

export const runtime = "nodejs";

function isUniqueConflict(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "P2002";
}

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
      return authRequiredResponse(req);
    }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code : "";
  const phoneNumberId =
    typeof body.phoneNumberId === "string" ? body.phoneNumberId.trim() : "";
  const wabaId = typeof body.wabaId === "string" ? body.wabaId.trim() : "";

  if (!code || !phoneNumberId || !wabaId) {
    return NextResponse.json(
      { error: "code, phoneNumberId and wabaId are required" },
      { status: 400 }
    );
  }

  // businessId comes ONLY from the authenticated session — never the body.
  const businessId = user.businessId;

  // ── Step 1: token exchange (no DB write) ──────────────────────────────
  const exchange = await exchangeCodeForToken(code);
  if (!exchange.ok) {
    console.warn("[wa-embedded-signup] exchange failed:", exchange.code);
    return NextResponse.json(
      { error: "Could not complete WhatsApp connection" },
      { status: 502 }
    );
  }

  // ── Step 2: display phone number (no DB write — keeps it atomic) ───────
  const display = await fetchPhoneNumberDisplay(phoneNumberId, exchange.accessToken);
  if (!display.ok) {
    console.warn("[wa-embedded-signup] display fetch failed:", display.code);
    return NextResponse.json(
      { error: "Could not complete WhatsApp connection" },
      { status: 502 }
    );
  }

  // ── Step 2.5: register the WABA on our app's webhooks (no DB write) ────
  // Must succeed BEFORE we persist — a CONNECTED row without a live webhook
  // subscription would silently never receive inbound events. If this fails
  // we stop here: nothing is written, no token is stored.
  const subscription = await subscribeWabaToApp({
    wabaId,
    accessToken: exchange.accessToken,
  });
  if (!subscription.ok) {
    console.warn("[wa-embedded-signup] subscribe failed:", subscription.code);
    return NextResponse.json(
      { error: "Could not complete WhatsApp connection" },
      { status: 502 }
    );
  }

  // ── Step 3: persist (ONLY DB write, only after 1+2+2.5 succeeded) ──────
  try {
    const connection = await persistFromEmbeddedSignup({
      businessId,
      phoneNumberId,
      displayPhoneNumber: display.displayPhoneNumber,
      wabaId,
      accessToken: exchange.accessToken,
    });
    return NextResponse.json({ connection }, { status: 201 });
  } catch (err) {
    if (isUniqueConflict(err)) {
      return NextResponse.json(
        { error: "This WhatsApp number is already connected to another account" },
        { status: 409 }
      );
    }
    // Do not echo err (may hint at encryption-key config).
    console.error("[wa-embedded-signup] persist failed");
    return NextResponse.json(
      { error: "Could not complete WhatsApp connection" },
      { status: 500 }
    );
  }
}
