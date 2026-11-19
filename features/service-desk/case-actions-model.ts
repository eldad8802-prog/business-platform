/**
 * Service Desk UI 1.3 — which actions the case screen offers, and what each one sends. Pure.
 *
 * The server is the authority: it runs the real case machine (legality, approval before repair per the business
 * setting / the law, QA, balance, permissions, version) and refuses anything illegal. This model only decides what to
 * OFFER, so the owner never sees a button for a step that cannot apply to the case's status. A refusal the server still
 * returns (for example a repair that needs an approved quote) is shown in Hebrew and nothing changes.
 */
import type { CaseCardData, CaseStatus } from "./cases-model";

/** What a dialog asks before the request is sent. */
export type ActionInput =
  | { kind: "none" }
  | { kind: "confirm"; text: string }
  | { kind: "receiver" } // handover: optional receiver name, explicit owner confirmation
  | { kind: "quoteMethod" } // quote answer: by phone / in person
  | { kind: "reason"; required: boolean; label: string }
  | { kind: "debtReason" }; // open balance: only the owner, with a documented reason

export type CaseActionDef = {
  id: string;
  label: string;
  tone: "primary" | "secondary" | "danger";
  input: ActionInput;
  /** Where the request goes. `link` navigates instead (the intake screen). */
  target:
    | { endpoint: "action"; action: Record<string, unknown> }
    | { endpoint: "quote"; decision: "APPROVE" | "REJECT" }
    | { endpoint: "link"; href: string };
};

const held = (c: Pick<CaseCardData, "kind">) => c.kind === "IN_SHOP";
const field = (c: Pick<CaseCardData, "kind">) => c.kind === "FIELD" || c.kind === "REMOTE";

function cancelAction(c: Pick<CaseCardData, "kind" | "status">): CaseActionDef {
  const itemHere = held(c) && !["OPEN", "SCHEDULED"].includes(c.status);
  return {
    id: "cancel", label: field(c) ? "ביטול הקריאה" : "ביטול התיק", tone: "danger",
    input: { kind: "reason", required: itemHere, label: itemHere ? "סיבת הביטול (חובה כשהפריט אצלנו)" : "סיבת הביטול (לא חובה)" },
    target: { endpoint: "action", action: { type: "CANCEL" } },
  };
}

/**
 * The actions for a case, primary first. `intakeReady` = the intake has its condition and accessories recorded (the
 * check-in then only needs the owner's confirmation).
 */
export function caseActions(c: Pick<CaseCardData, "id" | "kind" | "status" | "holdReason" | "intake">): CaseActionDef[] {
  const s: CaseStatus = c.status;
  const a = (type: string, extra: Record<string, unknown> = {}) => ({ endpoint: "action" as const, action: { type, ...extra } });
  switch (s) {
    case "OPEN":
    case "SCHEDULED": {
      if (held(c)) {
        const intakeReady = !!c.intake && c.intake.conditionRecorded && c.intake.accessoriesRecorded;
        return [
          intakeReady
            ? { id: "check-in", label: "לאשר את הקליטה", tone: "primary", input: { kind: "confirm", text: "מאשר/ת שמצב הפריט והאביזרים תועדו ושהפריט נקלט לעסק." }, target: a("CHECK_IN", { intakeConfirmed: true }) }
            : { id: "intake", label: "לקליטת הפריט", tone: "primary", input: { kind: "none" }, target: { endpoint: "link", href: `/service-desk/cases/${c.id}/intake` } },
          ...(intakeReady ? [{ id: "intake-edit", label: "לפרטי הקליטה", tone: "secondary" as const, input: { kind: "none" as const }, target: { endpoint: "link" as const, href: `/service-desk/cases/${c.id}/intake` } }] : []),
          cancelAction(c),
        ];
      }
      return [
        { id: "start-visit", label: c.kind === "REMOTE" ? "להתחיל את הטיפול" : "להתחיל את הביקור", tone: "primary", input: { kind: "none" }, target: a("CHECK_IN") },
        cancelAction(c),
      ];
    }
    case "CHECKED_IN":
      return [{ id: "diagnose", label: "להתחיל אבחון", tone: "primary", input: { kind: "none" }, target: a("START_DIAGNOSIS") }, cancelAction(c)];
    case "DIAGNOSING":
      return [
        { id: "start-repair", label: field(c) ? "להתחיל בעבודה" : "להתחיל תיקון", tone: "primary", input: { kind: "none" }, target: a("START_REPAIR") },
        { id: "not-repairable", label: "לא ניתן לתקן", tone: "secondary", input: { kind: "confirm", text: "לסמן שהפריט לא ניתן לתיקון? התיק יעבור לסיום." }, target: a("MARK_NOT_REPAIRABLE") },
        cancelAction(c),
      ];
    case "QUOTE_PENDING":
      return [
        { id: "quote-approve", label: "הלקוח אישר את ההצעה", tone: "primary", input: { kind: "quoteMethod" }, target: { endpoint: "quote", decision: "APPROVE" } },
        { id: "quote-reject", label: "הלקוח דחה את ההצעה", tone: "secondary", input: { kind: "quoteMethod" }, target: { endpoint: "quote", decision: "REJECT" } },
      ];
    case "IN_REPAIR":
      // On hold, the natural next step is back to work (primary); finishing stays possible (the server clears the hold).
      if (c.holdReason) return [
        { id: "clear-hold", label: "להחזיר לעבודה", tone: "primary", input: { kind: "none" }, target: a("CLEAR_HOLD") },
        { id: "finish", label: field(c) ? "לסיים את העבודה" : "לסיים את התיקון", tone: "secondary", input: { kind: "none" }, target: a("FINISH_REPAIR", { outcome: "REPAIRED" }) },
        cancelAction(c),
      ];
      return [
        { id: "finish", label: field(c) ? "לסיים את העבודה" : "לסיים את התיקון", tone: "primary", input: { kind: "none" }, target: a("FINISH_REPAIR", { outcome: "REPAIRED" }) },
        { id: "hold-parts", label: "ממתין לחלקים", tone: "secondary", input: { kind: "none" }, target: a("SET_HOLD", { reason: "PARTS" }) },
        { id: "hold-customer", label: "ממתין ללקוח", tone: "secondary", input: { kind: "none" }, target: a("SET_HOLD", { reason: "CUSTOMER" }) },
        cancelAction(c),
      ];
    case "QA":
      return [
        { id: "qa-pass", label: "הבדיקות עברו", tone: "primary", input: { kind: "none" }, target: a("PASS_QA", { outcome: "REPAIRED" }) },
        { id: "qa-fail", label: "הבדיקות לא עברו — חזרה לעבודה", tone: "secondary", input: { kind: "none" }, target: a("FAIL_QA") },
      ];
    case "READY":
      return [{ id: "deliver", label: "למסור ללקוח", tone: "primary", input: { kind: "receiver" }, target: a("DELIVER") }];
    case "WORK_DONE":
      return [{ id: "complete", label: "לסגור את הקריאה", tone: "primary", input: { kind: "confirm", text: "מאשר/ת שהעבודה בוצעה והקריאה נסגרת." }, target: a("COMPLETE") }];
    case "DELIVERED":
      return [{ id: "close", label: "לסגור את התיק", tone: "primary", input: { kind: "none" }, target: a("CLOSE") }];
    default:
      return [];
  }
}

/** The completion type the owner confirms for COMPLETE, by where the work was done (never a customer signature). */
export function completionTypeForKind(kind: string): "OWNER_CONFIRMED_REMOTE" | "OWNER_CONFIRMED_ON_SITE" | "OWNER_CONFIRMED_AT_BUSINESS" {
  return kind === "REMOTE" ? "OWNER_CONFIRMED_REMOTE" : kind === "FIELD" ? "OWNER_CONFIRMED_ON_SITE" : "OWNER_CONFIRMED_AT_BUSINESS";
}

/**
 * The exact request body of an action after its dialog: the receiver / reason / debt reason go where the server's
 * contract expects them. Pure, so the contract is tested without a browser.
 */
export function buildActionBody(def: CaseActionDef, c: Pick<CaseCardData, "kind">, input: { receiver?: string; reason?: string; debtReason?: string }): Record<string, unknown> {
  if (def.target.endpoint !== "action") throw new Error("not an action");
  const action: Record<string, unknown> = { ...def.target.action };
  const reason = input.reason?.trim();
  const debt = input.debtReason?.trim();
  switch (action.type) {
    case "DELIVER":
      action.receipt = { handoverConfirmed: true, receivedByName: input.receiver?.trim() || null };
      if (debt) action.debtOverride = { reason: debt };
      break;
    case "COMPLETE":
      action.completion = { completionType: completionTypeForKind(c.kind), ownerConfirmed: true };
      if (debt) action.debtOverride = { reason: debt };
      break;
    case "CANCEL":
      if (reason) action.reason = reason;
      break;
  }
  return action;
}

/** A refusal that asks the owner for a documented decision on an open balance (decision: only the owner, with a reason). */
export function needsDebtDecision(violations: readonly string[]): boolean {
  return violations.includes("OPEN_BALANCE_NEEDS_OWNER_DECISION");
}
