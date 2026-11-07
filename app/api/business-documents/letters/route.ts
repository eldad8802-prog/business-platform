/**
 * Saved letters.
 *   GET  /api/business-documents/letters → the saved letters that are not hidden, newest first.
 *   POST /api/business-documents/letters {idempotencyKey, ...letter} → render, store (create-once), record with a
 *        snapshot of what was printed. A retry with the same key returns the same letter. Nothing is sent.
 * Session + flag (404 when off).
 */
import { NextResponse, type NextRequest } from "next/server";

import { businessDocumentsRoute, readJsonBody } from "@/lib/services/business-documents/business-documents-http";
import { parseLetterInput } from "@/lib/services/business-documents/letter/letter.contracts";
import { saveLetter } from "@/lib/services/business-documents/letter/saved-letters-save.service";
import { listSavedLetters } from "@/lib/services/business-documents/letter/saved-letters.service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return businessDocumentsRoute(req, async ({ businessId }) => {
    return NextResponse.json({ letters: await listSavedLetters(businessId) }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function POST(req: NextRequest) {
  return businessDocumentsRoute(req, async ({ businessId, userId }) => {
    const body = await readJsonBody(req);
    const { idempotencyKey, ...raw } = body;
    const letter = parseLetterInput(raw);
    const saved = await saveLetter({ businessId, userId, letter, idempotencyKey: String(idempotencyKey ?? "") });
    return NextResponse.json(saved, { status: saved.replay ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  });
}
