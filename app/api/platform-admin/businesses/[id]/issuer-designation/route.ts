import { NextRequest, NextResponse } from "next/server";

import { ADMIN_MFA_REQUIRED_CODE, requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { readAdminElevationHeader, verifyAdminElevation } from "@/lib/auth/platform-admin-elevation";
import { isIssuerDeclarationEnabled } from "@/lib/billing/issuer-declaration/config";
import { ValidationError } from "@/lib/errors";
import { handleError } from "@/lib/handle-error";
import {
  designateIssuerAuthority,
  designationDetailsDigest,
  loadIssuerDesignationContext,
} from "@/lib/services/billing/issuer-declaration/issuer-designation.service";
import { writeDesignationAsPlatformAdmin } from "@/lib/services/platform-admin/issuer-designation-writer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Platform designation of the user authorized to make the issuer declaration (#1081; owner decision 2026-11-17).
 *
 * Who: a platform admin, ALWAYS with a valid MFA elevation bound to that admin — required here regardless of the
 * global PLATFORM_ADMIN_MFA_REQUIRED switch, because this writes a permanent declaration record. OFF (the declaration
 * screens' switch) → 404. The business is the route's id, resolved and validated on the server; the designated user
 * must belong to it and may not be the admin. The write is the migration's definer function, as the admin role.
 */
async function authorize(req: NextRequest) {
  const admin = await requirePlatformAdminOrResponse(req);
  if (admin instanceof NextResponse) return admin;
  const elevation = verifyAdminElevation(readAdminElevationHeader(req), admin.id);
  if (!elevation.ok) {
    return NextResponse.json({ error: "Multi-factor elevation required", code: ADMIN_MFA_REQUIRED_CODE }, { status: 403, headers: NO_STORE });
  }
  return admin;
}

function parseBusinessId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError("Invalid business id");
  return id;
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const admin = await authorize(req);
    if (admin instanceof NextResponse) return admin;
    if (!isIssuerDeclarationEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    const businessId = parseBusinessId((await context.params).id);
    const ctx = await loadIssuerDesignationContext(businessId);
    return NextResponse.json(
      {
        businessId,
        details: ctx.details,
        problems: ctx.problems,
        users: ctx.users,
        current: ctx.current
          ? {
              version: ctx.current.version,
              kind: ctx.current.kind,
              track: ctx.current.track,
              legalName: ctx.current.legalName,
              authorizedUserId: ctx.current.authorizedUserId,
              createdAt: ctx.current.createdAt,
            }
          : null,
        adminUserId: admin.id,
        detailsDigest: designationDetailsDigest(ctx),
      },
      { status: 200, headers: NO_STORE }
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const admin = await authorize(req);
    if (admin instanceof NextResponse) return admin;
    if (!isIssuerDeclarationEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    const businessId = parseBusinessId((await context.params).id);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await designateIssuerAuthority({
      admin: { id: admin.id, name: admin.name, email: admin.email },
      businessId,
      authorizedUserId: body.authorizedUserId,
      evidenceRef: body.evidenceRef,
      reason: body.reason,
      expectedDigest: body.expectedDigest,
    }, { write: writeDesignationAsPlatformAdmin });
    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    return handleError(error);
  }
}
