/**
 * Business Memory · SHADOW-COMPARISON-2 · Dry-run comparison RUNNER (read-only, gated).
 *
 * Executes the REAL Business Memory read/derive pipeline against Production ReviewEvent evidence and
 * prints a per-subject comparison (expected-from-evidence vs engine-derived) as JSON. It performs ZERO
 * writes. Defense in depth against any write:
 *
 *   1. DB SESSION READ-ONLY: the connection URL carries `options=-c default_transaction_read_only=on`,
 *      so Postgres itself rejects any write on this session.
 *   2. FAIL-CLOSED PROOF: at startup it asks the server `SHOW default_transaction_read_only` and ABORTS
 *      unless the session reports `on`. If the session is not read-only, it never runs.
 *   3. NO WRITE PRIMITIVES: it imports only read/pure stages (resolver, evidence reader core, pure
 *      deriver). It never imports the claim writer / orchestrator and never calls a Prisma write. A
 *      static guard test enforces this.
 *
 * It is an OPS TOOL invoked only by the gated workflow — not a product/admin reader, no HTTP surface.
 * Inputs come from env (BID / SKEY), are validated, and are used only as a tenant filter.
 */
import { PrismaClient } from "@prisma/client";
import { resolveVendorCategoryPolicyVersion } from "@/lib/business-memory/policy";
import type { ReviewEventRow } from "@/lib/business-memory/evidence";
import { compareTenant, type ResolvedPolicy } from "./dry-run-comparison.core";

const READ_ONLY_OPTION = "-c default_transaction_read_only=on";

/** Merge a read-only `options` startup parameter into a Postgres URL (preserving any existing options). */
export function buildReadOnlyUrl(raw: string): string {
  const hashIdx = raw.indexOf("#");
  const beforeHash = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
  const qIdx = beforeHash.indexOf("?");
  if (qIdx === -1) {
    return `${beforeHash}?options=${encodeURIComponent(READ_ONLY_OPTION)}`;
  }
  const base = beforeHash.slice(0, qIdx);
  const params = beforeHash.slice(qIdx + 1).split("&").filter(Boolean);
  let found = false;
  const merged = params.map((p) => {
    const eq = p.indexOf("=");
    const key = eq === -1 ? p : p.slice(0, eq);
    if (key === "options") {
      found = true;
      const existing = decodeURIComponent(p.slice(eq + 1));
      return `options=${encodeURIComponent(`${READ_ONLY_OPTION} ${existing}`)}`;
    }
    return p;
  });
  if (!found) merged.push(`options=${encodeURIComponent(READ_ONLY_OPTION)}`);
  return `${base}?${merged.join("&")}`;
}

function requirePositiveInt(raw: string | undefined, name: string): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (got: ${JSON.stringify(raw)})`);
  }
  return n;
}

/** Assert the DB session is read-only at the server; throw (fail-closed) otherwise. */
async function assertSessionReadOnly(client: PrismaClient): Promise<void> {
  // Fixed, read-only introspection (SHOW). Not a data read, not a write, not user input.
  const rows = (await client.$queryRawUnsafe(
    "SHOW default_transaction_read_only",
  )) as Array<Record<string, string>>;
  const value = rows?.[0]?.default_transaction_read_only;
  if (value !== "on") {
    throw new Error(
      `refusing to run: DB session is NOT read-only (default_transaction_read_only=${String(value)})`,
    );
  }
}

async function main(): Promise<void> {
  const businessId = requirePositiveInt(process.env.BID, "BID (businessId)");
  const subjectFilter = (process.env.SKEY ?? "").trim() || null;

  const rawUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DIRECT_URL (or DATABASE_URL) must be set");

  const client = new PrismaClient({
    datasources: { db: { url: buildReadOnlyUrl(rawUrl) } },
  });

  try {
    await assertSessionReadOnly(client); // fail-closed BEFORE any read

    const resolved = await resolveVendorCategoryPolicyVersion(
      client as unknown as Parameters<typeof resolveVendorCategoryPolicyVersion>[0],
    );
    const policy: ResolvedPolicy = {
      policyKey: resolved.policyKey,
      versionLabel: resolved.versionLabel,
      policyVersionId: resolved.policyVersionId,
    };

    const rows = (await client.reviewEvent.findMany({
      where: { businessId },
      select: {
        id: true,
        businessId: true,
        occurredAt: true,
        vendorFinal: true,
        directionFinal: true,
        verdicts: true,
      },
    })) as unknown as ReviewEventRow[];

    const { rows: comparison, totalSubjects, truncated } = compareTenant(
      rows,
      businessId,
      policy,
      { subjectFilter, maxSubjects: 500 },
    );

    const summary = comparison.reduce<Record<string, number>>((acc, r) => {
      acc[r.classification] = (acc[r.classification] ?? 0) + 1;
      return acc;
    }, {});

    // Output: normalized subjects + categories + counts only. No raw vendor, no amounts, no customer data.
    process.stdout.write(
      JSON.stringify(
        {
          tool: "business-memory-dry-run-comparison",
          mode: "read-only-dry-run (no writes, no materialization)",
          businessId,
          subjectFilter,
          policy,
          sessionReadOnly: true,
          totalReviewEvents: rows.length,
          totalSubjects,
          truncated,
          classificationSummary: summary,
          comparison,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await client.$disconnect();
  }
}

main().catch((err) => {
  console.error("[dry-run-comparison] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
