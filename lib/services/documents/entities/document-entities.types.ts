export type ConfidenceLabel = "low" | "medium" | "high";

export type ConfidenceSource =
  | "header"
  | "business_id"
  | "pattern"
  | "candidate"
  | "label"
  | "structure"
  | "reconstructed"
  | "validation"
  | "learning"
  | "fallback";

export type VendorEntity = {
  name: string | null;
  businessId: string | null;
  confidence: number;
  source: ConfidenceSource;
  signals: string[];
  needsReview: boolean;
  reason: string;
};

export type BusinessIdEntity = {
  value: string;
  type: "IL_COMPANY" | "IL_AUTHORIZED_DEALER" | "IL_VAT" | "UNKNOWN";
  confidence: number;
  source: ConfidenceSource;
  line: string;
};

export type AmountEntity = {
  value: number;
  raw: string;
  type: "total" | "subtotal" | "vat" | "fee" | "unknown";
  confidence: number;
  source: ConfidenceSource;
  isSuspicious: boolean;
  needsReview: boolean;
  signals: string[];
  reason: string;
};

export type DateEntity = {
  value: Date | null;
  type: "invoice" | "payment" | "issue" | "unknown";
  confidence: number;
  source: ConfidenceSource;
  line: string | null;
  needsReview: boolean;
  reason: string;
};

export type DocumentEntities = {
  vendor: VendorEntity;
  businessIds: BusinessIdEntity[];
  amount: AmountEntity;
  date: DateEntity;
};

export type DocumentExtractionDecision = {
  amount: number;
  vendorName: string;
  date: Date | null;
  amountConfidence: ConfidenceLabel;
  vendorConfidence: ConfidenceLabel;
  dateConfidence: ConfidenceLabel;
  confidenceScore: number;
  needsReview: boolean;
  reviewReasons: string[];
};

export function confidenceToLabel(confidence: number): ConfidenceLabel {
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.65) return "medium";
  return "low";
}

export function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}