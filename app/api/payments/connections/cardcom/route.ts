import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { connectPaymentProvider } from "@/lib/services/payments/payment-connection.service";
import { paymentConnectionDeps } from "@/lib/services/payments/payments.deps";

export const runtime = "nodejs";

/**
 * Connect (or update) the business's CardCom connection.
 *
 * Connection model (no schema change — reuses the encrypted credential column):
 *   merchantId  = CardCom TerminalNumber
 *   credential  = JSON { apiName, apiPassword }  (encrypted at rest)
 *
 * The API password is write-only: it is sent here, encrypted, and never
 * returned. The response carries only the public connection shape (no secrets).
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown> = {};
    try {
      const parsed = (await req.json()) as unknown;
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }

    // Accept either `merchantId` or `terminalNumber` for the terminal.
    const terminalRaw =
      typeof body.merchantId === "string"
        ? body.merchantId
        : typeof body.terminalNumber === "string"
          ? body.terminalNumber
          : "";
    const apiName = typeof body.apiName === "string" ? body.apiName : "";
    const apiPassword =
      typeof body.apiPassword === "string" ? body.apiPassword : "";

    if (!terminalRaw.trim()) {
      throw new ValidationError("terminalNumber (merchantId) is required");
    }
    if (!apiName.trim()) {
      throw new ValidationError("apiName is required");
    }
    if (!apiPassword) {
      throw new ValidationError("apiPassword is required");
    }

    const connection = await connectPaymentProvider(
      {
        businessId: user.businessId,
        provider: "CARDCOM",
        merchantId: terminalRaw.trim(),
        // Provider-specific secret shape, encrypted as a single opaque blob.
        credential: JSON.stringify({ apiName: apiName.trim(), apiPassword }),
        isActive: typeof body.isActive === "boolean" ? body.isActive : true,
      },
      paymentConnectionDeps()
    );

    return NextResponse.json({ connection }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
