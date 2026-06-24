import type {
  StarterBotPlannerInput,
  StarterBotPlannerResult,
  StarterBotReplyKind,
  StarterBotSettingsSnapshot,
} from "./types";
import {
  applyVoiceToWelcome,
  type BotComposeContext,
} from "../../bot/bot-compose-context";

function parseQuestionItems(questions: unknown): string[] {
  if (!questions || typeof questions !== "object") return [];
  const items = (questions as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  );
}

function readWebsiteUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const u = (payload as Record<string, unknown>).websiteUrl;
  return typeof u === "string" && u.trim() ? u.trim() : null;
}

function buildFinalActionText(
  settings: StarterBotSettingsSnapshot
): { text: string; kind: StarterBotReplyKind } {
  const action = (settings.finalAction || "").trim().toUpperCase();
  const url = readWebsiteUrl(settings.finalActionPayload);

  switch (action) {
    case "LEAVE_MESSAGE":
      return {
        text: "קיבלתי 👍 חוזר אליך עוד רגע",
        kind: "COMPLETE",
      };
    case "COLLECT_DETAILS":
      return {
        text: "שלח פרטים ואעדכן",
        kind: "COMPLETE",
      };
    case "SEND_LINK":
      return {
        text: url ? url : "שולח קישור — אם לא נפתח, תגיד לי.",
        kind: "COMPLETE",
      };
    case "ESCALATE":
      return {
        text: "רגע, אני איתך ממש עכשיו",
        kind: "HANDOFF",
      };
    default:
      return {
        text: "ממשיך מכאן איתך בקרוב.",
        kind: "COMPLETE",
      };
  }
}

function noDraft(reason: string): StarterBotPlannerResult {
  return {
    shouldDraftReply: false,
    replyText: "",
    replyKind: "WELCOME",
    reason,
  };
}

/**
 * דטרמיניסטי: לפי הגדרות + אינדקס שאלה — בלי LLM ובלי side effects.
 *
 * `context` (Stage 9) is OPTIONAL and additive. When absent, output is
 * byte-for-byte identical to before. When present, the ONLY change is the
 * WELCOME wording (mechanical voice). Questions, finalAction, replyKind and the
 * draft-only nature are never affected. The caller decides whether to pass it.
 */
export function planStarterBotReply(
  input: StarterBotPlannerInput,
  context?: BotComposeContext
): StarterBotPlannerResult {
  const { settings } = input;
  const qi = input.nextQuestionIndex ?? 0;

  if (!settings.enabled) {
    return noDraft("BOT_DISABLED");
  }
  if (settings.mode !== "STARTER") {
    return noDraft("UNSUPPORTED_MODE");
  }
  if (settings.channel !== "WHATSAPP") {
    return noDraft("UNSUPPORTED_CHANNEL");
  }

  const welcome = (settings.welcomeMessage || "").trim();
  if (!welcome) {
    return noDraft("NO_WELCOME_MESSAGE");
  }

  const items = parseQuestionItems(settings.questions);

  if (qi === 0) {
    // 9B: mechanical voice transform applies to the WELCOME wording only.
    const effectiveWelcome = context
      ? applyVoiceToWelcome(welcome, context)
      : welcome;
    const parts = [effectiveWelcome];
    if (items.length > 0) {
      parts.push(items[0]);
    }
    const replyText = parts.join("\n\n");
    return {
      shouldDraftReply: true,
      replyText,
      replyKind: "WELCOME",
      reason:
        items.length > 0
          ? "WELCOME_WITH_FIRST_QUESTION"
          : "WELCOME_ONLY_NO_QUESTIONS",
      nextQuestionIndex: 1,
    };
  }

  if (qi > 0 && qi < items.length) {
    const line = items[qi];
    return {
      shouldDraftReply: true,
      replyText: line,
      replyKind: "QUESTION",
      reason: "FOLLOWUP_QUESTION",
      nextQuestionIndex: qi + 1,
    };
  }

  const { text, kind } = buildFinalActionText(settings);
  return {
    shouldDraftReply: true,
    replyText: text,
    replyKind: kind,
    reason: "TERMINAL_CLOSING_AFTER_QUESTIONS",
    nextQuestionIndex: items.length,
    finalAction: settings.finalAction,
  };
}
