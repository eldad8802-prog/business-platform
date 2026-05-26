import type { ConversationStage, ConversationStatus } from "@prisma/client";
import type { ConversationOutcome } from "./conversation-outcome";
import type {
  InboxBotFlowStatus,
  NextBestAction,
  PrimarySignalKind,
  TemperatureBucket,
} from "./inbox-item.types";

export type InboxBusinessSituationKind =
  | "CUSTOMER_WAITING"
  | "DRAFT_READY"
  | "BOT_HANDOFF"
  | "BOT_COLLECTING"
  | "QUOTE_WAITING"
  | "FOLLOW_UP_DUE"
  | "WAITING_ON_CUSTOMER"
  | "HOT_OPPORTUNITY"
  | "NEW_LEAD"
  | "CLOSED"
  | "ACTIVE";

export type InboxBusinessSituation = {
  kind: InboxBusinessSituationKind;
  label: string;
  shortLabel: string;
  explanation: string;
  primaryActionLabel: string;
  waitingOn: "business" | "customer" | "system" | "none";
  reason: string;
};

export type DeriveBusinessSituationInput = {
  status: ConversationStatus;
  currentStage: ConversationStage | null;
  primarySignal: PrimarySignalKind;
  waitingMinutes: number | null;
  hasPendingSuggestion: boolean;
  botFlowStatus: InboxBotFlowStatus;
  temperatureBucket: TemperatureBucket;
  nextBestAction: NextBestAction;
  conversationOutcome: ConversationOutcome;
};

function waitingText(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "";
  if (minutes < 60) return ` ${minutes} דק׳`;
  return ` ${Math.floor(minutes / 60)} שע׳`;
}

export function deriveBusinessSituation(
  input: DeriveBusinessSituationInput
): InboxBusinessSituation {
  if (input.status !== "OPEN" || input.conversationOutcome.kind === "CLOSED") {
    return {
      kind: "CLOSED",
      label: "השיחה טופלה",
      shortLabel: "טופל",
      explanation: "אין פעולה פתוחה כרגע. ההיסטוריה נשמרת להמשך.",
      primaryActionLabel: "פתח היסטוריה",
      waitingOn: "none",
      reason: "business_situation.v1.closed",
    };
  }

  if (input.conversationOutcome.kind === "NEEDS_OWNER_ACTION") {
    return {
      kind: "CUSTOMER_WAITING",
      label: "לקוח מחכה לך",
      shortLabel: "מחכה לך",
      explanation: `הלקוח מחכה למענה${waitingText(input.waitingMinutes)}. כדאי לטפל בזה קודם.`,
      primaryActionLabel: input.hasPendingSuggestion ? "בדוק ושלח טיוטה" : "ענה ללקוח עכשיו",
      waitingOn: "business",
      reason: "business_situation.v1.customer_waiting_owner_action",
    };
  }

  if (input.conversationOutcome.kind === "HANDOFF_PENDING") {
    if (input.conversationOutcome.reason === "outcome.v1.human_takeover") {
      return {
        kind: "BOT_HANDOFF",
        label: "אתה מטפל בשיחה",
        shortLabel: "אתה מטפל",
        explanation: "לקחת את השיחה לידיים. לא יופיעו עוד טיוטות פתיחה כאן.",
        primaryActionLabel: "המשך בשיחה",
        waitingOn: "business",
        reason: "business_situation.v1.human_takeover",
      };
    }
    return {
      kind: "BOT_HANDOFF",
      label: "הועבר אליך",
      shortLabel: "הועבר אליך",
      explanation: "סדרת הטיוטות הסתיימה — אתה ממשיך מהאינבוקס.",
      primaryActionLabel: "המשך בשיחה",
      waitingOn: "business",
      reason: "business_situation.v1.bot_handoff",
    };
  }

  if (input.conversationOutcome.kind === "DRAFT_READY_TO_SEND") {
    return {
      kind: "DRAFT_READY",
      label: "אפשר לסגור מהר",
      shortLabel: "טיוטה מוכנה",
      explanation: "יש בסיס מוכן למענה. עריכה קצרה ושליחה יכולות לסגור את הפנייה.",
      primaryActionLabel: "בדוק ושלח",
      waitingOn: "business",
      reason: "business_situation.v1.draft_ready",
    };
  }

  if (input.conversationOutcome.kind === "BOT_COLLECTING") {
    return {
      kind: "BOT_COLLECTING",
      label: "טיוטה מוכנה",
      shortLabel: "טיוטה",
      explanation: "יש טיוטת פתיחה באינבוקס — אתה בודק ושולח ללקוח.",
      primaryActionLabel: "בדוק ושלח",
      waitingOn: "business",
      reason: "business_situation.v1.bot_collecting",
    };
  }

  if (input.conversationOutcome.kind === "QUOTE_IN_FLIGHT") {
    return {
      kind: "QUOTE_WAITING",
      label: "הצעה ממתינה",
      shortLabel: "הצעה נשלחה",
      explanation: "העסק כבר נתן מחיר או הצעה. עכשיו חשוב לוודא שהלקוח לא נעלם.",
      primaryActionLabel: "שלח מעקב להצעה",
      waitingOn: "customer",
      reason: "business_situation.v1.quote_waiting",
    };
  }

  if (input.conversationOutcome.kind === "FOLLOW_UP_OR_REENGAGE") {
    return {
      kind: "FOLLOW_UP_DUE",
      label: "לא לתת לזה להישכח",
      shortLabel: "מעקב",
      explanation: "השיחה שקטה יותר מדי זמן. תזכורת קצרה יכולה להחזיר את הלקוח.",
      primaryActionLabel: "שלח מעקב קצר",
      waitingOn: "business",
      reason: "business_situation.v1.follow_up_due",
    };
  }

  if (input.conversationOutcome.kind === "WAITING_ON_CUSTOMER") {
    return {
      kind: "WAITING_ON_CUSTOMER",
      label: "מחכים ללקוח",
      shortLabel: "מחכים ללקוח",
      explanation: "העסק כבר ענה. אין פעולה דחופה עד שהלקוח יחזור.",
      primaryActionLabel: "השאר במעקב",
      waitingOn: "customer",
      reason: "business_situation.v1.waiting_on_customer",
    };
  }

  if (input.temperatureBucket === "hot" || input.primarySignal === "hot_negotiation") {
    return {
      kind: "HOT_OPPORTUNITY",
      label: "סיכוי טוב לעסקה",
      shortLabel: "סיכוי טוב",
      explanation: "זו שיחה עם כוונה גבוהה. כדאי לתת מענה ברור ומהיר.",
      primaryActionLabel: "קדם לסגירה",
      waitingOn: "business",
      reason: "business_situation.v1.hot_opportunity",
    };
  }

  if (input.currentStage === "NEW" || input.currentStage === null) {
    return {
      kind: "NEW_LEAD",
      label: "פנייה חדשה",
      shortLabel: "חדש",
      explanation: "לקוח חדש נכנס לתהליך. כדאי להבין מה הוא צריך ולהוביל לצעד הבא.",
      primaryActionLabel: "ברר צורך",
      waitingOn: "business",
      reason: "business_situation.v1.new_lead",
    };
  }

  return {
    kind: "ACTIVE",
    label: "שיחה פעילה",
    shortLabel: "פעיל",
    explanation: "אין פעולה דחופה כרגע, אבל השיחה עדיין פתוחה למעקב.",
    primaryActionLabel: input.nextBestAction.label || "המשך מעקב",
    waitingOn: "none",
    reason: "business_situation.v1.active",
  };
}
