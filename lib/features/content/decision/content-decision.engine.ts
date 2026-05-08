import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import { resolveBusinessContext } from "./business-context-resolver";
import { evaluateContentDecisionTree } from "./content-decision.tree";
import type { ContentDecision, DecisionInput } from "./types";
import type { BusinessProfileRequestInput } from "./business-context-resolver";

export type RunContentDecisionEngineParams = {
  decisionInput: DecisionInput;
  businessProfileRequest: BusinessProfileRequestInput;
};

export type ContentDecisionEngineResult = {
  decision: ContentDecision;
  businessProfile: BusinessContentProfile;
};

export function runContentDecisionEngine(
  params: RunContentDecisionEngineParams
): ContentDecisionEngineResult {
  const businessProfile = resolveBusinessContext(params.businessProfileRequest);
  const decision: ContentDecision = {
    ...evaluateContentDecisionTree(params.decisionInput, businessProfile),
  };

  return { decision, businessProfile };
}
