import { NextRequest, NextResponse } from "next/server";
import { decideRecoveryAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { derivePaperworkLagForBusiness } from "@/lib/knowledge/paperwork-lag.service";
import { generateInsightsForBusiness } from "@/lib/knowledge/insight.service";

/**
 * M2/M3 — derive one business's knowledge, inside the runtime.
 *
 * WHY A ROUTE AND NOT A WORKFLOW
 *
 * The first attempt at this ran from GitHub Actions, and it refused to write. Correctly: the
 * `production-db` environment's connection is a privileged one, which is right for migrations (they
 * need DDL) and useless for proving tenant enforcement, because a privileged role satisfies every RLS
 * policy no matter what the GUC says. A run there would have produced real numbers and a hollow claim.
 *
 * The application runtime connects as `app_runtime_prod` — NOBYPASSRLS. So the only place a derivation
 * can prove BOTH that the rules are right and that the tenant context reaches the database is inside
 * the runtime itself. That is this route.
 *
 * AUTHENTICATION is the scheduler's, not a user's: the same CRON_SECRET bearer contract the settlement
 * recovery route uses, fail-closed on a missing or placeholder secret. There is no session, no UI and
 * no navigation entry — a business owner cannot reach this, and neither can a logged-in user.
 *
 * THE TENANT IS EXPLICIT. Unlike settlement recovery, which sweeps every tenant server-side, this takes
 * one businessId and derives for exactly that one. A sweep is an M4 decision about cadence and cost;
 * proving the pipeline does not require one, and running one before it is understood would be the
 * expensive way to find out what these rules cost.
 *
 * THE RESPONSE CARRIES NO IDENTIFIERS beyond the businessId the caller already supplied: statuses,
 * counts, rule versions and a measure id. No vendor, no payee, no fact text.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideRecoveryAuth(
    req.headers.get("authorization"),
    process.env.CRON_SECRET
  );
  if (decision === "NOT_CONFIGURED") {
    return NextResponse.json({ error: "derive_not_configured" }, { status: 503 });
  }
  if (decision !== "AUTHORIZED") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = new URL(req.url).searchParams.get("businessId");
  const businessId = Number(raw);
  if (!Number.isInteger(businessId) || businessId <= 0) {
    return NextResponse.json({ error: "businessId must be a positive integer" }, { status: 400 });
  }

  try {
    // Posture is reported, not assumed. If this ever runs as a role that can bypass RLS, the response
    // says so, and the run stops being evidence of tenant enforcement — which is a thing the reader
    // must be able to see rather than infer from where the request happened to be sent.
    const { prisma } = await import("@/lib/prisma");
    const posture = await prisma.$queryRawUnsafe<{ u: string; s: boolean; b: boolean }[]>(
      `SELECT current_user AS u, rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`
    );
    const role = posture[0];

    const measure = await derivePaperworkLagForBusiness(businessId);
    const insights = await generateInsightsForBusiness(businessId);

    return NextResponse.json(
      {
        ok: true,
        businessId,
        role: { name: role?.u, superuser: role?.s, bypassrls: role?.b },
        proofLevel: role?.b === false && role?.s === false ? "FULL" : "DERIVATION-ONLY",
        measure:
          measure.kind === "written"
            ? {
                status: measure.result.status,
                valueNumeric: measure.result.valueNumeric,
                valueUnit: measure.result.valueUnit,
                observationCount: measure.result.observationCount,
                trend: measure.result.trend,
                windowStart: measure.result.windowStart.toISOString(),
                windowEnd: measure.result.windowEnd.toISOString(),
                evidenceRefs: measure.result.evidenceSet.refs.length,
                writerAction: measure.write.action,
                measureId: measure.write.measureId,
              }
            : { failed: true, stage: measure.stage },
        insights,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[knowledge/derive] run failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ ok: false, error: "derive_failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
