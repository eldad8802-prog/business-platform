import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * D2 / P4-B Step 6 — Preview-only runtime identity probe.
 *
 * Proves, from the DEPLOYED Preview runtime, which PostgreSQL identity the app's
 * canonical Prisma client authenticates as, and its security posture. Returns NO
 * secrets (no connection string, no password) — only the role name, boolean
 * attributes, and counts. Responds only in the Preview environment; anything else
 * is 404. Remove after the cutover proof.
 */
export async function GET(_req: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const rows = await prisma.$queryRawUnsafe<
      {
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        neon_superuser: number;
        owns_app_tables: number;
        pilot_rls_policies: number;
      }[]
    >(
      "SELECT current_user::text AS current_user," +
        " (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS rolsuper," +
        " (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS rolbypassrls," +
        " (SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user) AS rolcreaterole," +
        " (SELECT rolcreatedb FROM pg_roles WHERE rolname=current_user) AS rolcreatedb," +
        " (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=current_user AND g.rolname='neon_superuser') AS neon_superuser," +
        " (SELECT count(*)::int FROM pg_tables WHERE tableowner=current_user) AS owns_app_tables," +
        " (SELECT count(*)::int FROM pg_policies WHERE policyname='p4b_tenant') AS pilot_rls_policies"
    );
    const r = rows[0];
    console.log(
      "[p4b-probe] current_user=" + r.current_user + " rolsuper=" + r.rolsuper + " rolbypassrls=" + r.rolbypassrls +
      " neon_superuser=" + r.neon_superuser + " owns=" + r.owns_app_tables + " pilot_rls_policies=" + r.pilot_rls_policies
    );
    return NextResponse.json({ vercelEnv: process.env.VERCEL_ENV, ...r }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "error";
    console.log("[p4b-probe] error: " + message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
