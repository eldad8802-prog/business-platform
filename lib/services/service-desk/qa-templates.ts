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
};

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

/** Judge recorded results against the kind's template. Unknown keys or values are refused, never ignored. */
export function evaluateQa(kind: ServiceCaseKind, results: unknown): QaEvaluation {
  const t = QA_TEMPLATES[kind];
  if (!t) return { ok: false, field: "kind" };
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
