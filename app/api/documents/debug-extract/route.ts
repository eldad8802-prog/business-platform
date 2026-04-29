import { NextRequest, NextResponse } from "next/server";
import { runExtractionEngine } from "@/lib/services/documents/extraction-engine.service";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = body?.text;

    if (!text || typeof text !== "string") {
      return NextResponse.json(
        { error: "Missing text" },
        { status: 400 }
      );
    }

    const result = await runExtractionEngine(1, text);

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("DEBUG EXTRACT ERROR:", error);

    return NextResponse.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}