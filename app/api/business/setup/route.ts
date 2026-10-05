/**
 * GET  /api/business/setup — the owner's setup state and Home's "your start".
 * POST /api/business/setup — one step at a time:
 *   { step: "business", category, subCategory, businessModel }
 *   { step: "start", goal: "LEADS" | "BILLING" | "DOCUMENTS" | "CONTENT" | null }
 *
 * The tenant is the session's business, never the body's. A skipped business
 * step writes nothing; a skipped start step records a DEFAULTED goal.
 */

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { isSetupGoal, validateBusinessAnswer } from "@/lib/services/onboarding/setup-model";
import {
  completeSetup,
  loadSetupState,
  saveBusinessAnswer,
} from "@/lib/services/onboarding/setup.service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const state = await loadSetupState(user.businessId);
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("SETUP_GET_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    if (body.step === "business") {
      const answer = validateBusinessAnswer({
        category: body.category,
        subCategory: body.subCategory,
        businessModel: body.businessModel,
      });
      if (!answer) {
        return NextResponse.json({ error: "יש לבחור תחום, תת-תחום ומה העסק מוכר" }, { status: 400 });
      }
      await saveBusinessAnswer({ businessId: user.businessId, userId: user.id }, answer);
    } else if (body.step === "start") {
      if (body.goal !== null && !isSetupGoal(body.goal)) {
        return NextResponse.json({ error: "בחירה לא מוכרת" }, { status: 400 });
      }
      await completeSetup(user.businessId, body.goal);
    } else {
      return NextResponse.json({ error: "Unknown step" }, { status: 400 });
    }

    const state = await loadSetupState(user.businessId);
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("SETUP_POST_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
