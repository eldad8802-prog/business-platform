/**
 * The service settings form (UI 1.3a, screen 10 of the approved mockups) — pure state, validation and the request body.
 * The limits mirror the server's (updateSettings): a warranty of 1–3650 days or 1–120 months, a scope of up to 2000
 * characters (required when a warranty is set), exclusions optional up to 2000. There is no default warranty (מ3): "no
 * template" is a valid choice and is what a new business starts with.
 */
import type { SaveSettingsBody, ServiceSettings, WarrantyUnit } from "./service-desk-client";

export const TEXT_MAX = 2000;
export const MAX_BY_UNIT: Record<WarrantyUnit, number> = { DAYS: 3650, MONTHS: 120 };

export type SettingsForm = {
  /** "" = the owner handles new cases (no default technician); otherwise a staff member id as text. */
  staffId: string;
  warrantyOn: boolean;
  value: string;
  unit: WarrantyUnit;
  scope: string;
  exclusions: string;
};

export type FormProblems = Partial<Record<"value" | "scope" | "exclusions", string>>;

export function formFrom(s: ServiceSettings): SettingsForm {
  const w = s.warrantyTemplate;
  return {
    staffId: s.defaultStaffMemberId === null ? "" : String(s.defaultStaffMemberId),
    warrantyOn: w !== null,
    value: w ? String(w.value) : "",
    unit: w ? w.unit : "MONTHS",
    scope: w ? w.scope : "",
    exclusions: w?.exclusions ?? "",
  };
}

const chars = (s: string) => [...s].length;

export function validate(f: SettingsForm): FormProblems {
  const p: FormProblems = {};
  if (!f.warrantyOn) return p;
  const v = f.value.trim();
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isInteger(n) || n < 1) p.value = "הזן מספר שלם, 1 ומעלה.";
  else if (n > MAX_BY_UNIT[f.unit]) p.value = f.unit === "DAYS" ? "עד 3650 ימים." : "עד 120 חודשים.";
  if (f.scope.trim().length === 0) p.scope = "תאר מה האחריות מכסה.";
  else if (chars(f.scope.trim()) > TEXT_MAX) p.scope = `עד ${TEXT_MAX} תווים.`;
  if (chars(f.exclusions.trim()) > TEXT_MAX) p.exclusions = `עד ${TEXT_MAX} תווים.`;
  return p;
}

export function hasProblems(p: FormProblems): boolean {
  return Object.keys(p).length > 0;
}

/** The request body for a valid form; the version is the one the screen loaded (null before the first save). */
export function bodyFrom(f: SettingsForm, version: number | null): SaveSettingsBody {
  return {
    expectedVersion: version,
    defaultStaffMemberId: f.staffId === "" ? null : Number(f.staffId),
    warrantyTemplate: f.warrantyOn
      ? { value: Number(f.value.trim()), unit: f.unit, scope: f.scope.trim(), exclusions: f.exclusions.trim() === "" ? null : f.exclusions.trim() }
      : null,
  };
}

/** Whether saving would change anything — compared on what is actually sent, so whitespace alone is not a change. */
export function isDirty(f: SettingsForm, saved: ServiceSettings): boolean {
  const a = bodyFrom(f, saved.version);
  return a.defaultStaffMemberId !== saved.defaultStaffMemberId || JSON.stringify(a.warrantyTemplate) !== JSON.stringify(saved.warrantyTemplate);
}

/** The line shown under the warranty when it is set, e.g. "12 חודשים". */
export function warrantySummary(value: number, unit: WarrantyUnit): string {
  if (unit === "MONTHS") return value === 1 ? "חודש אחד" : `${value} חודשים`;
  return value === 1 ? "יום אחד" : `${value} ימים`;
}
