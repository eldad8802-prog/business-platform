import { NextResponse } from "next/server";

import { LINK_NO_STORE, linkRefusal, withAccountantLink } from "@/lib/accountant/link-access";
import { sendLinkCode } from "@/lib/accountant/link-device";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — a one-time code for the accountant's portal on a new device (G5 M5; public, no session).
 * Body: { publicId, token }. Nothing else is read: the code goes ONLY to the delivery's own recipient — the
 * address the owner approved for this package — never to an address in the request.
 *
 * The link is checked first (revoked / expired → 410, unknown → 404), so a code is never issued for a link
 * that does not open. Limits: per address (bucket ACCOUNTANT_LINK_CODE, fail-closed), and per delivery one code
 * per minute, 3 per 15 minutes, 10 per day. The answer carries only the masked address and the expiry.
 */
export async function POST(req: Request) {
  return withAccountantLink(
    req,
    "ACCOUNTANT_LINK_CODE",
    async (link, _body, now) => {
      const r = await sendLinkCode(link, now);
      if (r.ok) return NextResponse.json({ sent: true, maskedTo: r.maskedTo, expiresAt: r.expiresAt.toISOString() }, { headers: LINK_NO_STORE });
      if (r.reason === "cooldown" || r.reason === "limit_15min" || r.reason === "limit_day") {
        return NextResponse.json(
          { error: r.reason === "cooldown" ? "CODE_COOLDOWN" : "CODE_LIMIT", retryAfterSec: r.retryAfterSec },
          { status: 429, headers: { ...LINK_NO_STORE, "Retry-After": String(r.retryAfterSec) } }
        );
      }
      if (r.reason === "no_recipient") return linkRefusal(410, "LINK_UNAVAILABLE");
      return linkRefusal(503, r.reason === "not_sent" ? "CODE_NOT_SENT" : "CODE_UNAVAILABLE");
    },
    { device: "not_required" }
  );
}
