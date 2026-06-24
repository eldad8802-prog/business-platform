/**
 * Recommendations (Stage 6) — pure, opt-in. Deterministic generator + types.
 *
 * A recommendation NEVER changes anything by itself — it is only stored and
 * shown. Generated when goals change on an already-established bot. NOT read by
 * the response-planner or the pipeline.
 */

import { assembleBase } from "./bot-setup-assembly";
import { GOAL_CATALOG_VERSION, isGoalKey } from "./bot-goals";
import type { BotKnowledge } from "./bot-knowledge";

export const RECOMMENDATION_STATUSES = ["PROPOSED", "APPLIED", "DISMISSED"] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export type RecommendationCandidate = {
  /** Granular, dedupe-friendly type (subject baked in). */
  type: string;
  reason: string;
  payload: Record<string, unknown>;
  sourceGoalKey: string;
  sourceGoalVersion: number;
};

/** Actions worth recommending (generic ones are skipped — already default). */
const RECOMMENDABLE_ACTIONS: Record<string, string> = {
  propose_appointment: "מציע תור פנוי",
  take_order: "מקבל הזמנה",
  send_link: "שולח קישור",
  suggest_products: "מציע מוצרים",
  collect_documents: "אוסף מסמכים",
  payment_reminder: "שולח תזכורת תשלום",
};

/** Knowledge subjects we can actually detect as "missing" here. */
const RECOMMENDABLE_KNOWLEDGE: Record<string, string> = {
  business_hours: "שעות פעילות",
  address: "כתובת והגעה",
  faq: "שאלות נפוצות",
};

function knowledgeMissing(key: string, k: BotKnowledge): boolean {
  if (key === "business_hours") return !k.hours;
  if (key === "address") return !k.address;
  if (key === "faq") return k.faq.length === 0;
  return false;
}

/**
 * Generate recommendation candidates for newly-added goals, given current
 * knowledge. Deduped by `type` within the batch. Caller dedupes against stored
 * recommendations and gates on the bot being established.
 */
export function generateGoalChangeRecommendations(params: {
  addedGoalKeys: string[];
  knowledge: BotKnowledge;
}): RecommendationCandidate[] {
  const { addedGoalKeys, knowledge } = params;
  const out: RecommendationCandidate[] = [];
  const seenTypes = new Set<string>();

  const push = (c: RecommendationCandidate) => {
    if (seenTypes.has(c.type)) return;
    seenTypes.add(c.type);
    out.push(c);
  };

  for (const goalKey of addedGoalKeys) {
    if (!isGoalKey(goalKey)) continue;
    const base = assembleBase([goalKey]);

    // 1. missing knowledge the goal would want
    for (const item of base.knowledgeToComplete) {
      if (!RECOMMENDABLE_KNOWLEDGE[item.key]) continue;
      if (!knowledgeMissing(item.key, knowledge)) continue;
      push({
        type: `ADD_KNOWLEDGE_${item.key}`,
        reason: `המטרה השתנתה — כדאי להוסיף ידע: ${RECOMMENDABLE_KNOWLEDGE[item.key]}`,
        payload: { area: "knowledge", knowledgeKey: item.key },
        sourceGoalKey: goalKey,
        sourceGoalVersion: GOAL_CATALOG_VERSION,
      });
    }

    // 2. meaningful actions the goal enables
    for (const item of base.actions) {
      if (!RECOMMENDABLE_ACTIONS[item.key]) continue;
      push({
        type: `ENABLE_ACTION_${item.key}`,
        reason: `כדאי לאפשר פעולה: ${RECOMMENDABLE_ACTIONS[item.key]}`,
        payload: { area: "allowed", actionKey: item.key },
        sourceGoalKey: goalKey,
        sourceGoalVersion: GOAL_CATALOG_VERSION,
      });
    }

    // 3. a date question for scheduling goals
    if (base.questions.some((q) => q.fieldKey === "appointment_date")) {
      push({
        type: "ADD_QUESTION_appointment_date",
        reason: "כדאי להוסיף שאלת תאריך מועדף לשיחה",
        payload: { area: "conversation", fieldKey: "appointment_date" },
        sourceGoalKey: goalKey,
        sourceGoalVersion: GOAL_CATALOG_VERSION,
      });
    }
  }

  return out;
}
