/**
 * Business-profile completion: how many of the business details Dubiz stores
 * have actually been filled in.
 *
 * It is a count of filled fields, nothing more. It is NOT a readiness score,
 * business health, quality, AI confidence or landing-page readiness — those are
 * different questions and must not borrow this number.
 *
 * The rules are data. Adding a legitimate profile field later means adding a
 * rule here; the API and every screen read `items` / `percent` and need no
 * change. Each rule names where the owner fills it in, so a missing item is
 * always one tap from being fixed.
 */
import { parseBillingBusinessKind } from "@/lib/billing/business-identity";
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate";

const HE_T: Translator = createTranslator(he);

/** The slice of `BusinessProfile` the rules read. Nothing else is consulted. */
export type ProfileCompletionInput = {
  billingLegalName: string | null;
  billingBusinessKind: string | null;
  billingTaxId: string | null;
  billingAddress: string | null;
  billingPhone: string | null;
  billingEmail: string | null;
  billingLogoDataUrl: string | null;
  category: string | null;
};

export type ProfileCompletionRule = {
  key: string;
  label: string;
  /** Dictionary key of `label`, for the interface language. Optional: a custom rule may carry text only. */
  labelKey?: MessageKey;
  /** The owner screen where this detail is filled in. */
  href: string;
  isFilled: (profile: ProfileCompletionInput) => boolean;
};

export type ProfileCompletionItem = {
  key: string;
  label: string;
  href: string;
  filled: boolean;
};

export type ProfileCompletion = {
  /** 0–100, rounded down so 100 means every rule is filled — never "almost". */
  percent: number;
  filled: number;
  total: number;
  items: ProfileCompletionItem[];
};

const BUSINESS_DETAILS_HREF = "/business";
const CATEGORY_HREF = "/onboarding";

/** Same acceptance as the logo/signature validator in /api/billing/invoice-profile. */
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp);base64,/i;

/** A stored logo or signature counts only if it is an image that validator accepts. */
export function isStoredImageDataUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && IMAGE_DATA_URL.test(value.trim());
}

const text = (value: string | null | undefined) =>
  typeof value === "string" && value.trim().length > 0;

/**
 * The six required business/document identity fields (the same six
 * `isBillingIdentityComplete` requires), then logo and category.
 * Labels are the ones the owner sees on the form that fills them.
 */
export const PROFILE_COMPLETION_RULES: readonly ProfileCompletionRule[] = [
  {
    key: "legalName",
    label: HE_T("insights.profileCompletion.legalName"),
    labelKey: "insights.profileCompletion.legalName",
    href: BUSINESS_DETAILS_HREF,
    isFilled: (p) => text(p.billingLegalName),
  },
  {
    key: "businessKind",
    label: HE_T("insights.profileCompletion.businessKind"),
    labelKey: "insights.profileCompletion.businessKind",
    href: BUSINESS_DETAILS_HREF,
    isFilled: (p) => parseBillingBusinessKind(p.billingBusinessKind) !== null,
  },
  {
    key: "taxId",
    label: HE_T("insights.profileCompletion.taxId"),
    labelKey: "insights.profileCompletion.taxId",
    href: BUSINESS_DETAILS_HREF,
    isFilled: (p) => text(p.billingTaxId),
  },
  {
    key: "address",
    label: HE_T("insights.profileCompletion.address"),
    labelKey: "insights.profileCompletion.address",
    href: BUSINESS_DETAILS_HREF,
    isFilled: (p) => text(p.billingAddress),
  },
  {
    key: "phone",
    label: HE_T("insights.profileCompletion.phone"),
    labelKey: "insights.profileCompletion.phone",
    href: BUSINESS_DETAILS_HREF,
    isFilled: (p) => text(p.billingPhone),
  },
  {
    key: "email",
    label: HE_T("insights.profileCompletion.email"),
    labelKey: "insights.profileCompletion.email",
    href: BUSINESS_DETAILS_HREF,
    isFilled: (p) => text(p.billingEmail),
  },
  {
    key: "logo",
    label: HE_T("insights.profileCompletion.logo"),
    labelKey: "insights.profileCompletion.logo",
    href: "/profile",
    isFilled: (p) => isStoredImageDataUrl(p.billingLogoDataUrl),
  },
  {
    key: "category",
    label: HE_T("insights.profileCompletion.category"),
    labelKey: "insights.profileCompletion.category",
    href: CATEGORY_HREF,
    isFilled: (p) => text(p.category),
  },
];

export const EMPTY_PROFILE_COMPLETION_INPUT: ProfileCompletionInput = {
  billingLegalName: null,
  billingBusinessKind: null,
  billingTaxId: null,
  billingAddress: null,
  billingPhone: null,
  billingEmail: null,
  billingLogoDataUrl: null,
  category: null,
};

/**
 * A business with no profile row yet is answered with every rule unfilled —
 * 0% — which is the truth, not an error.
 */
export function computeProfileCompletion(
  profile: ProfileCompletionInput | null,
  rules: readonly ProfileCompletionRule[] = PROFILE_COMPLETION_RULES,
  t?: Translator,
): ProfileCompletion {
  const source = profile ?? EMPTY_PROFILE_COMPLETION_INPUT;
  const items = rules.map((rule) => ({
    key: rule.key,
    label: t && rule.labelKey ? t(rule.labelKey) : rule.label,
    href: rule.href,
    filled: rule.isFilled(source),
  }));
  const filled = items.filter((item) => item.filled).length;
  const total = items.length;
  const percent = total === 0 ? 0 : Math.floor((filled / total) * 100);
  return { percent, filled, total, items };
}
