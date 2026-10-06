/**
 * GET  /api/business/setup — the owner's setup state: whether the screen is
 *      still due, and what they already said (so returning lands in place).
 * POST /api/business/setup — one of:
 *   { step: "about", description?, audience? }     save what was said so far
 *   { step: "complete", description?, audience? }  save, then finish
 *   { step: "skip" }                               finish without answering
 *
 * The tenant is the session's business, never the body's. Answers go to the
 * owner's identity statements (OWNER_INPUT); nothing here picks a category,
 * a goal or a first action.
 */

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { IdentityInputError } from "@/lib/services/identity/identity-vocabulary";
import { IdentityConflictError } from "@/lib/services/identity/identity-statement.service";
import { validateAbout } from "@/lib/services/onboarding/setup-model";
import { completeSetup, loadSetupState, saveAbout } from "@/lib/services/onboarding/setup.service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const state = await loadSetupState(user.businessId);
    return NextResponse.json(state, { headers: NO_STORE });
  } catch (error) {
    console.error("SETUP_GET_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/** Owner-facing wording for the identity writer's refusals. */
function identityErrorMessage(error: IdentityInputError): string {
  if (/Contact details and links/.test(error.message)) {
    return "בלי טלפון, אימייל או קישור — כאן רק מה שהעסק עושה, במילים שלכם.";
  }
  if (/too long/.test(error.message)) return "הטקסט ארוך מדי — עד 500 תווים.";
  return "לא הצלחנו לשמור את התשובה. אפשר לנסות שוב.";
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

  const actor = { businessId: user.businessId, userId: user.id };
  try {
    if (body.step === "about" || body.step === "complete") {
      const answer = validateAbout({ description: body.description, audience: body.audience });
      if ("error" in answer) {
        const message = answer.error === "description_too_long" ? "הטקסט ארוך מדי — עד 500 תווים." : "התשובה לא תקינה";
        return NextResponse.json({ error: message, code: answer.error }, { status: 400 });
      }
      await saveAbout(actor, answer);
      if (body.step === "complete") await completeSetup(user.businessId);
    } else if (body.step === "skip") {
      await completeSetup(user.businessId);
    } else {
      return NextResponse.json({ error: "Unknown step" }, { status: 400 });
    }
    const state = await loadSetupState(user.businessId);
    return NextResponse.json(state, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof IdentityInputError) {
      return NextResponse.json({ error: identityErrorMessage(error), code: "identity_input" }, { status: 400 });
    }
    if (error instanceof IdentityConflictError) {
      return NextResponse.json({ error: "התשובה השתנתה במקביל. אפשר לנסות שוב." }, { status: 409 });
    }
    console.error("SETUP_POST_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
