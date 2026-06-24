import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

/**
 * Apply a recommendation (Stage 6) — DELIBERATE PLACEHOLDER, disabled.
 *
 * Applying would write runtime config (questions / knowledge / actions). That is
 * intentionally NOT built yet — it must stay opt-in and safe. Returns 501 so
 * nothing can change runtime via this path. The owner applies a suggestion
 * manually in the relevant builder screen for now.
 */
export async function POST(
  req: Request,
  _ctx: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);

  return NextResponse.json(
    {
      error: "Applying recommendations is not implemented yet",
      code: "RECOMMENDATION_APPLY_DISABLED",
    },
    { status: 501 }
  );
}
