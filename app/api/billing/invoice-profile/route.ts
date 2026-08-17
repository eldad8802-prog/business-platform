import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  BILLING_BUSINESS_KIND_VALUES,
  isBillingIdentityComplete,
  parseBillingBusinessKind,
} from "@/lib/billing/business-identity";
import {
  BILLING_PDF_TEMPLATE_STYLES,
  DEFAULT_BILLING_PDF_TEMPLATE_STYLE,
  parseBillingPdfTemplateStyle,
} from "@/lib/billing/billing-pdf-template-style";

const MAX_LOGO_CHARS = 500_000;

const PROFILE_FIELDS = [
  "billingLegalName",
  "billingBusinessKind",
  "billingTaxId",
  "billingVatNumber",
  "billingPhone",
  "billingEmail",
  "billingAddress",
  "billingPaymentNote",
  "billingFooterNote",
  "billingLogoDataUrl",
  "billingSignatureDataUrl",
  "billingPdfTemplateStyle",
] as const;

type ProfilePayload = Partial<
  Record<(typeof PROFILE_FIELDS)[number], string | null>
>;

/** Prisma create/update reject null for billingPdfTemplateStyle (required string). */
function normalizeProfilePayloadForDb(data: ProfilePayload): ProfilePayload {
  if (
    !Object.prototype.hasOwnProperty.call(data, "billingPdfTemplateStyle") ||
    data.billingPdfTemplateStyle !== null
  ) {
    return data;
  }
  return {
    ...data,
    billingPdfTemplateStyle: DEFAULT_BILLING_PDF_TEMPLATE_STYLE,
  };
}

function validateLogo(value: string | null): void {
  if (!value) return;
  if (value.length > MAX_LOGO_CHARS) {
    throw new ValidationError("Logo image is too large");
  }
  if (
    !/^data:image\/(png|jpe?g|webp);base64,/i.test(value.trim())
  ) {
    throw new ValidationError(
      "Logo must be a PNG, JPEG, or WebP data URL (base64)"
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const profile = await prisma.businessProfile.upsert({
      where: { businessId: user.businessId },
      create: { businessId: user.businessId },
      update: {},
      select: {
        billingLegalName: true,
        billingBusinessKind: true,
        billingTaxId: true,
        billingVatNumber: true,
        billingPhone: true,
        billingEmail: true,
        billingAddress: true,
        billingPaymentNote: true,
        billingFooterNote: true,
        billingLogoDataUrl: true,
        billingSignatureDataUrl: true,
        billingPdfTemplateStyle: true,
      },
    });

    return NextResponse.json(
      {
        profile: {
          ...profile,
          billingPdfTemplateStyle: parseBillingPdfTemplateStyle(
            profile.billingPdfTemplateStyle
          ),
        },
        identityComplete: isBillingIdentityComplete(profile),
      },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const data: ProfilePayload = {};

    for (const key of PROFILE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        const raw = body[key];
        if (raw === null) {
          if (key === "billingPdfTemplateStyle") {
            (data as Record<string, string>)[key] =
              DEFAULT_BILLING_PDF_TEMPLATE_STYLE;
          } else {
            (data as Record<string, null>)[key] = null;
          }
        } else if (typeof raw === "string") {
          let v = raw;
          if (key !== "billingLogoDataUrl" && key !== "billingSignatureDataUrl") {
            v = v.trim();
          }
          if (key === "billingLogoDataUrl" || key === "billingSignatureDataUrl") {
            // Same data-URL constraints as the logo (PNG/JPEG/WebP, size-capped).
            validateLogo(v.length > 0 ? v : null);
          }
          if (key === "billingBusinessKind" && v.length > 0) {
            const parsed = parseBillingBusinessKind(v);
            if (!parsed) {
              throw new ValidationError(
                `billingBusinessKind must be one of: ${BILLING_BUSINESS_KIND_VALUES.join(", ")}`
              );
            }
            v = parsed;
          }
          if (key === "billingPdfTemplateStyle" && v.length > 0) {
            const upper = v.trim().toUpperCase();
            if (
              !BILLING_PDF_TEMPLATE_STYLES.includes(
                upper as (typeof BILLING_PDF_TEMPLATE_STYLES)[number]
              )
            ) {
              throw new ValidationError(
                `billingPdfTemplateStyle must be one of: ${BILLING_PDF_TEMPLATE_STYLES.join(", ")}`
              );
            }
            v = upper;
          }
          if (key === "billingPdfTemplateStyle") {
            (data as Record<string, string>)[key] =
              v.length === 0 ? DEFAULT_BILLING_PDF_TEMPLATE_STYLE : v;
          } else {
            (data as Record<string, string | null>)[key] =
              v.length === 0 ? null : v;
          }
        }
      }
    }

    if (Object.keys(data).length === 0) {
      const profile = await prisma.businessProfile.findUnique({
        where: { businessId: user.businessId },
        select: {
          billingLegalName: true,
          billingBusinessKind: true,
          billingTaxId: true,
          billingVatNumber: true,
          billingPhone: true,
          billingEmail: true,
          billingAddress: true,
          billingPaymentNote: true,
          billingFooterNote: true,
          billingLogoDataUrl: true,
          billingSignatureDataUrl: true,
          billingPdfTemplateStyle: true,
        },
      });
      return NextResponse.json(
        {
          profile: profile
            ? {
                ...profile,
                billingPdfTemplateStyle: parseBillingPdfTemplateStyle(
                  profile.billingPdfTemplateStyle
                ),
              }
            : profile,
          identityComplete: isBillingIdentityComplete(profile),
        },
        { status: 200 }
      );
    }

    const persist = normalizeProfilePayloadForDb(data);

    const profile = await prisma.businessProfile.upsert({
      where: { businessId: user.businessId },
      create: {
        businessId: user.businessId,
        ...persist,
      } as Prisma.BusinessProfileUncheckedCreateInput,
      update: persist as Prisma.BusinessProfileUncheckedUpdateInput,
      select: {
        billingLegalName: true,
        billingBusinessKind: true,
        billingTaxId: true,
        billingVatNumber: true,
        billingPhone: true,
        billingEmail: true,
        billingAddress: true,
        billingPaymentNote: true,
        billingFooterNote: true,
        billingLogoDataUrl: true,
        billingSignatureDataUrl: true,
        billingPdfTemplateStyle: true,
      },
    });

    return NextResponse.json(
      {
        profile: {
          ...profile,
          billingPdfTemplateStyle: parseBillingPdfTemplateStyle(
            profile.billingPdfTemplateStyle
          ),
        },
        identityComplete: isBillingIdentityComplete(profile),
      },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
