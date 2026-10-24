/**
 * i18n area: content — English. Moved verbatim out of ./content.ts so the Hebrew client bundle never
 * carries English: this module is reached only from ../en.ts, i.e. the English dictionary chunk
 * (components/i18n/EnglishI18nProvider.tsx) and the server. The types still come from the Hebrew source.
 */
import type { Widen } from "../types";
import { botEn } from "./content/bot.en";
import { commerceEn } from "./content/commerce.en";
import { identityEn } from "./content/identity.en";
import { pricingEn } from "./content/pricing.en";
import { studioEn } from "./content/studio.en";
import { studioFlowEn } from "./content/studioFlow.en";
import type { contentHe } from "./content";

export const contentEn: Widen<typeof contentHe> = {
  identity: identityEn,
  bot: botEn,
  studio: studioEn,
  studioFlow: studioFlowEn,
  commerce: commerceEn,
  pricing: pricingEn,
};
