import { NextRequest, NextResponse } from "next/server";
import { improveContent } from "@/lib/services/content-improve.service";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      mode,
      goal,
      intent,
      audienceDescription,
      selectedFormat,
      script,
      instructions,
      userPrompt,
    } = body;

    if (!script || !userPrompt) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const result = await improveContent({
      mode,
      goal,
      intent,
      audienceDescription,
      selectedFormat,
      script,
      instructions: Array.isArray(instructions) ? instructions : [],
      userPrompt,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to improve content" },
      { status: 500 }
    );
  }
}