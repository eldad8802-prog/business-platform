/**
 * Business documents (ר1–ר3) — the HTTP edge shared by its routes. SERVER-ONLY.
 *
 *   - authenticated user only (401); the business comes from the session, never from the request;
 *   - the `business_documents` flag: OFF ⇒ 404, as if the route did not exist (fail-closed: any error reads as OFF);
 *   - known errors ⇒ their status and a Hebrew message; anything else ⇒ 500 with no detail.
 */
import { NextResponse, type NextRequest } from "next/server";

import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";

import { businessDocumentsEnabled } from "./business-documents-access";
import { StoredFileUnavailableError } from "./files/business-docs-files";
import { LetterValidationError } from "./letter/letter.contracts";
import { QuoteCopyRefusedError } from "./quote-share/quote-share-copy.service";
import { QuoteShareEventRefusedError } from "./quote-share/quote-share-events.service";
import { ShareEventValidationError } from "./quote-share/quote-share-state";
import { BusinessDocumentsRequestError } from "./requests/business-docs-requests";

export type BusinessDocumentsContext = { businessId: number; userId: number };

/** A refusal the client can act on: its own status and a stable code, never internal detail. */
const MESSAGES: Record<string, string> = {
  UNKNOWN_KEY: "הבקשה פגה. רעננו את המסך ונסו שוב.",
  EXPIRED: "הטופס פג תוקף. ייתכן שהפעולה כבר נשמרה — בדקו לפני שתנסו שוב.",
  IDEMPOTENCY_CONFLICT: "הבקשה שונתה מאז שנשלחה. רעננו את המסך.",
  IN_PROGRESS: "הפעולה עדיין מתבצעת. נסו שוב בעוד רגע.",
  LEASE_LOST: "הפעולה הופסקה. נסו שוב.",
  NOT_FOUND: "לא נמצא",
  SERVICE_DESK_QUOTE: "הצעה זו שייכת למוקד השירות ומטופלת שם.",
  NO_QUOTE_NUMBER: "להצעה אין עדיין מספר. הפיקו PDF פעם אחת במסך ההצעה, ואז חזרו לכאן.",
  INCOMPLETE_QUOTE: "ההצעה חסרה שם לקוח או שורות.",
  CHANGED_DURING_RENDER: "ההצעה השתנתה בזמן הכנת העותק. נסו שוב.",
  COPY_NOT_FOUND: "העותק לא נמצא.",
  TARGET_NOT_FOUND: "הרישום לתיקון לא נמצא.",
  FILE_UNAVAILABLE: "הקובץ השמור אינו זמין.",
};

function refusal(code: string, status: number): Response {
  return NextResponse.json({ error: code, message: MESSAGES[code] ?? "הבקשה נדחתה" }, { status });
}

/** A positive integer route id, or null. */
export function routeId(value: string): number | null {
  return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2_147_483_647 ? Number(value) : null;
}

export async function businessDocumentsRoute(req: NextRequest, handler: (ctx: BusinessDocumentsContext) => Promise<Response>): Promise<Response> {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    if (!(await businessDocumentsEnabled(user.businessId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return await handler({ businessId: user.businessId, userId: user.id });
  } catch (error) {
    if (error instanceof LetterValidationError) {
      return NextResponse.json({ error: "VALIDATION", problems: error.problems }, { status: 400 });
    }
    if (error instanceof ShareEventValidationError) {
      return NextResponse.json({ error: "VALIDATION", problems: [{ field: error.field, message: error.message }] }, { status: 400 });
    }
    if (error instanceof BusinessDocumentsRequestError || error instanceof QuoteCopyRefusedError || error instanceof QuoteShareEventRefusedError) {
      return refusal(error.code, error.status);
    }
    if (error instanceof StoredFileUnavailableError) return refusal("FILE_UNAVAILABLE", 410);
    return handleError(error);
  }
}

/** JSON body, refusing anything that is not a plain object or is larger than `maxBytes`. */
export async function readJsonBody(req: NextRequest, maxBytes = 64_000): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new LetterValidationError([{ field: "body", message: "הטקסט ארוך מדי" }]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LetterValidationError([{ field: "body", message: "בקשה לא תקינה" }]);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LetterValidationError([{ field: "body", message: "בקשה לא תקינה" }]);
  }
  return parsed as Record<string, unknown>;
}
