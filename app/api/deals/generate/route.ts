import { NextResponse } from "next/server";
import { runMatchingEngine } from "@/lib/collaboration/matchingEngine";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Business identity is derived from the AUTHENTICATED tenant, never trusted
    // from the client (F-25 · 4A) — any category/subCategory in the request body
    // is deliberately ignored. The BusinessProfile read runs INSIDE the tenant
    // context/transaction so it is tenant-scoped by RLS under the least-privilege
    // runtime role (withTenantTransaction sets app.current_business_id on the tx;
    // BusinessProfile is D2-RLS-wired + SELECT-granted). BusinessProfile is the
    // single source of truth for identity.
    const result = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const profile = await tx.businessProfile.findUnique({
            where: { businessId: user.businessId },
            select: { category: true, subCategory: true },
          });

          // Fail-safe (F-25 · 4B): without a real, complete identity we do not
          // fabricate recommendations — return a structured state the UI explains.
          if (!profile) {
            return { status: "no_profile" as const };
          }
          if (!profile.category || !profile.subCategory) {
            return { status: "incomplete_profile" as const };
          }

          return runMatchingEngine(
            {
              businessId: user.businessId,
              category: profile.category,
              subCategory: profile.subCategory,
            },
            { tx }
          );
        })
    );

    switch (result.status) {
      case "no_profile":
        return NextResponse.json({ status: "no_profile" });
      case "incomplete_profile":
        return NextResponse.json({ status: "incomplete_profile" });
      case "no_matches":
        return NextResponse.json({ status: "no_matches" });
      default:
        return NextResponse.json({ status: "ok", deals: result.deals });
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: "Failed to generate deals", details: error.message },
      { status: 500 }
    );
  }
}