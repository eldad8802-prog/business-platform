/**
 * i18n area: content. Hebrew (source) + English for this product area only — each area owns its own
 * file so areas can be translated independently. Registered in ../he.ts and ../en.ts.
 *
 * Interface chrome only. Generated marketing content (posts, landing pages, coupons, scripts), LLM
 * prompts and question banks are NOT here — they stay Hebrew because the customer reads them.
 *
 * Split by screen family (./content/*.ts) so each family can be translated independently:
 *   identity   — business identity / digital presence / landing screens (app/business, components/business)
 *   bot        — business bot + bot settings (app/business/bot*)
 *   studio     — content studio, first half (creator-plan, shot-direction, result, generate, setup, archetype)
 *   studioFlow — content studio, remaining steps + components/content, posts, Header, PrePublishModal
 *   commerce   — offers, coupons, coupon design, promotions
 *   pricing    — pricing, opportunities, tools
 */
import type { Widen } from "../types";
import { botEn, botHe } from "./content/bot";
import { commerceEn, commerceHe } from "./content/commerce";
import { identityEn, identityHe } from "./content/identity";
import { pricingEn, pricingHe } from "./content/pricing";
import { studioEn, studioHe } from "./content/studio";
import { studioFlowEn, studioFlowHe } from "./content/studioFlow";

export const contentHe = {
  identity: identityHe,
  bot: botHe,
  studio: studioHe,
  studioFlow: studioFlowHe,
  commerce: commerceHe,
  pricing: pricingHe,
} as const;

export const contentEn: Widen<typeof contentHe> = {
  identity: identityEn,
  bot: botEn,
  studio: studioEn,
  studioFlow: studioFlowEn,
  commerce: commerceEn,
  pricing: pricingEn,
};
