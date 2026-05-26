export type OutputProfile = {
  profileId:
    | "financial_transaction"
    | "tax_or_pension_document"
    | "quote_or_order"
    | "non_financial"
    | "unknown_review";
  reviewMode:
    | "full_financial"
    | "structured_document"
    | "quote_flow"
    | "non_financial"
    | "unknown";
  primaryFields: string[];
  secondaryFields: string[];
  hiddenFields: string[];
};

export type ApiExtracted = {
  documentId: number;
  amount?: number | null;
  vendorName?: string | null;
  category?: string | null;
  direction?: string | null;
  date?: string | null;
  confidenceScore?: number | null;
  amountConfidence?: string | null;
  vendorConfidence?: string | null;
  categoryConfidence?: string | null;
};

export type ApiDocument = {
  id: number;
  businessId: number;
  fileUrl: string;
  source: string;
  mimeType: string;
  status: string;
  createdAt: string;
};

export type GetDocumentResponse =
  | { error: string }
  | {
      success: true;
      document: ApiDocument;
      extracted: ApiExtracted | null;
      outputProfile: OutputProfile;
      outputProfileSource: "stored" | "unified" | "fallback_no_ocr";
      outputProfileComputedAt: string;
    };

export type ReviewState = "decision" | "summary" | "edit-field" | "done";
export type ReviewMode = "financial" | "document";
export type EditableField = "amount" | "vendorName" | "date" | "direction" | "category";
export type Direction = "expense" | "income" | "unknown";

export type TrafficLevel = "high" | "medium" | "low";

export type ExtractionConfidenceMeta = {
  amountConfidence: string | null;
  vendorConfidence: string | null;
  categoryConfidence: string | null;
  confidenceScore: number | null;
};

export type ReviewDraft = {
  amount: number | null;
  vendorName: string;
  date: string | null;
  direction: Direction;
  category: string;
};

export type TrustLevel = "high" | "medium" | "low" | "ambiguous";
