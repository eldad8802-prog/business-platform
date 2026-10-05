/**
 * PATCH /api/business/name — the owner renames their business.
 *
 * The tenant is the session's business. The runtime may UPDATE Business.name
 * and nothing else on Business, and B4 pins which row: a transaction for
 * business A cannot reach business B. Renaming lapses any public-use approval
 * of the old name automatically (BusinessIdentityFactAuthority binds a value
 * hash), so the new name is never published on the old approval.
 */

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { MAX_BUSINESS_NAME_LENGTH, MIN_NAME_LENGTH } from "@/lib/auth/signup-identity";
import { renameBusiness } from "@/lib/services/onboarding/setup.service";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let name: unknown;
  try {
    name = ((await req.json()) as { name?: unknown } | null)?.name;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof name !== "string") {
    return NextResponse.json({ error: "יש להזין שם עסק", field: "name" }, { status: 400 });
  }
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME_LENGTH || trimmed.length > MAX_BUSINESS_NAME_LENGTH) {
    return NextResponse.json(
      { error: `שם העסק צריך להכיל ${MIN_NAME_LENGTH}–${MAX_BUSINESS_NAME_LENGTH} תווים`, field: "name" },
      { status: 400 }
    );
  }

  try {
    const out = await renameBusiness(user.businessId, trimmed);
    return NextResponse.json({ success: true, name: out.name });
  } catch (error) {
    console.error("BUSINESS_RENAME_ERROR:", error instanceof Error ? error.message : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
