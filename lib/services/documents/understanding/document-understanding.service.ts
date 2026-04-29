import { understandLines } from "./line-understanding.service";
import { mapSemanticFields } from "./semantic-field-mapper.service";
import { understandAmounts } from "./amount-understanding.service";
import { understandVendors } from "./vendor-understanding.service";
import { understandDates } from "./date-understanding.service";

export function understandDocument(text: string) {
  const lines = understandLines(text);
  const semanticFields = mapSemanticFields(lines);

  const amounts = understandAmounts(semanticFields, lines);
  const vendors = understandVendors(lines, semanticFields);
  const dates = understandDates(lines);

  return {
    lines,
    semanticFields,
    amounts,
    vendors,
    dates,
  };
}