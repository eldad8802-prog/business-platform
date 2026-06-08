import { NextResponse } from "next/server";
import { runMatchingEngine } from "@/lib/collaboration/matchingEngine";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const body = await req.json();

    const { category, subCategory } = body;

    const deals = await runMatchingEngine({
      businessId: user.businessId,
      category,
      subCategory,
    });

    return NextResponse.json(deals);
  } catch (error: any) {
    return NextResponse.json(
      { error: "Failed to generate deals", details: error.message },
      { status: 500 }
    );
  }
}