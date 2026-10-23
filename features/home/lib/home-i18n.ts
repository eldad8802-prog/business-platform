/**
 * The Hebrew translator — the default for the Home's pure helpers when a caller passes no `t`
 * (unit tests, callers outside the i18n provider). Hebrew output is exactly the pre-i18n copy.
 */
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type Translator } from "@/lib/i18n/translate";

export const HE_T: Translator = createTranslator(he);
