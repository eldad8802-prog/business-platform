import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import { createPayee, listPayees } from "@/lib/services/payables/payables.service";
import type { PayeeKindValue } from "@/lib/services/payables/payables.service";
import {
  handlePayablesError,
  optionalString,
  readJsonBody,
  requiredString,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

const PAYEE_KINDS: readonly PayeeKindValue[] = [
  "SUPPLIER",
  "AUTHORITY",
  "UTILITY",
  "LANDLORD",
  "EMPLOYEE",
  "LENDER",
  "INSURER",
  "OTHER",
];

/** GET — payee search, for the combobox. Active payees only. */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const query = req.nextUrl.searchParams.get("q");

    const payees = await runWithTenantContext({ businessId: user.businessId }, () =>
      listPayees({ businessId: user.businessId, query }),
    );

    return NextResponse.json({
      payees: payees.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        kind: p.kind,
      })),
    });
  } catch (error) {
    return handlePayablesError(error);
  }
}

/**
 * POST — create a payee.
 *
 * Deliberately NOT linked to Supplier. A payee and a supplier may describe the
 * same real organisation, but the ratified party strategy resolves that sameness
 * at Tier 3; a foreign key between them here is explicitly prohibited.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const body = await readJsonBody(req);

    const kindRaw = body.kind;
    if (
      kindRaw != null &&
      (typeof kindRaw !== "string" || !PAYEE_KINDS.includes(kindRaw as PayeeKindValue))
    ) {
      throw new ValidationError("invalid payee kind");
    }

    const payee = await runWithTenantContext({ businessId: user.businessId }, () =>
      createPayee({
        businessId: user.businessId,
        displayName: requiredString(body, "displayName"),
        kind: (kindRaw as PayeeKindValue | undefined) ?? undefined,
        legalName: optionalString(body, "legalName"),
        taxId: optionalString(body, "taxId"),
        note: optionalString(body, "note"),
      }),
    );

    return NextResponse.json(
      { payee: { id: payee.id, displayName: payee.displayName, kind: payee.kind } },
      { status: 201 },
    );
  } catch (error) {
    return handlePayablesError(error);
  }
}
