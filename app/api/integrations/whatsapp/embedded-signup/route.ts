/**
 * POST /api/integrations/whatsapp/embedded-signup  (Ticket 4)
 *
 * Receives the Embedded Signup result captured client-side (Ticket 3):
 *   { code, wabaId, phoneNumberId? }  (phoneNumberId is absent for coexistence
 *   onboarding; the server then resolves the WABA's number)
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
 * The orchestration itself (and every failure outcome, each naming its safe
 * `stage`/`code`) lives in `completeEmbeddedSignup`, where it is unit-tested;
 * each Graph call there is bounded by GRAPH_CONNECT_TIMEOUT_MS.
 *
 * Out of scope (later tickets): outbound, echo events, token refresh, revoke.
 */

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  exchangeCodeForToken,
  fetchPhoneNumberDisplay,
  fetchWabaPhoneNumber,
  subscribeWabaToApp,
} from "@/lib/services/integrations/whatsapp/graph.service";
import { persistFromEmbeddedSignup } from "@/lib/services/integrations/whatsapp/connection.service";
import { completeEmbeddedSignup } from "@/lib/services/integrations/whatsapp/embedded-signup-complete";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // businessId comes ONLY from the authenticated session — never the body.
  const outcome = await completeEmbeddedSignup(
    { businessId: user.businessId, body },
    {
      exchangeCodeForToken,
      fetchPhoneNumberDisplay,
      fetchWabaPhoneNumber,
      subscribeWabaToApp,
      persistFromEmbeddedSignup,
      // Safe fields only (a stage name and a Graph status/error number).
      warn: (event, fields) => console.warn(`[wa-embedded-signup] ${event}`, fields),
    }
  );
  return NextResponse.json(outcome.body, { status: outcome.status });
}
