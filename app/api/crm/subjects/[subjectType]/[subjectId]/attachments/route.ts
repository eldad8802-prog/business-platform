import { NextRequest, NextResponse } from "next/server";
import { getServerI18n } from "@/lib/i18n/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { crmAttachmentsService } from "@/lib/services/crm/crm-attachments.service";
import { MAX_ATTACHMENT_BYTES } from "@/lib/services/crm/crm-attachment-storage";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export const runtime = "nodejs";
export const maxDuration = 30;

type Ctx = { params: Promise<{ subjectType: string; subjectId: string }> };

/** List attachments for a CRM subject (CUSTOMER | SUPPLIER), newest-first, one page (100) at a time + hasMore + total. */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { subjectType, subjectId } = await ctx.params;

    // `before` = the id of the last attachment the caller already shows (next page). Anything but a
    // positive integer is ignored — the first page — never an error and never a raw value in a query.
    const beforeRaw = Number(new URL(req.url).searchParams.get("before"));
    const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;

    const page = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          crmAttachmentsService.listAttachmentsPage(
            {
              businessId: user.businessId,
              subjectType,
              subjectId: Number(subjectId),
              actingUserId: user.id,
              before,
            },
            { tx }
          )
        )
    );

    return NextResponse.json(page, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

/** Upload one file (multipart/form-data, field "file") to a CRM subject. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { t } = await getServerI18n();
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    // Write path → fail-closed rate limit (controlled 503 on a backend blip).
    const decision = await checkRateLimit({
      bucket: "CRM_ATTACHMENT_UPLOAD",
      user: user.id,
      business: user.businessId,
    });
    if (!decision.allowed) {
      return buildRateLimitResponse(decision);
    }

    const { subjectType, subjectId } = await ctx.params;

    const formData = await req.formData();
    const files = formData.getAll("file").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      throw new ValidationError(t("api.common.noFileSelected"));
    }
    if (files.length > 1) {
      throw new ValidationError(t("api.crm.oneFileAtATime"));
    }
    const file = files[0];

    // Fast size gate on the declared size BEFORE buffering the whole file into
    // memory — mirrors the Documents upload route. The service still validates
    // the real byte length (authoritative; a spoofed file.size cannot pass it).
    if (typeof file.size !== "number" || file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json({ error: t("api.common.fileTooLarge15") }, { status: 413 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    // The upload writes object storage between tenant-scoped queries, so the
    // tenant transaction gets an extended timeout (never the default 5s race).
    const attachment = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(
          (tx) =>
            crmAttachmentsService.uploadAttachment(
              {
                businessId: user.businessId,
                subjectType,
                subjectId: Number(subjectId),
                uploadedByUserId: user.id,
                buffer,
                originalFileName: file.name,
                mimeType: file.type,
              },
              { tx }
            ),
          { timeoutMs: 25_000 }
        )
    );

    return NextResponse.json({ attachment }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
