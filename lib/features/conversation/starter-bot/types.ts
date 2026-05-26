/**
 * Pure Starter Bot response planner — no I/O.
 */

export type StarterBotReplyKind =
  | "WELCOME"
  | "QUESTION"
  | "COMPLETE"
  | "HANDOFF";

export type StarterBotSettingsSnapshot = {
  enabled: boolean;
  mode: string;
  channel: string;
  welcomeMessage: string | null;
  questions: unknown;
  finalAction: string | null;
  finalActionPayload: unknown;
  handoffRules: unknown;
};

export type StarterBotConversationSnapshot = {
  id: number;
  currentStage?: string | null;
  lastMessageCount?: number;
  customerInboundCount?: number;
};

export type StarterBotAnalysisSnapshot = {
  intent: string;
  stage: string;
};

export type StarterBotPlannerInput = {
  settings: StarterBotSettingsSnapshot;
  conversation: StarterBotConversationSnapshot;
  analysis: StarterBotAnalysisSnapshot;
  /**
   * אינדקס 0-based של השאלה הבאה אחרי בלוק ה-welcome.
   * 0 = עדיין לא נשלחה שאלה נפרדת אחרי welcome (ב-welcome משולבת שאלה ראשונה אם קיימת).
   */
  nextQuestionIndex?: number;
};

export type StarterBotPlannerResult = {
  shouldDraftReply: boolean;
  replyText: string;
  replyKind: StarterBotReplyKind;
  reason: string;
  nextQuestionIndex?: number;
  finalAction?: string | null;
};
