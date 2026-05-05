import type { DocumentStructure } from "./document-structure.service";
import type { DocumentUnderstandingResult } from "./entities/entity-extraction.service";
import type { SemanticField } from "./understanding/semantic-field-mapper.service";
import type { UnderstoodAmount } from "./understanding/amount-understanding.service";

export type AmountEligibilityCoarse =
  | "eligible_for_final"
  | "ineligible"
  | "secondary_line";

export type AmountEligibilityFine =
  | "main_amount_total_zone"
  | "main_amount_body"
  | "main_amount_payment_zone_noise"
  | "secondary_fee"
  | "vat"
  | "subtotal"
  | "identifier_noise"
  | "unknown_numeric"
  | "unlabeled_money_total_context"
  | "unlabeled_money_payment_noise"
  | "unlabeled_money_secondary";

export type AmountEligibilityItem = {
  value: number;
  raw: string;
  label?: string;
  understandingRole: UnderstoodAmount["role"];
  lineIndex: number;
  coarse: AmountEligibilityCoarse;
  fine: AmountEligibilityFine;
  reasons: string[];
};

export type AmountEligibilityLogPayload = {
  documentType: string;
  summary: {
    eligible_for_final: number;
    ineligible: number;
    secondary_line: number;
  };
  items: AmountEligibilityItem[];
};

function normalizeRaw(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function findSemanticFieldForAmount(
  fields: SemanticField[],
  amount: UnderstoodAmount
): SemanticField | undefined {
  const norm = normalizeRaw(amount.raw);
  return fields.find(
    (f) =>
      typeof f.value === "number" &&
      f.value === amount.value &&
      (f.raw === amount.raw || normalizeRaw(f.raw) === norm)
  );
}

function lineTextAt(
  structure: DocumentStructure,
  lineIndex: number
): string | undefined {
  if (lineIndex < 0 || lineIndex >= structure.allLines.length) return undefined;
  return structure.allLines[lineIndex];
}

function classifyOne(params: {
  amount: UnderstoodAmount;
  field: SemanticField | undefined;
  structure: DocumentStructure;
}): AmountEligibilityItem {
  const { amount, field, structure } = params;
  const lineIndex = field?.lineIndex ?? -1;
  const lineText = lineTextAt(structure, lineIndex) ?? "";
  const inTotalBucket = structure.totalLines.includes(lineText);
  const inPaymentBucket = structure.paymentLines.includes(lineText);

  const reasons: string[] = [];
  const push = (r: string) => reasons.push(r);

  if (!field) {
    push("no matching numeric semantic field for this understood amount");
    return {
      value: amount.value,
      raw: amount.raw,
      label: amount.label,
      understandingRole: amount.role,
      lineIndex,
      coarse: "ineligible",
      fine: "unknown_numeric",
      reasons,
    };
  }

  push(`semantic_field_role:${field.role}`);
  push(`line_bucket_total:${inTotalBucket}`);
  push(`line_bucket_payment:${inPaymentBucket}`);

  if (field.role === "identifier") {
    push("identifier / non-amount numeric context");
    return {
      value: amount.value,
      raw: amount.raw,
      label: amount.label,
      understandingRole: amount.role,
      lineIndex,
      coarse: "ineligible",
      fine: "identifier_noise",
      reasons,
    };
  }

  if (field.role === "secondary_fee") {
    push("fee / secondary monetary component");
    return {
      value: amount.value,
      raw: amount.raw,
      label: amount.label,
      understandingRole: amount.role,
      lineIndex,
      coarse: "secondary_line",
      fine: "secondary_fee",
      reasons,
    };
  }

  if (field.role === "vat") {
    push("vat component");
    return {
      value: amount.value,
      raw: amount.raw,
      label: amount.label,
      understandingRole: amount.role,
      lineIndex,
      coarse: "secondary_line",
      fine: "vat",
      reasons,
    };
  }

  if (field.role === "subtotal") {
    push("subtotal / intermediate sum");
    return {
      value: amount.value,
      raw: amount.raw,
      label: amount.label,
      understandingRole: amount.role,
      lineIndex,
      coarse: "secondary_line",
      fine: "subtotal",
      reasons,
    };
  }

  if (field.role === "main_amount") {
    if (inPaymentBucket && !inTotalBucket) {
      push("main_amount on payment-line bucket without total keywords");
      return {
        value: amount.value,
        raw: amount.raw,
        label: amount.label,
        understandingRole: amount.role,
        lineIndex,
        coarse: "ineligible",
        fine: "main_amount_payment_zone_noise",
        reasons,
      };
    }
    if (inTotalBucket) {
      push("main_amount aligned with total/total-like line bucket");
      return {
        value: amount.value,
        raw: amount.raw,
        label: amount.label,
        understandingRole: amount.role,
        lineIndex,
        coarse: "eligible_for_final",
        fine: "main_amount_total_zone",
        reasons,
      };
    }
    push("main_amount with label, not classified as total/payment noise");
    return {
      value: amount.value,
      raw: amount.raw,
      label: amount.label,
      understandingRole: amount.role,
      lineIndex,
      coarse: "eligible_for_final",
      fine: "main_amount_body",
      reasons,
    };
  }

  // field.role === "unknown" (unlabeled money) and other numeric edge cases
  if (amount.role === "vat") {
    push("understanding role vat");
    return {
      value: amount.value,
      raw: amount.raw,
      label: amount.label,
      understandingRole: amount.role,
      lineIndex,
      coarse: "secondary_line",
      fine: "vat",
      reasons,
    };
  }

  if (amount.role === "subtotal") {
    push("understanding role subtotal");
    return {
      value: amount.value,
      raw: amount.raw,
      label: amount.label,
      understandingRole: amount.role,
      lineIndex,
      coarse: "secondary_line",
      fine: "subtotal",
      reasons,
    };
  }

  if (amount.role === "secondary_fee") {
    push("understanding role secondary_fee");
    return {
      value: amount.value,
      raw: amount.raw,
      label: amount.label,
      understandingRole: amount.role,
      lineIndex,
      coarse: "secondary_line",
      fine: "secondary_fee",
      reasons,
    };
  }

  if (amount.role === "main_amount") {
    if (inTotalBucket) {
      push("unlabeled money promoted to main_amount; line in total bucket");
      return {
        value: amount.value,
        raw: amount.raw,
        label: amount.label,
        understandingRole: amount.role,
        lineIndex,
        coarse: "eligible_for_final",
        fine: "unlabeled_money_total_context",
        reasons,
      };
    }
    if (inPaymentBucket) {
      push("unlabeled money promoted to main_amount; line in payment bucket");
      return {
        value: amount.value,
        raw: amount.raw,
        label: amount.label,
        understandingRole: amount.role,
        lineIndex,
        coarse: "ineligible",
        fine: "unlabeled_money_payment_noise",
        reasons,
      };
    }
    push("unlabeled money promoted to main_amount; default body context");
    return {
      value: amount.value,
      raw: amount.raw,
      label: amount.label,
      understandingRole: amount.role,
      lineIndex,
      coarse: "eligible_for_final",
      fine: "unlabeled_money_total_context",
      reasons,
    };
  }

  push("unlabeled money without main_amount role — treat as non-final line item");
  return {
    value: amount.value,
    raw: amount.raw,
    label: amount.label,
    understandingRole: amount.role,
    lineIndex,
    coarse: "secondary_line",
    fine: "unlabeled_money_secondary",
    reasons,
  };
}

export function classifyUnderstandingAmountsForEligibility(params: {
  documentType: string;
  understanding: DocumentUnderstandingResult;
  structure: DocumentStructure;
}): AmountEligibilityLogPayload {
  const { documentType, understanding, structure } = params;

  const items = understanding.amounts.map((amount) =>
    classifyOne({
      amount,
      field: findSemanticFieldForAmount(understanding.semanticFields, amount),
      structure,
    })
  );

  const summary = {
    eligible_for_final: items.filter((i) => i.coarse === "eligible_for_final")
      .length,
    ineligible: items.filter((i) => i.coarse === "ineligible").length,
    secondary_line: items.filter((i) => i.coarse === "secondary_line").length,
  };

  return { documentType, summary, items };
}
