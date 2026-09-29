import type { BenefitType } from "@/lib/revenue/coupon-benefit";

/**
 * Canonical structured definition of an offer.
 * This is what was chosen at publish time. It is not derived from the
 * marketing sentence and not from the audit log.
 */
export type CanonicalOfferSemantics = {
  benefitType: BenefitType;
  benefitValue: string;
  benefitScope: string;
  /** Decimal string, or null when the owner did not set a minimum. */
  minPurchaseAmount: string | null;
  newCustomersOnly: boolean;
};

export function canonicalOfferSemantics(input: {
  benefitType: BenefitType;
  value: string;
  scope: string;
  minPurchase: number | null;
  newCustomersOnly: boolean;
}): CanonicalOfferSemantics {
  return {
    benefitType: input.benefitType,
    benefitValue: input.value.trim(),
    benefitScope: input.scope.trim(),
    minPurchaseAmount:
      input.minPurchase === null ? null : input.minPurchase.toFixed(2),
    newCustomersOnly: input.newCustomersOnly,
  };
}

export const COUPON_PUBLIC_DETAIL_SERVED = "COUPON_PUBLIC_DETAIL_SERVED";
