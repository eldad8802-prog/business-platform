/**
 * GET /api/platform-admin/passkeys — this admin's active passkeys and whether
 * passkeys can be used here. Full guard (admin + MFA elevation).
 */
import { NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { listActivePasskeys, passkeyAvailability } from "@/lib/auth/admin-passkey.service";
import { NO_STORE, passkeyFailure } from "@/lib/auth/admin-passkey-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await requirePlatformAdminOrResponse(req);
  if (gate instanceof NextResponse) return gate;

  const availability = passkeyAvailability();
  if (!availability.enabled) {
    return NextResponse.json(
      { available: false, reason: availability.reason, passkeys: [] },
      { status: 200, headers: NO_STORE }
    );
  }
  try {
    const passkeys = await listActivePasskeys(gate.id);
    return NextResponse.json({ available: true, passkeys }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return passkeyFailure("ADMIN_PASSKEY_LIST_ERROR", error);
  }
}
