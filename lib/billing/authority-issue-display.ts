/**
 * Pure mapping from the issue-flow authority outcome to a user-facing display.
 *
 * The document is ISSUED regardless of the allocation result (Model B: the
 * accounting document state is separate from the allocation state). This helper
 * keeps the two states DISTINCT and never presents "allocation received" unless
 * a number was actually granted. No I/O.
 */

import type { AuthorityIssueOutcome } from "@/lib/services/billing/authority/billing-authority-issue-outcome";

export type AuthorityDisplayTone = "success" | "info" | "warning" | "danger";

export type AuthorityIssueDisplay = {
  /** The accounting document was issued (always true once issuance returned). */
  documentIssued: true;
  /** True ONLY when an allocation number was actually granted (approved). */
  allocationReceived: boolean;
  /** Present only when a number was granted. */
  allocationNumber?: string;
  /** Whether an explicit user decision is pending (HELD). */
  userActionRequired: boolean;
  tone: AuthorityDisplayTone;
  title: string;
  detail: string;
};

export function describeAuthorityIssueOutcome(
  authority: AuthorityIssueOutcome
): AuthorityIssueDisplay {
  const base = { documentIssued: true as const, allocationReceived: false, userActionRequired: false };

  switch (authority.status) {
    case "approved":
      return {
        ...base,
        allocationReceived: true,
        allocationNumber: authority.allocationNumber,
        tone: "success",
        title: "המסמך הונפק ומספר הקצאה התקבל",
        detail: authority.allocationNumber
          ? `מספר הקצאה: ${authority.allocationNumber}`
          : "התקבל מספר הקצאה מרשות המסים.",
      };
    case "not_required":
      return {
        ...base,
        tone: "success",
        title: "המסמך הונפק",
        detail: "המסמך אינו חייב במספר הקצאה.",
      };
    case "in_progress":
      return {
        ...base,
        tone: "info",
        title: "המסמך הונפק",
        detail: "בקשת מספר ההקצאה בטיפול מול רשות המסים.",
      };
    case "decision_required":
      return {
        ...base,
        userActionRequired: true,
        tone: "warning",
        title: "המסמך הונפק — נדרשת החלטה",
        detail: "רשות המסים לא הקצתה מספר, ונדרשת החלטתך כיצד להמשיך.",
      };
    case "decision_already_reported":
      return {
        ...base,
        tone: "info",
        title: "המסמך הונפק",
        detail: "החלטה כבר דווחה לרשות המסים — נדרשת התאמה, לא התקבל מספר חדש.",
      };
    case "validation_failed":
      return {
        ...base,
        tone: "danger",
        title: "המסמך הונפק — בקשת ההקצאה נדחתה",
        detail: "רשות המסים דחתה את בקשת מספר ההקצאה. לא התקבל מספר.",
      };
    case "authentication_failed":
      return {
        ...base,
        tone: "warning",
        title: "המסמך הונפק — בקשת ההקצאה לא הושלמה",
        detail: "נדרש חיבור מחדש לרשות המסים. לא התקבל מספר.",
      };
    case "infrastructure_failed":
      return {
        ...base,
        tone: "danger",
        title: "המסמך הונפק — בקשת ההקצאה לא הושלמה",
        detail: "לא ניתן היה להשלים את בקשת מספר ההקצאה כעת. אפשר לנסות שוב.",
      };
    case "ambiguous":
      return {
        ...base,
        tone: "danger",
        title: "המסמך הונפק — תוצאת ההקצאה אינה ודאית",
        detail: "נדרש בירור מול רשות המסים. אין להניח שהתקבל מספר.",
      };
    case "execution_error":
      return {
        ...base,
        tone: "danger",
        title: "המסמך הונפק — בקשת ההקצאה נכשלה",
        detail: "אירעה תקלה בעת בקשת מספר ההקצאה. לא התקבל מספר.",
      };
    default: {
      // Exhaustiveness guard — every AuthorityIssueStatus is handled above.
      const _never: never = authority.status;
      return _never;
    }
  }
}
