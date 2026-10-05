/**
 * Everything the Profile screen (and the Settings hub's account card) shows
 * about the signed-in business, read in ONE tenant transaction.
 *
 * Every value is read from the business's own records or derived from them by
 * a documented rule. A value Dubiz does not have is null / absent — never a
 * placeholder:
 *
 *   identity        Business.name (from the session) + BusinessProfile fields.
 *                   There is no website field, so none is returned.
 *   metrics         {@link loadProfileMetrics}.
 *   completion      {@link computeProfileCompletion} over the stored fields.
 *   documentSignature  whether the business has uploaded the signature image
 *                   that is stamped on its documents. This is NOT customer
 *                   e-signature — Dubiz has none.
 *   subscription    {@link resolveSubscriptionView} — "unavailable" until
 *                   Dubiz has plans.
 *
 * `businessId` must be server-derived (the session). It is never taken from
 * the request.
 */
import { businessCategoryLabel } from "@/lib/business/business-categories";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import {
  computeProfileCompletion,
  isStoredImageDataUrl,
  type ProfileCompletion,
} from "./profile-completion";
import { loadProfileMetrics, type ProfileMetrics } from "./profile-metrics";
import { resolveSubscriptionView, type SubscriptionView } from "./subscription-view";

export type ProfileSummary = {
  business: {
    name: string;
    /** Owner-facing category line, or null when none is stored. */
    categoryLabel: string | null;
    /** Address from the business details, else the stored city; null if neither. */
    location: string | null;
    phone: string | null;
    email: string | null;
    /** The business logo (PNG/JPEG/WebP data URL), or null for the initials fallback. */
    logoDataUrl: string | null;
  };
  account: {
    name: string | null;
    email: string;
  };
  metrics: ProfileMetrics;
  completion: ProfileCompletion;
  documentSignature: { configured: boolean };
  subscription: SubscriptionView;
};

export type ProfileSummaryCaller = {
  businessId: number;
  businessName: string;
  userName: string | null;
  userEmail: string;
};

const PROFILE_SELECT = {
  category: true,
  subCategory: true,
  city: true,
  billingLegalName: true,
  billingBusinessKind: true,
  billingTaxId: true,
  billingAddress: true,
  billingPhone: true,
  billingEmail: true,
  billingLogoDataUrl: true,
  billingSignatureDataUrl: true,
} as const;

const present = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

export async function loadProfileSummary(
  caller: ProfileSummaryCaller,
  now: Date = new Date(),
): Promise<ProfileSummary> {
  const { businessId } = caller;

  const { profile, metrics } = await tenantTx(businessId, async (tx) => {
    const profile = await tx.businessProfile.findUnique({
      where: { businessId },
      select: PROFILE_SELECT,
    });
    const metrics = await loadProfileMetrics(tx, businessId, now);
    return { profile, metrics };
  });

  const completion = computeProfileCompletion(
    profile
      ? {
          billingLegalName: profile.billingLegalName,
          billingBusinessKind: profile.billingBusinessKind,
          billingTaxId: profile.billingTaxId,
          billingAddress: profile.billingAddress,
          billingPhone: profile.billingPhone,
          billingEmail: profile.billingEmail,
          billingLogoDataUrl: profile.billingLogoDataUrl,
          category: profile.category,
        }
      : null,
  );

  return {
    business: {
      name: caller.businessName,
      categoryLabel: businessCategoryLabel(profile?.category, profile?.subCategory),
      location: present(profile?.billingAddress) ?? present(profile?.city),
      phone: present(profile?.billingPhone),
      email: present(profile?.billingEmail),
      logoDataUrl: isStoredImageDataUrl(profile?.billingLogoDataUrl)
        ? profile!.billingLogoDataUrl!.trim()
        : null,
    },
    account: { name: present(caller.userName), email: caller.userEmail },
    metrics,
    completion,
    documentSignature: { configured: isStoredImageDataUrl(profile?.billingSignatureDataUrl) },
    subscription: resolveSubscriptionView(),
  };
}
