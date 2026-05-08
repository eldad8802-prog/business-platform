import { NextRequest, NextResponse } from "next/server";
import { generateAIContent } from "@/lib/services/ai-content.service";
import { getCurrentUser } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    const {
      type,
      category,
      goal,
      audience,
      valueType,
      style,
      mode,
    } = body;

    if (!type) {
      return NextResponse.json(
        { error: "type is required" },
        { status: 400 }
      );
    }

    const content = await generateAIContent({
      type,
      category,
      goal,
      audience,
      valueType,
      style,
      mode,
    });

    return NextResponse.json({ content });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Failed to generate content" },
      { status: 500 }
    );
  }
}