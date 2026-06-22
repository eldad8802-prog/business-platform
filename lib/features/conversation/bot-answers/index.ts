/**
 * Bot Answers — Answer persistence foundation public surface.
 *
 * A pure mapper + thin repository helpers over the BotFieldAnswer table. No
 * live conversation path imports these; no webhook/planner/API wiring; no
 * Customer/Appointment writes; no parsing.
 */

export {
  type CaptureAnswerInput,
  type AnswerCreateData,
  type BotAnswerParseStatus,
} from "./bot-answer.types";

export { buildAnswerCreateData } from "./bot-answer.mapper";

export {
  captureAnswer,
  supersedePreviousAnswer,
  getCurrentAnswersForConversation,
  getAnswerHistoryForField,
} from "./bot-answer.repository";
