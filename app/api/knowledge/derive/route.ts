import { NextRequest, NextResponse } from "next/server";
import { decideRecoveryAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { deriveKnowledgeForBusiness } from "@/lib/knowledge/derive.service";
import { resolveIdentitiesForBusiness } from "@/lib/identity/entity-identity.service";
import { generateInsightsForBusiness } from "@/lib/knowledge/insight.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { getBusinessStatusSnapshot } from "@/lib/business-status/business-status.service";

/**
 * M2–M5 — derive one business's knowledge, inside the runtime.
 *
 * WHY A ROUTE AND NOT A WORKFLOW
 *
 * The first attempt at this ran from GitHub Actions, and it refused to write. Correctly: the
 * `production-db` environment's connection is a privileged one, which is right for migrations (they
 * need DDL) and useless for proving tenant enforcement, because a privileged role satisfies every RLS
 * policy no matter what the GUC says. A run there would have produced real numbers and a hollow claim.
 *
 * The application runtime connects as a least-privilege role that cannot bypass RLS. So the only
 * place a derivation can prove BOTH that the rules are right and that the tenant context reaches the
 * database is inside the runtime itself. That is this route.
 *
 * AUTHENTICATION is the scheduler's, not a user's: the same CRON_SECRET bearer contract the settlement
 * recovery route uses, fail-closed on a missing or placeholder secret. There is no session, no UI and
 * no navigation entry — a business owner cannot reach this, and neither can a logged-in user.
 *
 * THE TENANT IS EXPLICIT. One businessId, derived for exactly that one. A sweep across tenants is a
 * decision about cadence and cost that nobody has the numbers to make yet; the per-source timings in
 * this response are how those numbers get collected.
 *
 * ORDER MATTERS: identity resolves BEFORE the rules run. Two of the document rules are keyed on a
 * `Party`, so a vendor that has not been anchored yet produces no measure at all — running the rules
 * first would report an honest but needlessly empty result on the very first derivation.
 *
 * THE RESPONSE CARRIES NO IDENTIFIERS beyond the businessId the caller already supplied, and no
 * business content: statuses, counts, rule ids, versions, durations. No vendor name, no payee, no
 * amount, no fact text.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Every tenant table the knowledge layer writes, and the two M5 evidence tables. */
const ISOLATION_TABLES = [
  "KnowledgeMeasure",
  "BusinessInsight",
  "PartyResolutionClaim",
  "EntityLinkProposal",
  "CollectionAction",
  "LearningEvent",
];

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

    // The L0 fact layer, reported per domain. Three of these loaders (inventory alerts, leads,
    // supplier drafts) read through the global client until M1 and returned NOTHING under this exact
    // credential, silently, behind a green 200. A per-domain count is the shortest statement that the
    // silence is over, and it can be compared against a direct query.
    const snapshot = await runWithTenantContext({ businessId }, () =>
      getBusinessStatusSnapshot(businessId)
    );
    const byDomain: Record<string, number> = {};
    for (const item of snapshot.items) {
      byDomain[item.domain] = (byDomain[item.domain] ?? 0) + 1;
    }

    const identity = await resolveIdentitiesForBusiness(businessId);
    const derivation = await deriveKnowledgeForBusiness(businessId);
    const insights = await generateInsightsForBusiness(businessId);

    // ISOLATION, measured on this connection rather than asserted. Catalog flags and row COUNTS only.
    //
    //   rls          each knowledge table has RLS enabled AND forced, and what this role may do to it
    //   withoutTenant rows visible with no tenant set — must be zero, or FORCE RLS is not holding
    //   foreignRows  rows of any OTHER business visible from inside this tenant — must be zero
    const { tenantTx } = await import("@/lib/tenant/tenant-tx");
    const rls = await prisma.$queryRawUnsafe<
      { t: string; rls: boolean; force: boolean; sel: boolean; ins: boolean; upd: boolean; del: boolean }[]
    >(
      `SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              has_table_privilege(current_user, c.oid, 'SELECT') AS sel,
              has_table_privilege(current_user, c.oid, 'INSERT') AS ins,
              has_table_privilege(current_user, c.oid, 'UPDATE') AS upd,
              has_table_privilege(current_user, c.oid, 'DELETE') AS del
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      ISOLATION_TABLES
    );
    const withoutTenant: Record<string, number> = {};
    const foreignRows: Record<string, number> = {};
    for (const t of ISOLATION_TABLES) {
      const bare = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${t}"`
      );
      withoutTenant[t] = bare[0]?.n ?? -1;
      const scoped = await tenantTx(businessId, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM "${t}" WHERE "businessId" <> $1`,
          businessId
        )
      );
      foreignRows[t] = scoped[0]?.n ?? -1;
    }

    return NextResponse.json(
      {
        ok: true,
        businessId,
        role: { name: role?.u, superuser: role?.s, bypassrls: role?.b },
        proofLevel: role?.b === false && role?.s === false ? "FULL" : "DERIVATION-ONLY",
        facts: { total: snapshot.items.length, byDomain, snapshotTenant: snapshot.businessId },
        identity,
        knowledge: {
          rulesRun: derivation.rulesRun,
          rulesOk: derivation.rulesOk,
          rulesFailed: derivation.rulesFailed,
          measuresActive: derivation.measuresActive,
          measuresInsufficient: derivation.measuresInsufficient,
          measuresStaled: derivation.measuresStaled,
          measuresSuperseded: derivation.measuresSuperseded,
          totalDurationMs: derivation.totalDurationMs,
          sources: derivation.sourcesLoaded,
          // Per rule: WHAT ran and HOW it ended — never what it learned. No value, no entity id, no
          // trend, no error text. This body is printed into the dispatch workflow's log, and that log
          // is as public as the repository; the learned numbers live in the tenant's own rows.
          rules: derivation.rules.map((r) => ({
            ruleId: r.ruleId,
            ruleVersion: r.ruleVersion,
            outcome: r.outcome,
            failedStage: r.failedStage,
            measures: r.measures.length,
            active: r.active,
            insufficient: r.insufficient,
            staled: r.staled,
            superseded: r.superseded,
            observations: r.measures.reduce((s, m) => s + m.observationCount, 0),
            durationMs: r.durationMs,
          })),
        },
        isolation: {
          rls,
          withoutTenant,
          foreignRows,
          holds:
            rls.length === ISOLATION_TABLES.length &&
            rls.every((x) => x.rls && x.force) &&
            Object.values(withoutTenant).every((n) => n === 0) &&
            Object.values(foreignRows).every((n) => n === 0),
        },
        insights: insights.length,
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
