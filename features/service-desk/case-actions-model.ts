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
  /**
   * Shown, but not active, with this explanation: the server would refuse the step now (QA not passed, no charge decided).
   * The server still enforces the rule itself — this only spares the owner a refusal and says what to do first.
   */
  blockedReason?: string;
  /**
   * Where the request goes. `link` navigates instead (the intake screen); `charge` opens the charge sheet (the step a
   * handover / completion waits for); `qa` saves the marked checks and then passes or fails QA in one action (owner
   * decision 2026-11-24 — the server rules are unchanged); `scroll` brings a panel into view (the QA checklist).
   */
  target:
    | { endpoint: "action"; action: Record<string, unknown> }
    | { endpoint: "quote"; decision: "APPROVE" | "REJECT" }
    | { endpoint: "link"; href: string }
    | { endpoint: "charge" }
    | { endpoint: "qa"; then: "PASS" | "FAIL" }
    | { endpoint: "scroll"; to: string };
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
export type QaModeView = "REQUIRED" | "OPTIONAL" | "OFF";

export type CaseActionOpts = {
  qaMode?: QaModeView;
  /** Why PASS_QA cannot be confirmed now (case-extras-model qaPassBlocker), or null. */
  qaBlocker?: string | null;
  /**
   * The checklist as marked on screen (owner decision 2026-11-24): "incomplete" → the main action is to mark the checks,
   * never "failed"; "ready" → every required check passed: save + pass in one action; "failed" → a check failed: save +
   * back to work. Absent (no checklist) → passing is offered directly, as before.
   */
  qaState?: "incomplete" | "ready" | "failed";
  /** Why the handover cannot go through now (no charge decided — the balance is unknown), or null. */
  handoverBlocker?: string | null;
  /** READY / WORK_DONE and no charge decided yet: the main action leads to setting it (no locked handover button). */
  chargeUndecided?: boolean;
};

export function caseActions(c: Pick<CaseCardData, "id" | "kind" | "status" | "holdReason" | "intake">, opts: CaseActionOpts = {}): CaseActionDef[] {
  const s: CaseStatus = c.status;
  const a = (type: string, extra: Record<string, unknown> = {}) => ({ endpoint: "action" as const, action: { type, ...extra } });
  // FINISH_REPAIR follows the case's own QA mode (the server refuses an outcome when the case goes through QA):
  // REQUIRED → to QA, no outcome; OPTIONAL → the owner chooses; OFF / unknown → finished now with the outcome.
  const finishLabel = field(c) ? "לסיים את העבודה" : "לסיים את התיקון";
  const finish = (tone: "primary" | "secondary"): CaseActionDef[] => opts.qaMode === "REQUIRED"
    ? [{ id: "finish", label: "לסיים ולעבור לבדיקות", tone, input: { kind: "none" }, target: a("FINISH_REPAIR") }]
    : opts.qaMode === "OPTIONAL"
      ? [{ id: "finish-qa", label: "לסיים ולעבור לבדיקות", tone, input: { kind: "none" }, target: a("FINISH_REPAIR", { qa: true }) },
         { id: "finish", label: `${finishLabel} בלי בדיקות`, tone: "secondary", input: { kind: "none" }, target: a("FINISH_REPAIR", { outcome: "REPAIRED" }) }]
      : [{ id: "finish", label: finishLabel, tone, input: { kind: "none" }, target: a("FINISH_REPAIR", { outcome: "REPAIRED" }) }];
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
        ...finish("secondary"),
        cancelAction(c),
      ];
      return [
        ...finish("primary"),
        { id: "hold-parts", label: "ממתין לחלקים", tone: "secondary", input: { kind: "none" }, target: a("SET_HOLD", { reason: "PARTS" }) },
        { id: "hold-customer", label: "ממתין ללקוח", tone: "secondary", input: { kind: "none" }, target: a("SET_HOLD", { reason: "CUSTOMER" }) },
        cancelAction(c),
      ];
    case "QA":
      // Owner decision 2026-11-24: before any check is marked nothing announces a failure; the main action follows the
      // marked checklist. Saving and confirming are one action; the server still validates every rule.
      if (opts.qaState === "failed") return [{ id: "qa-fail", label: "לשמור ולהחזיר לעבודה", tone: "primary", input: { kind: "none" }, target: { endpoint: "qa", then: "FAIL" } }];
      if (opts.qaState === "incomplete") return [{ id: "qa-mark", label: "לסמן את הבדיקות", tone: "primary", input: { kind: "none" }, target: { endpoint: "scroll", to: "sd-qa" } }];
      if (opts.qaState === "ready") return [{ id: "qa-pass", label: "לאשר שהבדיקות עברו", tone: "primary", input: { kind: "none" }, target: { endpoint: "qa", then: "PASS" } }];
      return [
        { id: "qa-pass", label: "לאשר שהבדיקות עברו", tone: "primary", input: { kind: "none" }, target: a("PASS_QA", { outcome: "REPAIRED" }),
          ...(opts.qaBlocker ? { blockedReason: opts.qaBlocker } : {}) },
      ];
    case "READY":
      if (opts.chargeUndecided) return [{ id: "set-charge", label: "לקבוע חיוב", tone: "primary", input: { kind: "none" }, target: { endpoint: "charge" } }];
      return [{ id: "deliver", label: "למסור ללקוח", tone: "primary", input: { kind: "receiver" }, target: a("DELIVER"),
        ...(opts.handoverBlocker ? { blockedReason: opts.handoverBlocker } : {}) }];
    case "WORK_DONE":
      if (opts.chargeUndecided) return [{ id: "set-charge", label: "לקבוע חיוב", tone: "primary", input: { kind: "none" }, target: { endpoint: "charge" } }];
      return [{ id: "complete", label: "לסגור את הקריאה", tone: "primary", input: { kind: "confirm", text: "מאשר/ת שהעבודה בוצעה והקריאה נסגרת." }, target: a("COMPLETE"),
        ...(opts.handoverBlocker ? { blockedReason: opts.handoverBlocker } : {}) }];
    // DELIVERED: the handover is the end of the owner's work. CLOSE is the system's own step (service-case.core
    // SYSTEM_ACTIONS) — offering it to the owner only produced a refusal, so nothing is offered.
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
