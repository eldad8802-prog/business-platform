/** Phase 0 — shared ground-truth record shape (file-based, never in DB). */

export type GroundTruth = {
  vendor: string | null;
  amount: number | null;
  date: string | null; // YYYY-MM-DD
  docType: string | null;
  direction: "income" | "expense" | "unknown" | null;
  isFinancial: boolean | null;
};

export type GroundTruthItem = {
  docId: number;
  businessId: number;
  /** How the truth was obtained. */
  source: "financial_record" | "manual";
  /** Ingestion channel (Document.source): "file" | "email" | "whatsapp". */
  channel?: string | null;
  /** Stored OCR text, used to re-run the engine offline. */
  ocrText: string;
  truth: GroundTruth;
  /**
   * Optional sampling metadata (set only by the stratified-sample builder).
   * Pre-computed tags that explain WHY this doc was chosen for manual labeling.
   * Never used as ground truth — only to ensure hard cases are present.
   */
  strata?: {
    channel: string | null;
    coarseDocType: string;
    ocrQuality: string;
    amountCandidateCount: number;
    dateCandidateCount: number;
    keywordFlags: string[];
  };
};

export type GroundTruthFile = {
  generatedAt: string;
  source: "financial_record" | "manual_template" | "manual";
  count: number;
  items: GroundTruthItem[];
};
