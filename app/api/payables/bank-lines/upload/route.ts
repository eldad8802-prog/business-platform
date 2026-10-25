import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  optionalPositiveInt,
  readJsonBody,
} from "@/lib/services/payables/payables-http";
import * as obs from "@/lib/services/payables/payables-observation.service";
import { bankFileImportState } from "@/lib/services/bank-file-import/http";

export const runtime = "nodejs";

/**
 * Upload the CSV the owner's bank exports. Idempotent: re-uploading an
 * overlapping statement adds only the lines not already known.
 *
 * For a business with bank file import ON this upload is closed (409): statements go through
 * /payables/bank/import, where the account is required — a statement uploaded here without an account
 * cannot be told apart from another account's identical lines. If the flag cannot be resolved the upload
 * is refused too (503), never opened. With the flag OFF nothing here changes.
 */
export async function POST(
  req: NextRequest,
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const importState = await bankFileImportState(user.businessId);
    if (importState !== "OFF") {
      return NextResponse.json(
        importState === "ON"
          ? { error: "העלאת קובץ בנק נעשית עכשיו במסך קליטת קובץ בנק.", code: "BANK_FILE_IMPORT_REQUIRED" }
          : { error: "לא ניתן להעלות כרגע. נסו שוב בעוד רגע.", code: "BANK_FILE_IMPORT_STATE_UNKNOWN" },
        { status: importState === "ON" ? 409 : 503, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const body = await readJsonBody(req);
    const csvText = typeof body.csvText === "string" ? body.csvText : "";
    if (!csvText.trim()) throw new ValidationError("csvText is required");
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      obs.uploadStatement({
        businessId: user.businessId,
        actorUserId: user.id,
        sourceBankAccountId: optionalPositiveInt(body, "sourceBankAccountId"),
        csvText,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
