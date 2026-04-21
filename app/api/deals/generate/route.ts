import { NextResponse } from "next/server";
import { runMatchingEngine } from "@/lib/collaboration/matchingEngine";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const { businessId, category, subCategory } = body;

    const deals = await runMatchingEngine({
      businessId,
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