import { NextResponse } from "next/server";

import { clearTicketCookie, GOOGLE_TICKET_COOKIE, readCookie, readGoogleLoginConfig } from "@/lib/auth/google-oauth";
import { readSignupTicket } from "@/lib/auth/oauth-ticket";

export const dynamic = "force-dynamic";

/**
 * The completion form's view of the ticket this browser holds: the provider-verified address and the name
 * Google gave, for prefill — and nothing else. Reading changes nothing. DELETE forgets the ticket in this
 * browser (the "cancel" of the form); the row itself expires within 30 minutes and the sweep removes it.
 * OFF → 404.
 */
export type TicketRouteDeps = { config: typeof readGoogleLoginConfig; read: typeof readSignupTicket };
const defaultDeps: TicketRouteDeps = { config: readGoogleLoginConfig, read: readSignupTicket };

export async function handleTicketRead(req: Request, deps: TicketRouteDeps = defaultDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const view = await deps.read(readCookie(req, GOOGLE_TICKET_COOKIE));
  if (!view) {
    const res = NextResponse.json({ code: "TICKET_EXPIRED" }, { status: 401, headers: { "cache-control": "no-store" } });
    clearTicketCookie(res);
    return res;
  }
  return NextResponse.json(
    { email: view.email, name: view.name, expiresAt: view.expiresAt },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function handleTicketCancel(_req: Request, deps: TicketRouteDeps = defaultDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const res = NextResponse.json({ success: true }, { headers: { "cache-control": "no-store" } });
  clearTicketCookie(res);
  return res;
}

export async function GET(req: Request) {
  return handleTicketRead(req);
}

export async function DELETE(req: Request) {
  return handleTicketCancel(req);
}
