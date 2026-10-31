import { NextResponse } from "next/server";

import { LINK_NO_STORE, withAccountantLink } from "@/lib/accountant/link-access";
import { deviceCookie, verifyCode } from "@/lib/accountant/link-device";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — check the one-time code and trust this browser for this delivery (G5 M5; public, no session).
 * Body: { publicId, token, code }.
 *
 * The link is checked first. The code: the delivery's newest live one, 10 minutes, 5 wrong attempts, used
 * once (conditional updates — of two concurrent uses exactly one wins). The right code sets an httpOnly,
 * Secure, SameSite=Strict cookie scoped to /api/accountant/link and to this link only, valid until the link
 * expires; the database keeps only its HMAC. The code and the cookie value are never logged or echoed.
 */
export async function POST(req: Request) {
  return withAccountantLink(
    req,
    "ACCOUNTANT_LINK_VERIFY",
    async (link, body, now) => {
      const code = typeof body.code === "string" ? body.code.trim() : "";
      const r = await verifyCode(link.businessId, link.deliveryId, code, link.expiresAt, now);
      if (!r.ok) {
        const error = r.reason === "wrong" ? "CODE_WRONG" : r.reason === "locked" ? "CODE_LOCKED" : r.reason === "expired" ? "CODE_EXPIRED" : "CODE_MISSING";
        return NextResponse.json({ error, attemptsLeft: r.attemptsLeft }, { status: 400, headers: LINK_NO_STORE });
      }
      const res = NextResponse.json({ verified: true }, { headers: LINK_NO_STORE });
      res.headers.append("Set-Cookie", deviceCookie(link.publicId, r.token, r.expiresAt, now));
      return res;
    },
    { device: "not_required" }
  );
}
