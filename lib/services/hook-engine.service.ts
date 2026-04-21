import type { ContentPattern } from "./content-pattern-engine.service";
import type { Strategy } from "./strategy-engine.service";

type VariantId = "desire" | "trust" | "result";
type GoalType = "leads" | "trust" | "exposure" | "sales";
type IntentType = "message" | "follow" | "watch" | "sale";
type EmotionalDriver =
  | "curiosity"
  | "trust"
  | "desire"
  | "urgency"
  | "fear"
  | "proof";

export type HookTemplate = {
  id: string;
  text: string;
  type: "pattern_break" | "question" | "proof" | "mistake" | "payoff" | "desire";
};

type PickHookInput = {
  variantId: VariantId;
  goal: GoalType;
  intent: IntentType;
  pattern: ContentPattern;
  strategyType: Strategy["type"];
  emotionalDriver: EmotionalDriver;
  forcedStrategyType?: Strategy["type"];
};

const desireHooks: HookTemplate[] = [
  { id: "d1", text: "אל תגלול — זה בדיוק הרגע שעוצר אותך", type: "pattern_break" },
  { id: "d2", text: "אם זה עובר לך מול העיניים, קשה להישאר אדיש", type: "desire" },
  { id: "d3", text: "עוד שנייה תבין למה כולם נעצרים על זה", type: "payoff" },
  { id: "d4", text: "זה נראה רגיל לשנייה, ואז קולט את העין", type: "pattern_break" },
];

const trustHooks: HookTemplate[] = [
  { id: "t1", text: "ככה זה נראה כשעושים את זה נכון באמת", type: "proof" },
  { id: "t2", text: "ההבדל מתחיל דווקא בשלב שרוב האנשים מפספסים", type: "mistake" },
  { id: "t3", text: "פה בדיוק רואים אם יש מקצועיות או סתם דיבורים", type: "proof" },
  { id: "t4", text: "זה לא טריק — זה פשוט תהליך נכון", type: "proof" },
];

const resultHooks: HookTemplate[] = [
  { id: "r1", text: "זאת התוצאה שמבינה לך אם זה עובד או לא", type: "payoff" },
  { id: "r2", text: "אם אתה רוצה תוצאה, זה החלק שאתה צריך לראות", type: "proof" },
  { id: "r3", text: "כאן מבינים מהר מאוד מה יוצא מזה", type: "payoff" },
  { id: "r4", text: "זה נראה חד, ברור, ומוביל ישר לפעולה", type: "desire" },
];

function scoreHook(input: PickHookInput, hook: HookTemplate) {
  let score = 0;

  const effectiveStrategyType = input.forcedStrategyType || input.strategyType;

  if (input.variantId === "trust" && hook.type === "proof") score += 3;
  if (input.variantId === "result" && hook.type === "payoff") score += 3;
  if (input.variantId === "desire" && hook.type === "pattern_break") score += 3;

  if (input.pattern === "MISTAKE" && hook.type === "mistake") score += 2;
  if (input.pattern === "RESULT" && hook.type === "payoff") score += 2;
  if (input.pattern === "PATTERN_BREAK" && hook.type === "pattern_break") score += 2;

  if (effectiveStrategyType === "authority" && hook.type === "proof") score += 3;
  if (effectiveStrategyType === "direct_result" && hook.type === "payoff") score += 3;
  if (effectiveStrategyType === "problem_solution" && hook.type === "mistake") score += 3;
  if (effectiveStrategyType === "curiosity" && hook.type === "question") score += 2;
  if (effectiveStrategyType === "pattern_break" && hook.type === "pattern_break") score += 3;
  if (effectiveStrategyType === "contrast" && hook.type === "mistake") score += 2;
  if (effectiveStrategyType === "emotional" && hook.type === "desire") score += 2;
  if (effectiveStrategyType === "proof" && hook.type === "proof") score += 3;

  if (input.emotionalDriver === "proof" && hook.type === "proof") score += 2;
  if (input.emotionalDriver === "urgency" && hook.type === "payoff") score += 2;
  if (input.emotionalDriver === "desire" && hook.type === "desire") score += 2;
  if (input.emotionalDriver === "fear" && hook.type === "mistake") score += 2;

  if (input.goal === "sales" && input.intent === "sale" && hook.type === "payoff") {
    score += 2;
  }

  return score;
}

export function pickHook(input: PickHookInput): HookTemplate {
  const pool =
    input.variantId === "trust"
      ? trustHooks
      : input.variantId === "result"
      ? resultHooks
      : desireHooks;

  const sorted = [...pool].sort((a, b) => scoreHook(input, b) - scoreHook(input, a));
  return sorted[0];
}