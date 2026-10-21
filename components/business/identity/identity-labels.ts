/**
 * P2 — labels for the identity vocabulary. Display only; the codes live in lib/services/identity.
 *
 * The wording lives in the i18n dictionary (content.identity.labels, lib/i18n/messages/areas/content/identity.ts).
 * `identityLabels(t)` / `useIdentityLabels()` return the maps in the interface language; the exported
 * constants below are the Hebrew maps (unchanged values) for callers without a translator.
 */
import { useMemo } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { identityHe } from "@/lib/i18n/messages/areas/content/identity";
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type Translator } from "@/lib/i18n/translate";
import { translateTree } from "../i18n-tree";

type TitleHint = { title: string; hint: string };
type ChapterKey = "who" | "audience" | "why" | "action";
type ChapterCopy = { title: string; purpose: string; icon: string; tone: "teal" | "violet" | "amber" | "blue" };

const CHAPTER_META: Record<ChapterKey, Pick<ChapterCopy, "icon" | "tone">> = {
  who: { icon: "🏪", tone: "teal" },
  audience: { icon: "🎯", tone: "violet" },
  why: { icon: "⭐", tone: "amber" },
  action: { icon: "📞", tone: "blue" },
};

/** What Dubiz noticed, per signal kind — phrased as an observation, never as a claim. */
function describeSignalWith(t: Translator, kind: string, value: Record<string, string | number | boolean>): string {
  switch (kind) {
    case "OFFERING_MIX":
      return value.mix === "SERVICE_LED"
        ? t("content.identity.labels.signal.offeringServiceLed")
        : value.mix === "PRODUCT_LED"
          ? t("content.identity.labels.signal.offeringProductLed")
          : t("content.identity.labels.signal.offeringMixed");
    case "CATEGORY_BREADTH":
      return value.breadth === "BROAD"
        ? t("content.identity.labels.signal.breadthBroad", { categories: String(value.categories) })
        : value.breadth === "FOCUSED"
          ? t("content.identity.labels.signal.breadthFocused")
          : t("content.identity.labels.signal.breadthSome");
    case "FULFILLMENT_MODE":
      return value.fulfillment === "AT_CUSTOMER"
        ? t("content.identity.labels.signal.fulfillmentAtCustomer")
        : value.fulfillment === "ONLINE"
          ? t("content.identity.labels.signal.fulfillmentOnline")
          : t("content.identity.labels.signal.fulfillmentOnSite");
    case "QUOTE_PRICING":
      return t("content.identity.labels.signal.quotePricing");
    case "BOOKING_DEMAND":
      return t("content.identity.labels.signal.bookingDemand", { bookings: String(value.bookings) });
    case "DEMAND_CONCENTRATION":
      return t("content.identity.labels.signal.demandConcentration", { sharePct: String(value.sharePct) });
    case "CONTENT_TONE_PREFERENCE": {
      const tones = translateTree(t, "content.identity.labels.contentTone", identityHe.labels.contentTone) as Record<string, string>;
      return t("content.identity.labels.signal.contentTone", {
        tone: tones[String(value.contentTone)] ?? t("content.identity.labels.signal.contentToneFallback"),
      });
    }
    case "CONTENT_AUDIENCE_PREFERENCE":
      return value.contentAudience === "existing"
        ? t("content.identity.labels.signal.contentAudienceExisting")
        : t("content.identity.labels.signal.contentAudienceNew");
    case "CONTENT_VARIANT_PREFERENCE":
      return t("content.identity.labels.signal.contentVariant", { variant: String(value.variantKey) });
    case "BOT_TONE":
      return t("content.identity.labels.signal.botTone");
    case "BOT_AUDIENCE":
      return t("content.identity.labels.signal.botAudience");
    case "BOT_PRIORITY":
      return t("content.identity.labels.signal.botPriority");
    default:
      return t("content.identity.labels.signal.generic");
  }
}

/** Every identity label map, in the language of `t`. */
export function identityLabels(t: Translator) {
  const L = translateTree(t, "content.identity.labels", identityHe.labels);
  const chapter = (key: ChapterKey): ChapterCopy => ({ ...L.chapter[key], ...CHAPTER_META[key] });
  return {
    DIMENSION_LABELS: L.dimension as Record<string, TitleHint>,
    CODE_LABELS: L.code as Record<string, string>,
    FACT_LABELS: L.fact as Record<string, string>,
    FACT_STATE_LABELS: L.factState as Record<string, string>,
    /* ── P3-A · conversion + trust (owner-facing language; never an enum name) ── */
    CHANNEL_LABELS: L.channel as Record<string, string>,
    DECLARATION_LABELS: L.declaration as Record<string, TitleHint>,
    CAPABILITY_LABELS: L.capability as Record<string, string>,
    BLOCKING_LABELS: L.blocking as Record<string, string>,
    CONFLICT_LABELS: L.conflict as Record<string, string>,
    CLAIM_KIND_LABELS: L.claimKind as Record<string, TitleHint>,
    CLAIM_ISSUE_LABELS: L.claimIssue as Record<string, string>,
    READINESS_LABELS: L.readiness as Record<string, string>,
    /* ── Landing knowledge (the redesigned screen) ── */
    CHAPTER_COPY: {
      who: chapter("who"),
      audience: chapter("audience"),
      why: chapter("why"),
      action: chapter("action"),
    } as Record<ChapterKey, ChapterCopy>,
    CHAPTER_STATE_LABELS: L.chapterState as Record<"COMPLETE" | "IN_PROGRESS" | "MISSING", string>,
    NEED_LABELS: L.need as Record<string, string>,
    /** The future page's sections, in the owner's words. */
    PREVIEW_ROLE_LABELS: L.previewRole as Record<string, { title: string; empty: string }>,
    /** Public-use status of an owner item, in human language. */
    PUBLIC_STATUS_LABELS: L.publicStatus as Record<"READY" | "INTERNAL" | "AWAITING" | "MISSING", string>,
    describeSignal: (kind: string, value: Record<string, string | number | boolean>) => describeSignalWith(t, kind, value),
  };
}

export type IdentityLabels = ReturnType<typeof identityLabels>;

/** The identity label maps in the active interface language (client components). */
export function useIdentityLabels(): IdentityLabels {
  const { t } = useI18n();
  return useMemo(() => identityLabels(t), [t]);
}

/* ── Hebrew maps (source language, values unchanged) — for callers without a translator ── */

const HE = identityLabels(createTranslator(he));

export const DIMENSION_LABELS = HE.DIMENSION_LABELS;
export const CODE_LABELS = HE.CODE_LABELS;
export const FACT_LABELS = HE.FACT_LABELS;
/** Contact facts come from the billing details: shown privately, public only by explicit approval. */
export const CONTACT_FACTS = new Set(["PUBLIC_PHONE", "PUBLIC_EMAIL", "PUBLIC_ADDRESS", "PUBLIC_WHATSAPP"]);
export const FACT_STATE_LABELS = HE.FACT_STATE_LABELS;
export const CHANNEL_LABELS = HE.CHANNEL_LABELS;
export const DECLARATION_LABELS = HE.DECLARATION_LABELS;
export const CAPABILITY_LABELS = HE.CAPABILITY_LABELS;
export const BLOCKING_LABELS = HE.BLOCKING_LABELS;
export const CONFLICT_LABELS = HE.CONFLICT_LABELS;
export const CLAIM_KIND_LABELS = HE.CLAIM_KIND_LABELS;
export const CLAIM_ISSUE_LABELS = HE.CLAIM_ISSUE_LABELS;
export const READINESS_LABELS = HE.READINESS_LABELS;
export const CHAPTER_COPY = HE.CHAPTER_COPY;
export const CHAPTER_STATE_LABELS = HE.CHAPTER_STATE_LABELS;
export const NEED_LABELS = HE.NEED_LABELS;
export const PREVIEW_ROLE_LABELS = HE.PREVIEW_ROLE_LABELS;
export const PUBLIC_STATUS_LABELS = HE.PUBLIC_STATUS_LABELS;
export const describeSignal = HE.describeSignal;
