/**
 * Inbox view model — interface-language support.
 *
 * Every builder in lib/inbox-view takes an optional `t`; without it the output is the Hebrew it always was
 * (the Hebrew dictionary, lib/i18n/messages/areas/insights.ts, holds these strings verbatim).
 */
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type Translator } from "@/lib/i18n/translate";

export const INBOX_VIEW_HE_T: Translator = createTranslator(he);
