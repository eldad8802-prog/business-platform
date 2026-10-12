import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { isEmailVerificationEnabled } from "@/lib/auth/account-recovery-config";
import { readEmailVerified } from "@/lib/auth/email-tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The signed-in owner's own verification state — what the shell banner needs. With verification OFF it
 * answers before anything is read — not even the session — so the banner stays hidden at no cost, and
 * the answer ("off") says nothing about anyone.
 */
export type StatusDeps = {
  enabled: () => boolean;
  currentUser: (req: Request) => Promise<{ id: number } | null>;
  readVerified: (userId: number) => Promise<boolean | null>;
};

const defaultDeps: StatusDeps = {
  enabled: isEmailVerificationEnabled,
  currentUser: getCurrentUser,
  readVerified: readEmailVerified,
};
const NO_STORE = { "Cache-Control": "no-store" };

export async function handleStatus(req: Request, deps: StatusDeps = defaultDeps): Promise<NextResponse> {
  try {
    if (!deps.enabled()) return NextResponse.json({ verificationEnabled: false }, { headers: NO_STORE });
    const user = await deps.currentUser(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    const verified = await deps.readVerified(user.id);
    return NextResponse.json({ verificationEnabled: true, verified: verified === true }, { headers: NO_STORE });
  } catch (error) {
    console.error("[auth] email_status_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "Server error" }, { status: 500, headers: NO_STORE });
  }
}

export async function GET(req: Request) {
  return handleStatus(req);
}
