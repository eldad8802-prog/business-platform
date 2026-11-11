/**
 * Service Desk P3 (owner-approved 2026-11-09) — the base QA checklists, fixed in code per kind of service. No business
 * customisation yet (that would need a table — a later decision). Pure: no database, no clock.
 *
 * QA passes only when EVERY required item is recorded PASS. A required item that FAILED or was not recorded keeps QA
 * open: the result is stored and journaled, but the case does not count as "QA completed" (qaCompletedAt stays NULL), so
 * the case machine keeps refusing PASS_QA (QA_INCOMPLETE). Optional items may be PASS, FAIL or absent.
 */
import type { ServiceCaseKind } from "./contracts";

export type QaItem = { key: string; label: string; required: boolean };
export type QaTemplate = { id: string; kind: ServiceCaseKind; items: readonly QaItem[] };
export type QaResult = "PASS" | "FAIL";

export const QA_TEMPLATES: Readonly<Record<ServiceCaseKind, QaTemplate>> = {
  IN_SHOP: {
    id: "IN_SHOP.v1",
    kind: "IN_SHOP",
    items: [
      { key: "powers_on", label: "המכשיר נדלק ופועל", required: true },
      { key: "original_fault_resolved", label: "התקלה המקורית נפתרה", required: true },
      { key: "no_new_damage", label: "לא נגרם נזק חיצוני חדש", required: true },
      { key: "accessories_returned", label: "האביזרים שנקלטו מוכנים להחזרה", required: true },
      { key: "cleaned", label: "המכשיר נוקה", required: false },
    ],
  },
  FIELD: {
    id: "FIELD.v1",
    kind: "FIELD",
    items: [
      { key: "original_fault_resolved", label: "התקלה המקורית נפתרה", required: true },
      { key: "system_tested", label: "המערכת נבדקה בהפעלה מלאה", required: true },
      { key: "site_left_clean", label: "האתר הושאר נקי ובטוח", required: true },
      { key: "customer_shown", label: "התוצאה הוצגה ללקוח", required: false },
    ],
  },
  MAINTENANCE: {
    id: "MAINTENANCE.v1",
    kind: "MAINTENANCE",
    items: [
      { key: "checklist_tasks_done", label: "כל משימות התחזוקה בוצעו", required: true },
      { key: "system_tested", label: "המערכת נבדקה בהפעלה מלאה", required: true },
      { key: "site_left_clean", label: "האתר הושאר נקי ובטוח", required: true },
      { key: "next_visit_noted", label: "מועד הביקור הבא נרשם", required: false },
    ],
  },
  // M1 — PROPOSAL, pending the owner's approval of the items (P3 approved the three above only). REMOTE exists only on a
  // track case, which reads its template from its snapshot; this entry keeps the kind map total.
  REMOTE: {
    id: "REMOTE.v1",
    kind: "REMOTE",
    items: [
      { key: "original_fault_resolved", label: "הבעיה המקורית נפתרה", required: true },
      { key: "customer_confirmed_working", label: "הלקוח אישר שהמערכת פועלת", required: true },
      { key: "remote_access_closed", label: "הגישה מרחוק נסגרה", required: true },
      { key: "notes_recorded", label: "סיכום הטיפול נרשם", required: false },
    ],
  },
};

/**
 * M1 — the templates a track names (service-profiles: requirements.qa.template). PROPOSAL, pending the owner's approval of
 * the items; the ids are fixed by the catalog (C1: EXCHANGE.v1 is the short exchange checklist).
 */
export const TRACK_QA_TEMPLATES: Readonly<Record<string, QaTemplate>> = {
  "VEHICLE.v1": {
    id: "VEHICLE.v1",
    kind: "IN_SHOP",
    items: [
      { key: "original_fault_resolved", label: "התקלה המקורית נפתרה", required: true },
      { key: "road_or_run_test", label: "בוצעה בדיקת הפעלה / נסיעה", required: true },
      { key: "no_warning_lights", label: "אין נורות אזהרה פעילות", required: true },
      { key: "no_new_damage", label: "לא נגרם נזק חיצוני חדש", required: true },
      { key: "replaced_parts_kept", label: "החלקים שהוחלפו נשמרו ללקוח", required: false },
    ],
  },
  "INSTALLATION.v1": {
    id: "INSTALLATION.v1",
    kind: "FIELD",
    items: [
      { key: "installed_as_ordered", label: "ההתקנה בוצעה לפי ההזמנה", required: true },
      { key: "system_tested", label: "המערכת נבדקה בהפעלה מלאה", required: true },
      { key: "safety_checked", label: "נבדקו חיבורים ובטיחות", required: true },
      { key: "site_left_clean", label: "האתר הושאר נקי ובטוח", required: true },
      { key: "customer_instructed", label: "הלקוח הודרך בשימוש", required: false },
    ],
  },
  "EXCHANGE.v1": {
    id: "EXCHANGE.v1",
    kind: "IN_SHOP",
    items: [
      { key: "replacement_matches", label: "פריט ההחלפה תואם להזמנה", required: true },
      { key: "replacement_works", label: "פריט ההחלפה נבדק ופועל", required: true },
      { key: "returned_item_logged", label: "הפריט שהוחזר נרשם", required: true },
    ],
  },
};

/** Every template by id: the kind templates (P3) and the track templates (M1). */
export const QA_TEMPLATE_BY_ID: Readonly<Record<string, QaTemplate>> = {
  ...Object.fromEntries(Object.values(QA_TEMPLATES).map((t) => [t.id, t])),
  ...TRACK_QA_TEMPLATES,
};

/** The template a case is checked against: its track's (snapshot) when it has one, else its kind's (P3). */
export function qaTemplateFor(kind: ServiceCaseKind, trackTemplate: string | null | undefined): QaTemplate | null {
  if (trackTemplate !== null && trackTemplate !== undefined) return QA_TEMPLATE_BY_ID[trackTemplate] ?? null;
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
 * Judge recorded results against the kind's template — or, M1, the track's template id. Unknown keys or values are
 * refused, never ignored; an unknown template id is refused (never a fallback to another checklist).
 */
export function evaluateQa(kind: ServiceCaseKind, results: unknown, trackTemplate?: string | null): QaEvaluation {
  const t = qaTemplateFor(kind, trackTemplate);
  if (!t) return { ok: false, field: trackTemplate ? "template" : "kind" };
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
  const required = t.items.filter((i) => i.required);
  const requiredFailed = required.filter((i) => clean[i.key] === "FAIL").length;
  const requiredMissing = required.filter((i) => clean[i.key] === undefined).length;
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
