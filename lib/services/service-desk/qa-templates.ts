/**
 * Service Desk — the built-in QA checklists, fixed in code: one per kind of service (P3) and the ones a track names
 * (M1). Pure: no database, no clock.
 *
 * Owner decision 2026-11-12: EVERY built-in template is a SUGGESTION. No check is required merely because it comes from
 * the system; built-in templates never depend on the business's category. A business that wants a check to be required
 * copies a template into its own QA list (per-business lists — a list starts from a template, every copied check
 * optional) and marks it REQUIRED there; only a business's own list can make a check required.
 *
 * Completion (what sets ServiceCase.qaCompletedAt, which the case machine needs for PASS_QA):
 *   - a built-in template (`everyCheckRecorded`): the checklist was actually performed — EVERY check recorded, PASS or
 *     FAIL. No check has to PASS (a FAIL is recorded and journaled; the owner decides PASS_QA / FAIL_QA). So a track whose
 *     QA mode is REQUIRED still demands a real QA — never a single click — without making any check mandatory to pass.
 *   - a template with REQUIRED checks (the retired v1 templates, a test's synthetic template; per-business lists follow
 *     the same rule): every REQUIRED check PASS; optional checks may be PASS, FAIL or absent.
 *   In the counts, requiredMissing = the checks that must be recorded and are not (a REQUIRED check, or any check of a
 *   built-in template); requiredFailed = REQUIRED checks FAILED (always 0 on a built-in template). Completed ⇔ both 0.
 *   A FAILED or missing check that the rule needs keeps QA open: the result is stored and journaled, qaCompletedAt stays
 *   NULL and the case machine keeps refusing PASS_QA (QA_INCOMPLETE).
 *
 * Versions (a template id names fixed content, like a business list version): the three P3 templates had REQUIRED checks
 * as IN_SHOP.v1 / FIELD.v1 / MAINTENANCE.v1; the all-suggested content is IN_SHOP.v2 / FIELD.v2 / MAINTENANCE.v2 (same
 * keys and labels, every check optional). The v1 content stays here, frozen (RETIRED_QA_TEMPLATES), so a stored result
 * that names a v1 id (ServiceCase.qaChecklist.template, the RECORD_QA journal payload) keeps its exact historical
 * meaning. Nothing re-evaluates a stored result: evaluateQa runs only when a result is RECORDED. A v1 id that a case's
 * frozen profile snapshot still names is judged, for a NEW recording only, by its successor (QA_TEMPLATE_SUCCESSOR) —
 * same keys, so the owner's rule reaches open cases too; what was recorded before is never touched.
 */
import type { ServiceCaseKind } from "./contracts";

export type QaItem = { key: string; label: string; required: boolean };
export type QaTemplate = {
  id: string;
  kind: ServiceCaseKind;
  items: readonly QaItem[];
  /** Complete only when every check is recorded (PASS or FAIL) — true for every current built-in (suggested) template. */
  everyCheckRecorded: boolean;
};
export type QaResult = "PASS" | "FAIL";

export const QA_TEMPLATES: Readonly<Record<ServiceCaseKind, QaTemplate>> = {
  IN_SHOP: {
    id: "IN_SHOP.v2",
    kind: "IN_SHOP",
    everyCheckRecorded: true,
    items: [
      { key: "powers_on", label: "המכשיר נדלק ופועל", required: false },
      { key: "original_fault_resolved", label: "התקלה המקורית נפתרה", required: false },
      { key: "no_new_damage", label: "לא נגרם נזק חיצוני חדש", required: false },
      { key: "accessories_returned", label: "האביזרים שנקלטו מוכנים להחזרה", required: false },
      { key: "cleaned", label: "המכשיר נוקה", required: false },
    ],
  },
  FIELD: {
    id: "FIELD.v2",
    kind: "FIELD",
    everyCheckRecorded: true,
    items: [
      { key: "original_fault_resolved", label: "התקלה המקורית נפתרה", required: false },
      { key: "system_tested", label: "המערכת נבדקה בהפעלה מלאה", required: false },
      { key: "site_left_clean", label: "האתר הושאר נקי ובטוח", required: false },
      { key: "customer_shown", label: "התוצאה הוצגה ללקוח", required: false },
    ],
  },
  MAINTENANCE: {
    id: "MAINTENANCE.v2",
    kind: "MAINTENANCE",
    everyCheckRecorded: true,
    items: [
      { key: "checklist_tasks_done", label: "כל משימות התחזוקה בוצעו", required: false },
      { key: "system_tested", label: "המערכת נבדקה בהפעלה מלאה", required: false },
      { key: "site_left_clean", label: "האתר הושאר נקי ובטוח", required: false },
      { key: "next_visit_noted", label: "מועד הביקור הבא נרשם", required: false },
    ],
  },
  // M1 — SUGGESTED template (owner decision 2026-11-11). REMOTE exists only on a track case, which reads its template
  // from its snapshot; this entry keeps the kind map total.
  REMOTE: {
    id: "REMOTE.v1",
    kind: "REMOTE",
    everyCheckRecorded: true,
    items: [
      { key: "original_fault_resolved", label: "הבעיה המקורית נפתרה", required: false },
      // owner 2026-11-11: record the health-check result; never require the customer's confirmation
      { key: "health_check_recorded", label: "בוצעה בדיקת תקינות ותוצאתה תועדה", required: false },
      { key: "remote_access_closed", label: "הגישה מרחוק נסגרה", required: false },
      { key: "notes_recorded", label: "סיכום הטיפול נרשם", required: false },
    ],
  },
};

/**
 * M1 — the templates a track names (service-profiles: requirements.qa.template). SUGGESTED templates (owner decision
 * 2026-11-11): every check optional; the ids are fixed by the catalog (C1: EXCHANGE.v1 is the short exchange checklist).
 */
export const TRACK_QA_TEMPLATES: Readonly<Record<string, QaTemplate>> = {
  "VEHICLE.v1": {
    id: "VEHICLE.v1",
    kind: "IN_SHOP",
    everyCheckRecorded: true,
    items: [
      { key: "original_fault_resolved", label: "התקלה המקורית נפתרה", required: false },
      { key: "road_or_run_test", label: "בוצעה בדיקת הפעלה / נסיעה", required: false },
      { key: "no_warning_lights", label: "אין נורות אזהרה פעילות", required: false },
      { key: "no_new_damage", label: "לא נגרם נזק חיצוני חדש", required: false },
      // owner 2026-11-11: document what happened to the replaced parts; never require keeping them for the customer
      { key: "replaced_parts_handled", label: "תועד הטיפול בחלקים שהוחלפו (נמסרו ללקוח, הושלכו או הוחזרו לספק)", required: false },
    ],
  },
  "INSTALLATION.v1": {
    id: "INSTALLATION.v1",
    kind: "FIELD",
    everyCheckRecorded: true,
    items: [
      { key: "installed_as_ordered", label: "ההתקנה בוצעה לפי ההזמנה", required: false },
      { key: "system_tested", label: "המערכת נבדקה בהפעלה מלאה", required: false },
      { key: "safety_checked", label: "נבדקו חיבורים ובטיחות", required: false },
      { key: "site_left_clean", label: "האתר הושאר נקי ובטוח", required: false },
      { key: "customer_instructed", label: "הלקוח הודרך בשימוש", required: false },
    ],
  },
  "EXCHANGE.v1": {
    id: "EXCHANGE.v1",
    kind: "IN_SHOP",
    everyCheckRecorded: true,
    items: [
      { key: "replacement_matches", label: "פריט ההחלפה תואם להזמנה", required: false },
      { key: "replacement_works", label: "פריט ההחלפה נבדק ופועל", required: false },
      { key: "returned_item_logged", label: "הפריט שהוחזר נרשם", required: false },
    ],
  },
};

/** Every CURRENT built-in template by id (7): what a track may name and what a business list may start from. */
export const QA_TEMPLATE_BY_ID: Readonly<Record<string, QaTemplate>> = {
  ...Object.fromEntries(Object.values(QA_TEMPLATES).map((t) => [t.id, t])),
  ...TRACK_QA_TEMPLATES,
};

/**
 * HISTORY ONLY — the P3 content (2026-11-09 → 2026-11-12) with its 10 REQUIRED checks, frozen so a stored result that
 * names a v1 id keeps its meaning (labels, order, which checks were required). Never offered: not in QA_TEMPLATE_BY_ID,
 * so no track names it and no business list copies it; never used to judge a new result (see QA_TEMPLATE_SUCCESSOR).
 */
export const RETIRED_QA_TEMPLATES: Readonly<Record<string, QaTemplate>> = {
  "IN_SHOP.v1": {
    id: "IN_SHOP.v1",
    kind: "IN_SHOP",
    everyCheckRecorded: false,
    items: [
      { key: "powers_on", label: "המכשיר נדלק ופועל", required: true },
      { key: "original_fault_resolved", label: "התקלה המקורית נפתרה", required: true },
      { key: "no_new_damage", label: "לא נגרם נזק חיצוני חדש", required: true },
      { key: "accessories_returned", label: "האביזרים שנקלטו מוכנים להחזרה", required: true },
      { key: "cleaned", label: "המכשיר נוקה", required: false },
    ],
  },
  "FIELD.v1": {
    id: "FIELD.v1",
    kind: "FIELD",
    everyCheckRecorded: false,
    items: [
      { key: "original_fault_resolved", label: "התקלה המקורית נפתרה", required: true },
      { key: "system_tested", label: "המערכת נבדקה בהפעלה מלאה", required: true },
      { key: "site_left_clean", label: "האתר הושאר נקי ובטוח", required: true },
      { key: "customer_shown", label: "התוצאה הוצגה ללקוח", required: false },
    ],
  },
  "MAINTENANCE.v1": {
    id: "MAINTENANCE.v1",
    kind: "MAINTENANCE",
    everyCheckRecorded: false,
    items: [
      { key: "checklist_tasks_done", label: "כל משימות התחזוקה בוצעו", required: true },
      { key: "system_tested", label: "המערכת נבדקה בהפעלה מלאה", required: true },
      { key: "site_left_clean", label: "האתר הושאר נקי ובטוח", required: true },
      { key: "next_visit_noted", label: "מועד הביקור הבא נרשם", required: false },
    ],
  },
};

/** A retired id → the current template a NEW recording on a case whose snapshot names it is judged by (same keys). */
export const QA_TEMPLATE_SUCCESSOR: Readonly<Record<string, string>> = {
  "IN_SHOP.v1": "IN_SHOP.v2",
  "FIELD.v1": "FIELD.v2",
  "MAINTENANCE.v1": "MAINTENANCE.v2",
};

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** For READING a stored result: the template its id names, current or retired (exact historical content). */
export function qaTemplateForHistory(id: string): QaTemplate | null {
  if (has(QA_TEMPLATE_BY_ID, id)) return QA_TEMPLATE_BY_ID[id];
  return has(RETIRED_QA_TEMPLATES, id) ? RETIRED_QA_TEMPLATES[id] : null;
}

/**
 * The template a NEW result is judged by: its track's (snapshot) when it has one, else its kind's (P3). A retired id in
 * an older snapshot resolves to its successor; an unknown id → null (refused, never a fallback to another checklist).
 */
export function qaTemplateFor(kind: ServiceCaseKind, trackTemplate: string | null | undefined): QaTemplate | null {
  if (trackTemplate !== null && trackTemplate !== undefined) {
    const id = has(QA_TEMPLATE_SUCCESSOR, trackTemplate) ? QA_TEMPLATE_SUCCESSOR[trackTemplate] : trackTemplate;
    return has(QA_TEMPLATE_BY_ID, id) ? QA_TEMPLATE_BY_ID[id] : null;
  }
  return QA_TEMPLATES[kind] ?? null;
}

export type QaEvaluation =
  | {
      ok: true;
      template: string;
      completed: boolean;
      /** What the case stores (ServiceCase.qaChecklist — an object of tokens, ≤ 8 KB by the database). */
      checklist: { template: string; results: Record<string, QaResult> };
      counts: { items: number; recorded: number; passed: number; failed: number; requiredFailed: number; requiredMissing: number };
    }
  | { ok: false; field: string };

/**
 * Judge recorded results against a template (the completion rule above). Unknown keys or values are refused, never
 * ignored; at least one result.
 */
export function evaluateQaAgainst(t: QaTemplate, results: unknown): QaEvaluation {
  if (!results || typeof results !== "object" || Array.isArray(results)) return { ok: false, field: "results" };
  const entries = Object.entries(results as Record<string, unknown>);
  const known = new Set(t.items.map((i) => i.key));
  const clean: Record<string, QaResult> = {};
  for (const [key, value] of entries) {
    if (!known.has(key)) return { ok: false, field: `results.${key}`.slice(0, 60) };
    if (value !== "PASS" && value !== "FAIL") return { ok: false, field: `results.${key}` };
    clean[key] = value;
  }
  if (entries.length === 0) return { ok: false, field: "results" };
  // A check MUST BE RECORDED when it is REQUIRED or the template is performed in full (every built-in template); only
  // a REQUIRED check must PASS. requiredMissing counts the checks that must be recorded and are not — so "completed"
  // keeps its one meaning everywhere (no required check failed, none missing), as the QA record table checks it.
  const mustRecord = t.items.filter((i) => i.required || t.everyCheckRecorded);
  const requiredFailed = t.items.filter((i) => i.required && clean[i.key] === "FAIL").length;
  const requiredMissing = mustRecord.filter((i) => clean[i.key] === undefined).length;
  const passed = Object.values(clean).filter((v) => v === "PASS").length;
  const failed = Object.values(clean).filter((v) => v === "FAIL").length;
  return {
    ok: true,
    template: t.id,
    completed: requiredFailed === 0 && requiredMissing === 0,
    checklist: { template: t.id, results: clean },
    counts: { items: t.items.length, recorded: entries.length, passed, failed, requiredFailed, requiredMissing },
  };
}

/**
 * Judge recorded results against the kind's template — or, M1, the track's template id (a retired id by its
 * successor). An unknown template id is refused (never a fallback to another checklist).
 */
export function evaluateQa(kind: ServiceCaseKind, results: unknown, trackTemplate?: string | null): QaEvaluation {
  const t = qaTemplateFor(kind, trackTemplate);
  if (!t) return { ok: false, field: trackTemplate ? "template" : "kind" };
  return evaluateQaAgainst(t, results);
}
