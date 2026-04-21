import { NextRequest, NextResponse } from "next/server";
import { getContentDirections } from "@/lib/services/content-decision.service";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const { category, subCategory, businessModel, hasContentActivity } = body;

    if (!category) {
      return NextResponse.json(
        { error: "category is required" },
        { status: 400 }
      );
    }

    const directions = getContentDirections({
      category,
      subCategory,
      businessModel,
      hasContentActivity,
    });

    return NextResponse.json({ directions });
  } catch (error) {
    console.error("Content Directions Error:", error);

    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}