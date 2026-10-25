import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import {
  listObligations,
  recognizeObligation,
} from "@/lib/services/obligations/obligation.service";
import { obligationServiceDeps } from "@/lib/services/obligations/obligations.deps";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { toObligationApi } from "@/lib/services/obligations/obligation-api.serializer";
import type { InstallmentPlanInput, RecurrenceCadence } from "@/lib/services/obligations/obligations.types";

export const runtime = "nodejs";

const RECURRENCE_VALUES: readonly RecurrenceCadence[] = [
  "NONE",
  "WEEKLY",
  "MONTHLY",
  "BIMONTHLY",
  "QUARTERLY",
  "SEMIANNUAL",
  "YEARLY",
];

function parseRecurrence(value: unknown): RecurrenceCadence | undefined {
  if (value == null) return undefined;
  if (
    typeof value !== "string" ||
    !RECURRENCE_VALUES.includes(value as RecurrenceCadence)
  ) {
    throw new ValidationError("invalid recurrence cadence");
  }
  return value as RecurrenceCadence;
}

function parseDueAt(value: unknown): Date {
  if (typeof value !== "string" || value === "") {
    throw new ValidationError("dueAt is required (ISO date string)");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError("dueAt must be a valid date");
  }
  return date;
}

/** Optional (25.10.2026): an existing payee of this business. Absent or null keeps the request as before. */
function parsePayeeId(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError("payeeId must be a positive integer");
  }
  return value;
}

/** Optional (25.10.2026): a real payment plan — `amount` is then its total. The service checks the ranges. */
function parseInstallmentPlan(value: unknown): InstallmentPlanInput | null {
  if (value == null) return null;
  if (typeof value !== "object") throw new ValidationError("installmentPlan must be an object");
  const plan = value as { count?: unknown; cadence?: unknown };
  if (typeof plan.count !== "number") throw new ValidationError("installmentPlan.count must be a number");
  const cadence = parseRecurrence(plan.cadence);
  if (cadence === undefined || cadence === "NONE") throw new ValidationError("installmentPlan.cadence is required");
  return { count: plan.count, cadence };
}

/**
 * Create (recognize) a new obligation — the secretary begins remembering it. Optional `payeeId` and
 * `installmentPlan` (owner-approved, 25.10.2026) make P3 the one way to create a commitment; a request without
 * them behaves exactly as before.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    let body: Record<string, unknown> = {};
    try {
      const parsed = (await req.json()) as unknown;
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }

    if (body.obligeeName == null) {
      throw new ValidationError("obligeeName is required");
    }
    if (body.amount == null) {
      throw new ValidationError("amount is required");
    }

    const obligation = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          recognizeObligation(
            {
              businessId: user.businessId,
              obligeeName: String(body.obligeeName),
              amount: body.amount as string | number,
              currency:
                typeof body.currency === "string" ? body.currency : undefined,
              dueAt: parseDueAt(body.dueAt),
              recurrence: parseRecurrence(body.recurrence),
              note: typeof body.note === "string" ? body.note : null,
              payeeId: parsePayeeId(body.payeeId),
              installmentPlan: parseInstallmentPlan(body.installmentPlan),
            },
            obligationServiceDeps({ tx, actorUserId: user.id })
          )
        )
    );

    return NextResponse.json(toObligationApi(obligation), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

/** List obligations for the business (OPEN by default; ?includeClosed=1 for all). */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { searchParams } = req.nextUrl;
    const includeClosed = searchParams.get("includeClosed") === "1";

    const limitRaw = searchParams.get("limit");
    let limit: number | undefined;
    if (limitRaw != null && limitRaw !== "") {
      const num = Number(limitRaw);
      if (!Number.isInteger(num) || num <= 0 || num > 500) {
        throw new ValidationError("limit must be an integer between 1 and 500");
      }
      limit = num;
    }

    const records = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          listObligations(user.businessId, obligationServiceDeps({ tx }), {
            includeClosed,
            limit,
          })
        )
    );

    return NextResponse.json(
      { obligations: records.map(toObligationApi) },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
