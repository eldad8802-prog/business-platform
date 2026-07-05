import type { BotForbiddenPresets } from "@/lib/features/conversation/bot-control";
import type { BotLlmPrompt, BotLlmPromptData } from "./types";

const FINAL_ACTION_HINT: Record<string, string> = {
  LEAVE_MESSAGE: "אם צריך — הצע להשאיר הודעה ושבעל העסק יחזור.",
  COLLECT_DETAILS: "אם מתאים — בקש בעדינות פרטים רלוונטיים.",
  SEND_LINK: "אם מתאים — הפנה לקישור שהוגדר.",
  ESCALATE: "העדף להעביר את השיחה לבעל העסק.",
};

function forbiddenLines(f: BotForbiddenPresets | undefined): string[] {
  if (!f) return [];
  const lines: string[] = [];
  if (f.commitPrice)
    lines.push("- אסור להתחייב או לנקוב במחיר. אם שואלים על מחיר — אמור שתעביר לבעל העסק.");
  if (f.promiseAvailability)
    lines.push("- אסור להבטיח זמינות או לקבוע תור. אם שואלים על זמינות — הצע שבעל העסק יאשר.");
  if (f.professionalAdvice)
    lines.push("- אסור לתת ייעוץ מקצועי או המלצה. הפנה את זה לבעל העסק.");
  if (f.giveDiscounts)
    lines.push("- אסור להציע הנחות או מבצעים. הפנה את זה לבעל העסק.");
  return lines;
}

/**
 * Build the system + user prompt for the LLM draft from the Bot Builder /
 * BusinessBotSettings. Pure — no I/O. The system prompt encodes persona, tone,
 * knowledge, goals, and the owner's forbidden rules; the user prompt carries the
 * conversation. The model is told explicitly: draft only, stay in scope, and
 * hand off when unsure — the forbidden rules are ALSO enforced deterministically
 * by the post-response guardrail, so this is defense-in-depth.
 */
export function buildBotLlmPrompt(data: BotLlmPromptData): BotLlmPrompt {
  const s: string[] = [];
  const name = data.displayName?.trim() || "העוזר של העסק";

  s.push(
    `אתה ${name} — עוזר וירטואלי שכותב טיוטת תשובה בוואטסאפ עבור בעל העסק. ` +
      `אתה מכין טיוטה בלבד; בעל העסק בודק ושולח. לעולם אל תמציא מידע.`
  );

  if (data.voiceTone) s.push(`טון הדיבור: ${data.voiceTone}.`);
  if (data.voiceLanguages?.length) s.push(`שפות: ${data.voiceLanguages.join(", ")}.`);
  if (data.personalityVerbosity) s.push(`אורך התשובות: ${data.personalityVerbosity}.`);
  if (data.personalityTraits?.length) s.push(`אופי: ${data.personalityTraits.join(", ")}.`);
  if (data.approachSaleStyle) s.push(`סגנון מכירה: ${data.approachSaleStyle}.`);
  if (data.approachInitiative) s.push(`רמת יוזמה: ${data.approachInitiative}.`);
  if (data.approachPriorities?.length) s.push(`עדיפויות: ${data.approachPriorities.join(", ")}.`);
  if (data.goals?.length) s.push(`מטרות העסק בשיחה: ${data.goals.join(", ")}.`);

  const know: string[] = [];
  if (data.knowledgeHours) know.push(`שעות פעילות: ${data.knowledgeHours}`);
  if (data.knowledgeAddress) know.push(`כתובת: ${data.knowledgeAddress}`);
  if (data.knowledgeNotes) know.push(`מידע נוסף: ${data.knowledgeNotes}`);
  if (know.length) s.push(`ידע עסקי:\n${know.join("\n")}`);
  if (data.faq?.length) {
    s.push(
      "שאלות נפוצות:\n" +
        data.faq.map((f) => `- ש: ${f.question}\n  ת: ${f.answer}`).join("\n")
    );
  }

  if (data.welcomeMessage) s.push(`הודעת פתיחה מועדפת: ${data.welcomeMessage}`);
  if (data.questions?.length) s.push(`שאלות שכדאי לשאול: ${data.questions.join(" | ")}`);
  if (data.finalAction && FINAL_ACTION_HINT[data.finalAction])
    s.push(FINAL_ACTION_HINT[data.finalAction]);

  const forbid = forbiddenLines(data.forbidden);
  if (forbid.length) s.push(["מה אסור לך (חובה):", ...forbid].join("\n"));

  s.push(
    "כללים: השב רק בתחום העסק. אם אינך בטוח, או אם הנושא נופל תחת 'מה אסור' — " +
      "אל תנחש; כתוב תשובה קצרה שמפנה לבעל העסק. החזר אך ורק את טקסט התשובה, בלי הסברים."
  );

  const u: string[] = [];
  if (data.recentMessages?.length) {
    u.push("הקשר השיחה (אחרון בסוף):");
    for (const m of data.recentMessages) {
      u.push(`${m.direction === "INBOUND" ? "לקוח" : "עסק"}: ${m.text}`);
    }
    u.push("");
  }
  u.push(`הודעת הלקוח עכשיו: ${data.customerMessage}`);
  u.push("כתוב טיוטת תשובה אחת:");

  return { system: s.join("\n\n"), user: u.join("\n") };
}
