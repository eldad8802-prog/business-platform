/**
 * Setup Wizard draft validators (Stage 3). Pure. Staging only — never writes
 * BusinessBotSettings, never activates, never read by the pipeline.
 */

import type { Validated } from "./bot-profile";
import { isGoalKey, validateGoalSelection } from "./bot-goals";

/** Lifecycle stops short of ACTIVATED on purpose (too dangerous now). */
export const SETUP_STATUSES = ["DRAFT", "REVIEW_READY"] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

/** Wizard steps: goals → assembled → review (0-based, capped). */
export const SETUP_MAX_STEP = 6;

export type SetupDraftPatch = {
  selectedGoalKeys?: string[];
  currentStep?: number;
  status?: SetupStatus;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

export function validateSetupPatch(body: unknown): Validated<SetupDraftPatch> {
  if (!isPlainObject(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const patch: SetupDraftPatch = {};

  if (Object.prototype.hasOwnProperty.call(body, "selectedGoalKeys")) {
    const r = validateGoalSelection(body.selectedGoalKeys);
    if (!r.ok) return r;
    patch.selectedGoalKeys = r.value;
  }

  if (Object.prototype.hasOwnProperty.call(body, "currentStep")) {
    const v = body.currentStep;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > SETUP_MAX_STEP) {
      return { ok: false, error: `currentStep must be an integer 0..${SETUP_MAX_STEP}` };
    }
    patch.currentStep = v;
  }

  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    const v = body.status;
    if (typeof v !== "string" || !(SETUP_STATUSES as readonly string[]).includes(v)) {
      return { ok: false, error: `status must be one of ${SETUP_STATUSES.join(", ")}` };
    }
    patch.status = v as SetupStatus;
  }

  if (
    patch.selectedGoalKeys === undefined &&
    patch.currentStep === undefined &&
    patch.status === undefined
  ) {
    return { ok: false, error: "No valid fields to update" };
  }

  return { ok: true, value: patch };
}

/**
 * Parse a stored selectedGoalKeys JSON column into a clean string[]. Forgiving:
 * drops unknown keys and duplicates (read-side, unlike the strict write path).
 */
export function coerceSelectedGoalKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && isGoalKey(item) && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
