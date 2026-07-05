import { runBotPolicyEngine } from "@/lib/features/conversation/bot-policy";
import {
  evaluateForbiddenHandoff,
  parseBotControlHandoffRules,
} from "@/lib/features/conversation/bot-control";
import type {
  BotGuardrailDecision,
  BotGuardrailInput,
  BotResponseGuardrailDecision,
  BotResponseGuardrailInput,
} from "./types";

/**
 * Canonical Bot Guardrails (v1) — PRE-response.
 *
 * ONE enforcement point for STARTER drafts, AUTO suggestions, and the future
 * autonomous LLM responder. It unifies the EXISTING handoff/boundary logic
 * (runBotPolicyEngine + evaluateBoundaryHandoff + handoffRules) AND enforces
 * owner-defined forbidden topics ("מה אסור") over the current message AND recent
 * conversation context. It only ever ESCALATES to a handoff — never relaxes the
 * policy — so MANUAL / SMART_DRAFTS are unaffected and an empty/all-false
 * `forbidden` is a no-op.
 *
 * Pure — no side effects.
 */
export function evaluateBotGuardrails(
  input: BotGuardrailInput
): BotGuardrailDecision {
  const policy = runBotPolicyEngine(input);

  // Forbidden-topic guardrail ("מה אסור"), context-aware. Conservative: if the
  // current message OR a recent INBOUND (customer) message touches a forbidden
  // topic, hand off — so a short "כן"/"אפשר" that continues a forbidden thread
  // is not answered by the bot. Runs only when the policy did not already
  // require a handoff, and only escalates.
  if (policy.decision !== "HANDOFF_REQUIRED") {
    const rules = parseBotControlHandoffRules(input.handoffRules);
    if (rules.forbidden) {
      const forbidden = rules.forbidden;
      const candidates: Array<{ text: string; intent: string }> = [
        {
          text: input.message.contentText ?? "",
          intent: input.analysis.intent,
        },
      ];
      for (const m of input.context?.recentMessages ?? []) {
        if (m.direction === "INBOUND") {
          candidates.push({
            text: m.contentText ?? "",
            intent: m.intent ?? "",
          });
        }
      }
      for (const candidate of candidates) {
        const hit = evaluateForbiddenHandoff({
          forbidden,
          intent: candidate.intent,
          messageText: candidate.text,
        });
        if (hit.shouldHandoff && hit.reason) {
          return {
            decision: "HANDOFF_REQUIRED",
            reason: hit.reason,
            canAutoReply: false,
            requiresHandoff: true,
            mode: policy.mode,
            nextAction: "REQUIRE_BUSINESS_ATTENTION",
            canRespond: false,
          };
        }
      }
    }
  }

  return {
    ...policy,
    canRespond: policy.decision === "STARTER_BOT_ELIGIBLE",
  };
}

/**
 * Canonical Bot Guardrails — POST-response (prepared interface).
 *
 * Validates the text the bot is ABOUT to propose against the owner's forbidden
 * topics. Deterministic today (keyword match on the proposed text, reusing the
 * same forbidden logic); this is the seam where LLM-output validation plugs in.
 * NOT yet wired into the deterministic draft path (owner-authored welcome text
 * may legitimately mention a topic) — it exists for the autonomous LLM stage.
 *
 * Conservative: any forbidden brush blocks the text and requests a handoff.
 * Pure — no side effects.
 */
export function evaluateBotResponseGuardrails(
  input: BotResponseGuardrailInput
): BotResponseGuardrailDecision {
  const rules = parseBotControlHandoffRules(input.handoffRules);
  if (rules.forbidden) {
    const hit = evaluateForbiddenHandoff({
      forbidden: rules.forbidden,
      intent: "",
      messageText: input.proposedText ?? "",
    });
    if (hit.shouldHandoff && hit.reason) {
      return { allowed: false, requiresHandoff: true, reason: hit.reason };
    }
  }
  return { allowed: true, requiresHandoff: false, reason: null };
}
