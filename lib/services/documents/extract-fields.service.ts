type ExtractedFields = {
  amount: number;
  vendorName: string;
  date: Date | null;
  amountConfidence: "high" | "medium" | "low";
  vendorConfidence: "high" | "medium" | "low";
};

export function extractFields(text: string): ExtractedFields {
  let amount = 0;
  let amountConfidence: "high" | "medium" | "low" = "low";

  const amountMatch = text.match(/(\d{2,6})/);
  if (amountMatch) {
    amount = Number(amountMatch[1]);
    amountConfidence = "medium";
  }

  let vendorName = "לא ידוע";
  let vendorConfidence: "high" | "medium" | "low" = "low";

  const lines = text.split("\n");
  if (lines.length > 0) {
    vendorName = lines[0].slice(0, 20);
    vendorConfidence = "medium";
  }

  return {
    amount,
    vendorName,
    date: null,
    amountConfidence,
    vendorConfidence,
  };
}