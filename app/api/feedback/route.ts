import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const body = await req.json();

    const {
      success,
      content,
      goal,
      valueType,
      category,
      customerType,
      serviceLevel,
      tone,
    } = body;

    const saved = await prisma.contentFeedback.create({
      data: {
        success,
        goal,
        valueType,
        category,
        customerType,
        serviceLevel,
        tone,
        hook: content?.hook,
        idea: content?.idea,
        script: content?.script,
      },
    });

    return NextResponse.json({ ok: true, id: saved.id });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}