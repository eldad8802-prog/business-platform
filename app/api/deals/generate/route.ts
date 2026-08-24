import { NextResponse } from "next/server";
import { runMatchingEngine } from "@/lib/collaboration/matchingEngine";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Business identity is derived from the AUTHENTICATED tenant, never trusted
    // from the client (F-25 · 4A). Any category/subCategory in the request body
    // is deliberately ignored — the client is not a source of truth for who the
    // business is. BusinessProfile is the single source of truth.
    const profile = await prisma.businessProfile.findUnique({
      where: { businessId: user.businessId },
      select: { category: true, subCategory: true },
    });

    // Fail-safe (F-25 · 4B): without a real, complete identity we do not
    // fabricate recommendations — we return a structured state the UI explains.
    if (!profile) {
      return NextResponse.json({ status: "no_profile" });
    }
    if (!profile.category || !profile.subCategory) {
      return NextResponse.json({ status: "incomplete_profile" });
    }
    const category = profile.category;
    const subCategory = profile.subCategory;

    const result = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          runMatchingEngine(
            {
              businessId: user.businessId,
              category,
              subCategory,
            },
            { tx }
          )
        )
    );

    if (result.status === "no_matches") {
      return NextResponse.json({ status: "no_matches" });
    }

    return NextResponse.json({ status: "ok", deals: result.deals });
  } catch (error: any) {
    return NextResponse.json(
      { error: "Failed to generate deals", details: error.message },
      { status: 500 }
    );
  }
}