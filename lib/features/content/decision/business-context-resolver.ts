import {
  getBusinessContentProfile,
  type BusinessContentProfile,
} from "@/lib/services/business-content-profile.service";

export type BusinessProfileRequestInput = {
  businessType?: string;
  businessCategory?: string;
  businessName?: string;
  services?: string[];
  products?: string[];
  audienceTypes?: string[];
  brandTone?: string;
  primaryGoal?: "leads" | "trust" | "exposure" | "sales";
  priceLevel?: "budget" | "mid" | "premium";
  differentiators?: string[];
  selectedDirectionTone?: string;
  /** Normalized user brief — steers vertical when it conflicts with stale DB category. */
  contentGoalPrompt?: string;
};

export function resolveBusinessContext(
  input: BusinessProfileRequestInput
): BusinessContentProfile {
  return getBusinessContentProfile({
    businessType: input.businessType,
    businessCategory: input.businessCategory,
    businessName: input.businessName,
    services: input.services ?? [],
    products: input.products ?? [],
    targetAudience: input.audienceTypes ?? [],
    brandTone: input.brandTone ?? input.selectedDirectionTone,
    primaryGoal: input.primaryGoal,
    priceLevel: input.priceLevel,
    differentiators: input.differentiators ?? [],
    contentGoalPrompt: input.contentGoalPrompt,
  });
}
