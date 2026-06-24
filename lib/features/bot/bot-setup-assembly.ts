/**
 * Setup Wizard — base assembly (Stage 3). Pure, deterministic, no I/O, no LLM.
 *
 * Given the goals a business selected, proposes a starter "base": recommended
 * questions, knowledge to complete, recommended actions, recommended handoff.
 *
 * HARD BOUNDARY: this only PROPOSES. It never writes BusinessBotSettings, never
 * materializes, never activates, and is never read by the response-planner or
 * the pipeline. The output is a frozen SNAPSHOT (copy-with-provenance): every
 * assembled item records which goal(s) contributed it, and the snapshot stamps
 * the catalog version + assembledAt — never a live reference to the catalog.
 */

import { getCatalogField } from "../conversation/bot-fields";
import { GOAL_CATALOG_VERSION, isGoalKey } from "./bot-goals";

// ── Advisory catalogs (labels live here; keys are stable) ────────────────────
const ACTION_LABELS: Record<string, string> = {
  answer_customers: "עונה ללקוחות",
  collect_details: "אוסף פרטים",
  propose_appointment: "מציע תור פנוי",
  send_link: "שולח קישור",
  suggest_products: "מציע מוצרים",
  take_order: "מקבל הזמנה",
  collect_documents: "אוסף מסמכים",
  payment_reminder: "שולח תזכורת תשלום",
};

const KNOWLEDGE_LABELS: Record<string, string> = {
  services_pricing: "שירותים ומחירון",
  business_hours: "שעות פעילות",
  address: "כתובת והגעה",
  faq: "שאלות נפוצות",
  catalog: "קטלוג / קישור",
};

const HANDOFF_LABELS: Record<string, string> = {
  price_question: "שאלה על מחיר",
  agent_request: "בקשת נציג",
  unsure: "חוסר ודאות",
};

type Contribution = {
  fields: string[];
  actions: string[];
  knowledge: string[];
  handoff: string[];
};

const GENERIC: Contribution = {
  fields: ["party_name", "party_phone"],
  actions: ["answer_customers", "collect_details"],
  knowledge: ["faq"],
  handoff: ["agent_request"],
};

/** Per-goal additions, merged on top of GENERIC. */
const GOAL_ASSEMBLY: Record<string, Partial<Contribution>> = {
  // new_customers
  lead_capture: { fields: ["party_email"] },
  inquiry_screening: { fields: ["service_type"] },
  meeting_scheduling: { fields: ["appointment_date"], actions: ["propose_appointment"], knowledge: ["business_hours"] },
  call_coordination: { fields: ["preferred_contact_time"] },
  price_quotes: { fields: ["service_type"], knowledge: ["services_pricing"], handoff: ["price_question"] },
  // sales
  order_taking: { actions: ["take_order"], knowledge: ["services_pricing", "catalog"] },
  product_sales: { actions: ["take_order", "suggest_products"], knowledge: ["services_pricing", "catalog"], handoff: ["price_question"] },
  catalog_sending: { actions: ["send_link"], knowledge: ["catalog"] },
  product_suggestions: { actions: ["suggest_products"], knowledge: ["catalog"] },
  repurchase_renewal: { actions: ["suggest_products"] },
  // service
  faq: { actions: ["answer_customers"], knowledge: ["faq", "business_hours", "address"] },
  service_ticket: { fields: ["service_type"], actions: ["collect_details"] },
  issue_details: { fields: ["service_type"], actions: ["collect_details"] },
  case_followup: { actions: ["answer_customers"] },
  // documents
  document_collection: { actions: ["collect_documents"] },
  image_intake: { actions: ["collect_documents"] },
  document_completion: { actions: ["collect_documents"] },
  form_intake: { actions: ["collect_documents"] },
  // appointments
  appointment_booking: { fields: ["service_type", "appointment_date"], actions: ["propose_appointment"], knowledge: ["business_hours", "services_pricing"], handoff: ["price_question"] },
  appointment_reschedule: { fields: ["appointment_date"], actions: ["propose_appointment"], knowledge: ["business_hours"] },
  appointment_cancel: { fields: ["appointment_date"], knowledge: ["business_hours"] },
  reminders: { actions: ["answer_customers"] },
  // collections
  payment_reminders: { actions: ["payment_reminder"] },
  receipt_collection: { actions: ["collect_documents"] },
  debt_tracking: { actions: ["payment_reminder"] },
};

function contributionFor(goalKey: string): Contribution {
  const extra = GOAL_ASSEMBLY[goalKey] ?? {};
  return {
    fields: [...GENERIC.fields, ...(extra.fields ?? [])],
    actions: [...GENERIC.actions, ...(extra.actions ?? [])],
    knowledge: [...GENERIC.knowledge, ...(extra.knowledge ?? [])],
    handoff: [...GENERIC.handoff, ...(extra.handoff ?? [])],
  };
}

// ── Snapshot shape (stored verbatim in the draft as JSON) ─────────────────────
export type AssembledQuestion = {
  fieldKey: string;
  label: string;
  question: string;
  fromGoals: string[];
};
export type AssembledItem = { key: string; label: string; fromGoals: string[] };

export type AssembledBase = {
  catalogVersion: number;
  assembledAt: string;
  sources: { goalKey: string; goalVersion: number }[];
  questions: AssembledQuestion[];
  knowledgeToComplete: AssembledItem[];
  actions: AssembledItem[];
  handoff: AssembledItem[];
};

/** Ordered accumulator that records which goals contributed each key. */
function accumulate(
  goalKeys: string[],
  pick: (c: Contribution) => string[]
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const goalKey of goalKeys) {
    for (const key of pick(contributionFor(goalKey))) {
      const arr = out.get(key);
      if (arr) {
        if (!arr.includes(goalKey)) arr.push(goalKey);
      } else {
        out.set(key, [goalKey]);
      }
    }
  }
  return out;
}

/**
 * Pure assembly into a frozen snapshot. Unknown goal keys are ignored
 * defensively (callers validate first). `assembledAt` is injected so the result
 * stays deterministic in tests.
 */
export function assembleBase(
  goalKeysRaw: string[],
  assembledAt: string = new Date().toISOString()
): AssembledBase {
  const goalKeys = goalKeysRaw.filter((k) => isGoalKey(k));

  const questions: AssembledQuestion[] = [];
  for (const [fieldKey, fromGoals] of accumulate(goalKeys, (c) => c.fields)) {
    const field = getCatalogField(fieldKey);
    if (!field) continue;
    questions.push({
      fieldKey,
      label: field.defaultLabel,
      question: field.defaultQuestion,
      fromGoals,
    });
  }

  const toItems = (m: Map<string, string[]>, labels: Record<string, string>) =>
    [...m.entries()]
      .filter(([key]) => labels[key])
      .map(([key, fromGoals]) => ({ key, label: labels[key], fromGoals }));

  return {
    catalogVersion: GOAL_CATALOG_VERSION,
    assembledAt,
    sources: goalKeys.map((goalKey) => ({ goalKey, goalVersion: GOAL_CATALOG_VERSION })),
    questions,
    knowledgeToComplete: toItems(accumulate(goalKeys, (c) => c.knowledge), KNOWLEDGE_LABELS),
    actions: toItems(accumulate(goalKeys, (c) => c.actions), ACTION_LABELS),
    handoff: toItems(accumulate(goalKeys, (c) => c.handoff), HANDOFF_LABELS),
  };
}
