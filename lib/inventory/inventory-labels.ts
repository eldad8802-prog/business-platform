// UI label maps for inventory — keeps raw enum/code values out of the user-facing UI.
//
// Every getter takes an optional translator. Without one it answers in Hebrew (the
// source dictionary) — byte-identical to the pre-i18n maps — so existing callers keep
// working; UI code passes `useI18n().t` to follow the interface language.

import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate";

/** Hebrew translator used when a caller does not pass its own (legacy behaviour). */
export const inventoryHebrewT: Translator = createTranslator(he);

export const MOVEMENT_REASON_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  INITIAL_STOCK: "customers.inventoryKit.labels.movementReason.initialStock",
  MANUAL_ADD: "customers.inventoryKit.labels.movementReason.manualAdd",
  MANUAL_REMOVE: "customers.inventoryKit.labels.movementReason.manualRemove",
  SALE: "customers.inventoryKit.labels.movementReason.sale",
  RETURN: "customers.inventoryKit.labels.movementReason.return",
  DAMAGE: "customers.inventoryKit.labels.movementReason.damage",
  INVENTORY_COUNT_CORRECTION: "customers.inventoryKit.labels.movementReason.countCorrection",
  SUPPLIER_PURCHASE: "customers.inventoryKit.labels.movementReason.supplierPurchase",
};

export function getMovementReasonLabel(reason: string, t: Translator = inventoryHebrewT): string {
  const key = MOVEMENT_REASON_LABEL_KEYS[reason];
  return key ? t(key) : reason;
}

export const MOVEMENT_TYPE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  IN: "customers.inventoryKit.labels.movementType.in",
  OUT: "customers.inventoryKit.labels.movementType.out",
  ADJUSTMENT: "customers.inventoryKit.labels.movementType.adjustment",
};

export function getMovementTypeLabel(type: string, t: Translator = inventoryHebrewT): string {
  const key = MOVEMENT_TYPE_LABEL_KEYS[type];
  return key ? t(key) : type;
}

export const DECISION_REASON_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  "No matches found": "customers.inventoryKit.labels.decisionReason.noMatches",
  "Exact or near-exact match": "customers.inventoryKit.labels.decisionReason.exactMatch",
  "Low similarity": "customers.inventoryKit.labels.decisionReason.lowSimilarity",
  "Possible match requires confirmation": "customers.inventoryKit.labels.decisionReason.possibleMatch",
};

export function getDecisionReasonLabel(reason: string, t: Translator = inventoryHebrewT): string {
  const key = DECISION_REASON_LABEL_KEYS[reason];
  return key ? t(key) : reason;
}

/** Decision confidence arrives on a 0–1 scale; show a human band, not a raw number. */
export function getConfidenceBandLabel(
  confidence: number | null | undefined,
  t: Translator = inventoryHebrewT
): string | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  if (confidence >= 0.85) return t("customers.inventoryKit.labels.confidence.high");
  if (confidence >= 0.6) return t("customers.inventoryKit.labels.confidence.medium");
  return t("customers.inventoryKit.labels.confidence.low");
}

/** Unit-of-measure labels (UNIT / ML / GRAM / KG / LITER / BOX). */
export const UNIT_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  UNIT: "customers.inventoryKit.labels.unit.unit",
  ML: "customers.inventoryKit.labels.unit.ml",
  GRAM: "customers.inventoryKit.labels.unit.gram",
  KG: "customers.inventoryKit.labels.unit.kg",
  LITER: "customers.inventoryKit.labels.unit.liter",
  BOX: "customers.inventoryKit.labels.unit.box",
};

export function getUnitLabel(unit: string, t: Translator = inventoryHebrewT): string {
  const key = UNIT_LABEL_KEYS[unit];
  return key ? t(key) : unit;
}

/** Inventory alert types (LOW_STOCK / CRITICAL_STOCK / …). */
export const ALERT_TYPE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  LOW_STOCK: "customers.inventoryKit.labels.alert.lowStock",
  CRITICAL_STOCK: "customers.inventoryKit.labels.alert.criticalStock",
  UNMATCHED_POS_PRODUCT: "customers.inventoryKit.labels.alert.unmatchedPosProduct",
  SUSPICIOUS_CORRECTION: "customers.inventoryKit.labels.alert.suspiciousCorrection",
};

export function getAlertTypeLabel(type: string, t: Translator = inventoryHebrewT): string {
  const key = ALERT_TYPE_LABEL_KEYS[type];
  return key ? t(key) : type;
}
