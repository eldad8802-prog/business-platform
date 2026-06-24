import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

/**
 * Activate (Stage 3) — DELIBERATE PLACEHOLDER, disabled.
 *
 * Real activation would materialize the assembled base into BusinessBotSettings
 * (the one controlled write to live runtime). That is intentionally NOT built
 * yet. This endpoint exists only to document intent and returns 501 so nothing
 * can accidentally write runtime config. Do NOT implement materialization here
 * without an explicit, separately-approved step.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);

  return NextResponse.json(
    {
      error: "Setup activation is not implemented yet",
      code: "SETUP_ACTIVATE_DISABLED",
    },
    { status: 501 }
  );
}
