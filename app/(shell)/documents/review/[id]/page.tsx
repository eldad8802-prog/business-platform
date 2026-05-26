"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CATEGORIES, CATEGORY_MAP } from "@/lib/constants/categories";
import { fetchDocumentsInbox } from "@/lib/documents/fetch-inbox";
import {
  card,
  alertError,
  editPillBtn,
} from "../../ui";
import DocumentsHeader from "@/components/documents/DocumentsHeader";
import DocumentsReviewSkeleton from "@/components/documents/skeletons/DocumentsReviewSkeleton";

type OutputProfile = {
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

type ApiExtracted = {
  documentId: number;
  amount?: number | null;
  vendorName?: string | null;
  category?: string | null;
  direction?: string | null;
  date?: string | null;
  confidenceScore?: number | null;
  /** DB labels from extraction: typically high | medium | low */
  amountConfidence?: string | null;
  vendorConfidence?: string | null;
  categoryConfidence?: string | null;
};

type ApiDocument = {
  id: number;
  businessId: number;
  fileUrl: string;
  source: string;
  mimeType: string;
  status: string;
  createdAt: string;
};

type GetDocumentResponse =
  | { error: string }
  | {
      success: true;
      document: ApiDocument;
      extracted: ApiExtracted | null;
      outputProfile: OutputProfile;
      outputProfileSource: "stored" | "unified" | "fallback_no_ocr";
      outputProfileComputedAt: string;
    };

type ReviewState = "decision" | "summary" | "edit-field" | "done";
type ReviewMode = "financial" | "document";
type EditableField = "amount" | "vendorName" | "date" | "direction" | "category";
type Direction = "expense" | "income" | "unknown";

/** Traffic-light band for field reliability (UI only). */
type TrafficLevel = "high" | "medium" | "low";

type ExtractionConfidenceMeta = {
  amountConfidence: string | null;
  vendorConfidence: string | null;
  categoryConfidence: string | null;
  confidenceScore: number | null;
};

const TRAFFIC: Record<
  TrafficLevel,
  { dot: string; caption: string; captionColor: string }
> = {
  high: { dot: "#22c55e", caption: "גבוהה", captionColor: "#15803d" },
  medium: { dot: "#eab308", caption: "לבדיקה", captionColor: "#a16207" },
  low: { dot: "#ef4444", caption: "נמוכה", captionColor: "#b91c1c" },
};

function normalizeConfidenceLabel(raw: string | null | undefined): TrafficLevel {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "high") return "high";
  if (v === "medium") return "medium";
  if (v === "low") return "low";
  return "medium";
}

/** Mirrors inbox `dateProxyFromScore` — there is no persisted dateConfidence column. */
function scoreToTrafficLevel(score: number | null | undefined): TrafficLevel {
  if (score == null || !Number.isFinite(Number(score))) return "medium";
  const s = Number(score);
  if (s >= 0.85) return "high";
  if (s >= 0.65) return "medium";
  return "low";
}

function buildExtractionMeta(extracted: ApiExtracted | null): ExtractionConfidenceMeta | null {
  if (!extracted) return null;
  return {
    amountConfidence: extracted.amountConfidence ?? null,
    vendorConfidence: extracted.vendorConfidence ?? null,
    categoryConfidence: extracted.categoryConfidence ?? null,
    confidenceScore:
      typeof extracted.confidenceScore === "number" ? extracted.confidenceScore : null,
  };
}

function formatAmountDisplay(n: number): string {
  return n.toLocaleString("he-IL", { maximumFractionDigits: 2 });
}

function trafficForAmount(
  meta: ExtractionConfidenceMeta | null,
  draft: { amount: number | null }
): TrafficLevel {
  if (!isValidPositiveAmount(draft.amount)) return "low";
  if (meta?.amountConfidence) return normalizeConfidenceLabel(meta.amountConfidence);
  return "medium";
}

function trafficForVendor(
  meta: ExtractionConfidenceMeta | null,
  draft: { vendorName: string }
): TrafficLevel {
  if (!hasNonEmptyText(draft.vendorName)) return "low";
  if (meta?.vendorConfidence) return normalizeConfidenceLabel(meta.vendorConfidence);
  return "medium";
}

function trafficForDate(
  meta: ExtractionConfidenceMeta | null,
  draft: { date: string | null }
): TrafficLevel {
  if (!draft.date || !formatDateShort(draft.date)) return "low";
  return scoreToTrafficLevel(meta?.confidenceScore);
}

function trafficForCategory(
  meta: ExtractionConfidenceMeta | null,
  draft: { category: string }
): TrafficLevel {
  if (!hasNonEmptyText(draft.category)) return "low";
  if (meta?.categoryConfidence) return normalizeConfidenceLabel(meta.categoryConfidence);
  return "medium";
}

/** No persisted direction confidence — explicit income/expense → medium; unknown → low. */
function trafficForDirection(draft: { direction: Direction }): TrafficLevel {
  if (draft.direction === "expense" || draft.direction === "income") return "medium";
  return "low";
}

function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("he-IL");
}

function parseDirection(v: unknown): Direction {
  if (v === "income" || v === "expense") return v;
  return "unknown";
}

function isValidPositiveAmount(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function hasNonEmptyText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getPreviewKind(
  fileUrl: string,
  mimeType: string | null | undefined
): "pdf" | "image" | "unsupported" {
  const lowerUrl = fileUrl.toLowerCase();
  const lowerMime = String(mimeType || "").toLowerCase();

  if (lowerMime.includes("pdf") || lowerUrl.endsWith(".pdf")) return "pdf";
  if (
    lowerMime.startsWith("image/") ||
    lowerUrl.endsWith(".png") ||
    lowerUrl.endsWith(".jpg") ||
    lowerUrl.endsWith(".jpeg") ||
    lowerUrl.endsWith(".webp")
  ) {
    return "image";
  }

  return "unsupported";
}

function basePageStyle() {
  return { minHeight: "100vh", background: "#f3f7ff" as const };
}

function mainStyle() {
  return {
    maxWidth: 1120,
    margin: "0 auto",
    padding: "20px 14px 36px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 14,
  };
}

function primaryDarkButton(disabled?: boolean) {
  return {
    width: "100%",
    minHeight: 50,
    borderRadius: 10,
    border: "none",
    background: disabled ? "rgba(0, 43, 107, 0.45)" : "#22c55e",
    color: "#ffffff",
    fontSize: 15,
    fontWeight: 950,
    cursor: disabled ? "not-allowed" : "pointer",
  } as const;
}

function secondaryButton(disabled?: boolean) {
  return {
    width: "100%",
    minHeight: 50,
    borderRadius: 10,
    border: "1px solid #dfe7f3",
    background: "#ffffff",
    color: "#002b6b",
    fontSize: 14,
    fontWeight: 900,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  } as const;
}

function ReviewFieldRow(props: {
  label: string;
  displayValue: string;
  level: TrafficLevel;
  missing: boolean;
  onPrimary: () => void;
}) {
  const cfg = TRAFFIC[props.level];
  const primaryLabel = props.missing ? "הוסף" : "ערוך";
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 16,
        padding: "12px 14px",
        background: "#fafafa",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 800 }}>{props.label}</span>
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: cfg.dot,
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 12, fontWeight: 800, color: cfg.captionColor }}>
              {cfg.caption}
            </span>
          </div>
          <div
            style={{
              fontSize: 17,
              fontWeight: 950,
              color: props.missing ? "#9ca3af" : "#111827",
              overflowWrap: "anywhere",
              lineHeight: 1.35,
            }}
          >
            {props.missing ? "לא זוהה" : props.displayValue}
          </div>
        </div>
        <button type="button" style={editPillBtn} onClick={props.onPrimary}>
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}

function ExtractedDetailRow({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "28px 1fr auto",
        gap: 10,
        alignItems: "center",
        padding: "10px 0",
        borderBottom: "1px solid #eef2f7",
      }}
    >
      <div style={{ color: "#002b6b", fontSize: 17 }}>{icon}</div>
      <div style={{ color: "#64748b", fontSize: 12, fontWeight: 850 }}>{label}</div>
      <div style={{ color: "#0f172a", fontSize: 13, fontWeight: 950, textAlign: "left" }}>
        {value}
      </div>
    </div>
  );
}

function TrustChecklistItem({ children }: { children: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: "#22c55e", fontWeight: 950, lineHeight: 1.5 }}>✓</span>
      <span style={{ color: "#475569", fontSize: 12, fontWeight: 800, lineHeight: 1.55 }}>
        {children}
      </span>
    </div>
  );
}

function ReliabilityScale({ level }: { level: "high" | "medium" | "low" | "ambiguous" }) {
  const steps = [
    {
      key: "low",
      label: "נמוכה",
      color: "#ef4444",
      bg: "#fef2f2",
      text: "צריך תיקון",
    },
    {
      key: "ambiguous",
      label: "לא חד-משמעית",
      color: "#f97316",
      bg: "#fff7ed",
      text: "צריך החלטה",
    },
    {
      key: "medium",
      label: "בינונית",
      color: "#eab308",
      bg: "#fefce8",
      text: "בדיקה קצרה",
    },
    {
      key: "high",
      label: "גבוהה",
      color: "#22c55e",
      bg: "#f0fdf4",
      text: "מוכן לאישור",
    },
  ] as const;

  const active = steps.find((step) => step.key === level) ?? steps[1];

  return (
    <div
      style={{
        border: "1px solid #dfe7f3",
        background: "#ffffff",
        borderRadius: 14,
        padding: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div style={{ color: "#0f172a", fontSize: 13, fontWeight: 950 }}>
          מדרג אמינות המערכת
        </div>
        <div
          style={{
            borderRadius: 999,
            background: active.bg,
            color: active.color,
            padding: "5px 10px",
            fontSize: 12,
            fontWeight: 950,
          }}
        >
          {active.label}
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 6,
        }}
      >
        {steps.map((step) => {
          const isActive = step.key === level;
          return (
            <div
              key={step.key}
              style={{
                borderRadius: 10,
                padding: "9px 6px",
                background: isActive ? step.bg : "#f8fafc",
                border: isActive ? `1px solid ${step.color}` : "1px solid #e5e7eb",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: step.color,
                  margin: "0 auto 5px",
                  opacity: isActive ? 1 : 0.45,
                }}
              />
              <div
                style={{
                  color: isActive ? step.color : "#64748b",
                  fontSize: 11,
                  fontWeight: 950,
                  lineHeight: 1.3,
                }}
              >
                {step.text}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OutcomeRow({
  icon,
  title,
  body,
}: {
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "34px 1fr",
        gap: 10,
        padding: "12px 10px",
        borderBottom: "1px solid #d7f3e3",
      }}
    >
      <div style={{ color: "#22c55e", fontSize: 22 }}>{icon}</div>
      <div>
        <div style={{ color: "#0f172a", fontSize: 13, fontWeight: 950 }}>
          {title}
        </div>
        <div style={{ color: "#64748b", fontSize: 12, fontWeight: 800, marginTop: 3 }}>
          {body}
        </div>
      </div>
    </div>
  );
}

export default function ReviewPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string;

  const authHeader = useMemo(() => {
    if (typeof window === "undefined") return null;
    const token = window.localStorage.getItem("token");
    if (!token) return null;
    return `Bearer ${token}`;
  }, []);

  const [pageLoading, setPageLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [state, setState] = useState<ReviewState>("decision");
  const [reviewMode, setReviewMode] = useState<ReviewMode>("document");
  const [editField, setEditField] = useState<EditableField>("amount");
  const [approvedAs, setApprovedAs] = useState<"financial" | "document" | null>(null);
  const [showFieldDetails, setShowFieldDetails] = useState(false);
  const [nextPendingDocumentId, setNextPendingDocumentId] = useState<number | null>(null);

  const [document, setDocument] = useState<ApiDocument | null>(null);
  const [outputProfile, setOutputProfile] = useState<OutputProfile | null>(null);
  const [extractionMeta, setExtractionMeta] = useState<ExtractionConfidenceMeta | null>(null);
  const [editReturnTarget, setEditReturnTarget] = useState<"decision" | "summary">("summary");

  // Source-file preview state. The original bytes are streamed from the
  // protected `/api/documents/[id]/file` route (which requires Bearer auth),
  // turned into a Blob URL for `<iframe>` / `<img>` consumption, and
  // revoked when the document changes or the page unmounts.
  const [fileBlobUrl, setFileBlobUrl] = useState<string | null>(null);
  const [fileStatus, setFileStatus] = useState<
    "idle" | "loading" | "ready" | "missing"
  >("idle");
  const blobUrlRef = useRef<string | null>(null);

  const [draft, setDraft] = useState<{
    amount: number | null;
    vendorName: string;
    date: string | null;
    direction: Direction;
    category: string;
  }>({
    amount: null,
    vendorName: "",
    date: null,
    direction: "unknown",
    category: "general",
  });

  useEffect(() => {
    if (!id) return;

    const load = async () => {
      try {
        setPageLoading(true);
        setError(null);
        setPreviewFailed(false);
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
          blobUrlRef.current = null;
        }
        setFileBlobUrl(null);
        setFileStatus("idle");

        if (!authHeader) {
          throw new Error("כדי לבדוק מסמך צריך להתחבר מחדש.");
        }

        const res = await fetch(`/api/documents/${id}`, {
          headers: { authorization: authHeader },
        });
        const json = (await res.json()) as GetDocumentResponse;

        if (!res.ok) {
          const msg = "error" in json ? json.error : "שגיאה בטעינת המסמך";
          throw new Error(msg);
        }

        if ("error" in json) throw new Error(json.error || "שגיאה בטעינת המסמך");

        setDocument(json.document);
        setOutputProfile(json.outputProfile);
        setExtractionMeta(buildExtractionMeta(json.extracted as ApiExtracted | null));
        setEditReturnTarget("summary");
        setApprovedAs(null);
        setShowFieldDetails(false);
        setNextPendingDocumentId(null);

        const dir = parseDirection(json.extracted?.direction);

        setDraft({
          amount:
            typeof json.extracted?.amount === "number" ? json.extracted.amount : null,
          vendorName: String(json.extracted?.vendorName || ""),
          date: json.extracted?.date ? String(json.extracted.date) : null,
          direction: dir,
          category: String(json.extracted?.category || "general"),
        });

        const pid = json.outputProfile.profileId;

        // When the profile is `unknown_review` but the extracted draft already
        // looks like a real transaction (positive amount + vendor + date +
        // explicit direction + category), default the UI to the financial
        // flow. This preserves the explicit-user-choice rule (the API still
        // requires `explicitFinancial: true`) while making sure a clearly
        // financial document does not silently fall into the document-only
        // path and skip Reports/Search.
        const draftAmount =
          typeof json.extracted?.amount === "number" ? json.extracted.amount : null;
        const hasStrongFinancialSignals =
          draftAmount !== null &&
          draftAmount > 0 &&
          Boolean(json.extracted?.vendorName) &&
          Boolean(json.extracted?.date) &&
          (dir === "income" || dir === "expense") &&
          Boolean(json.extracted?.category);

        const defaultMode: ReviewMode =
          pid === "financial_transaction"
            ? "financial"
            : pid === "unknown_review" && hasStrongFinancialSignals
              ? "financial"
              : "document";

        setReviewMode(defaultMode);
        setState("decision");
      } catch (e: unknown) {
        setError(errorMessage(e, "שגיאה בטעינת המסמך"));
      } finally {
        setPageLoading(false);
      }
    };

    void load();
  }, [id, authHeader]);

  // Stream file bytes only when preview is shown (summary / edit-field), not on
  // the initial decision screen. Uses route `id` so fetch can start without
  // waiting on full document state beyond auth.
  useEffect(() => {
    if (!document || !authHeader || !id) {
      return;
    }

    const previewVisible = state !== "done" && state !== "decision";
    if (!previewVisible) {
      return;
    }

    if (blobUrlRef.current) {
      return;
    }

    const ctrl = new AbortController();

    const loadProtectedFile = async () => {
      setFileStatus("loading");
      setPreviewFailed(false);

      try {
        const res = await fetch(`/api/documents/${id}/file`, {
          headers: { authorization: authHeader },
          signal: ctrl.signal,
          cache: "no-store",
        });

        if (!res.ok) {
          // 404 here is the expected outcome for legacy documents whose
          // `fileUrl` is a `/uploads/<timestamp>` placeholder with no real
          // bytes on disk. The UI falls back to the explanatory empty state.
          setFileStatus("missing");
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        // Revoke any previously-held blob URL for this component before
        // installing the new one, so we never leak object URLs across
        // navigations between documents.
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
        }
        blobUrlRef.current = url;
        setFileBlobUrl(url);
        setFileStatus("ready");
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setFileStatus("missing");
      }
    };

    void Promise.resolve().then(loadProtectedFile);

    return () => {
      ctrl.abort();
    };
  }, [document, authHeader, id, state]);

  // Final cleanup on unmount — revoke any blob URL still held by this
  // component so we never leave dangling object URLs in memory.
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  const pid = outputProfile?.profileId || "unknown_review";
  const isUnknown = pid === "unknown_review";

  const editFieldTitle =
    editField === "amount"
      ? "עריכת סכום"
      : editField === "vendorName"
        ? "עריכת ספק"
        : editField === "date"
          ? "עריכת תאריך"
          : editField === "direction"
            ? "עריכת כיוון"
            : "עריכת קטגוריה";

  function firstMissingFinancialField(): EditableField | null {
    if (!isValidPositiveAmount(draft.amount)) return "amount";
    if (!hasNonEmptyText(draft.vendorName)) return "vendorName";
    if (!draft.date || !formatDateShort(draft.date)) return "date";
    if (draft.direction !== "expense" && draft.direction !== "income")
      return "direction";
    if (!hasNonEmptyText(draft.category)) return "category";
    return null;
  }

  async function refreshNextPendingDocument() {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) return;

    try {
      const snap = await fetchDocumentsInbox(token);
      const next = snap.items.find(
        (item) =>
          item.status === "needs_review" &&
          String(item.documentId) !== String(id)
      );
      setNextPendingDocumentId(next?.documentId ?? null);
    } catch {
      setNextPendingDocumentId(null);
    }
  }

  async function approveDocumentOnly() {
    if (!authHeader) {
      setError("כדי לשמור צריך להתחבר מחדש.");
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const res = await fetch(`/api/documents/${id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: authHeader,
        },
        body: JSON.stringify({
          explicitFinancial: false,
          extracted: {
            vendorName: draft.vendorName || null,
            category: draft.category || null,
            date: draft.date || null,
          },
        }),
      });

      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "לא הצלחנו לאשר את המסמך");
      }

      setApprovedAs("document");
      await refreshNextPendingDocument();
      setState("done");
    } catch (e: unknown) {
      setError(errorMessage(e, "שגיאה באישור המסמך"));
    } finally {
      setLoading(false);
    }
  }

  async function approveFinancial() {
    if (!authHeader) {
      setError("כדי לשמור צריך להתחבר מחדש.");
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const res = await fetch(`/api/documents/${id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: authHeader,
        },
        body: JSON.stringify({
          explicitFinancial: true,
          extracted: {
            amount: draft.amount,
            vendorName: draft.vendorName,
            date: draft.date,
            direction: draft.direction,
            category: draft.category,
          },
        }),
      });

      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "לא הצלחנו לשמור את העסקה");
      }

      setApprovedAs("financial");
      await refreshNextPendingDocument();
      setState("done");
    } catch (e: unknown) {
      setError(errorMessage(e, "שגיאה בשמירת העסקה"));
    } finally {
      setLoading(false);
    }
  }

  // Preview readiness is now driven by the protected file fetch, not by
  // `document.fileUrl`. The latter is just a stored basename and never a
  // navigable URL on its own.
  const previewReady = fileStatus === "ready" && !!fileBlobUrl;
  const previewLoading = fileStatus === "loading";
  const previewKind = getPreviewKind(
    fileBlobUrl || "",
    document?.mimeType
  );
  const shouldShowDocumentPreview = state !== "done" && state !== "decision";
  const showPreviewFallback =
    !previewReady || previewKind === "unsupported" || previewFailed;

  const amountLevel = trafficForAmount(extractionMeta, draft);
  const vendorLevel = trafficForVendor(extractionMeta, draft);
  const dateLevel = trafficForDate(extractionMeta, draft);
  const categoryLevel = trafficForCategory(extractionMeta, draft);
  const directionLevel = trafficForDirection(draft);

  const amountDisplay =
    typeof draft.amount === "number" && Number.isFinite(draft.amount)
      ? formatAmountDisplay(draft.amount)
      : "סכום לא זוהה";
  const vendorDisplay = hasNonEmptyText(draft.vendorName)
    ? draft.vendorName
    : "ספק לא זוהה";
  const dateDisplay = formatDateShort(draft.date) || "תאריך לא זוהה";
  const categoryDisplay = CATEGORY_MAP[draft.category] || draft.category || "כללי";

  const directionDisplay =
    draft.direction === "income"
      ? "הכנסה"
      : draft.direction === "expense"
        ? "הוצאה"
        : "עסקה לא מסווגת";

  const aiSummaryBody =
    reviewMode === "financial"
      ? `${directionDisplay} בסך ${amountDisplay}, בתאריך ${dateDisplay}, בקטגוריית ${categoryDisplay}.`
      : "המסמך יישמר בארכיון המסמכים, אבל לא ייצור עסקה ולא ישפיע על הדוחות.";

  const trustReasons = [
    reviewMode === "financial" && !isValidPositiveAmount(draft.amount)
      ? "לא זוהה סכום תקין לעסקה. צריך להשלים סכום לפני שהוא נכנס לדוחות."
      : reviewMode === "financial" && amountLevel !== "high"
        ? "הסכום זוהה, אבל כדאי לוודא שהוא הסכום הסופי של העסקה."
        : null,
    reviewMode === "financial" && !hasNonEmptyText(draft.vendorName)
      ? "לא זוהה ספק או לקוח ברור. זה חשוב כדי שהדוח והחיפוש יהיו שימושיים."
      : vendorLevel === "low"
        ? "שם הספק נראה חלקי או לא חד-משמעי במסמך."
        : vendorLevel === "medium"
          ? "שם הספק זוהה, אבל כדאי לוודא שהוא הגורם העסקי הנכון."
          : null,
    reviewMode === "financial" && (!draft.date || !formatDateShort(draft.date))
      ? "לא זוהה תאריך עסקה ברור, ולכן אי אפשר לשייך אותה בביטחון לחודש הנכון."
      : dateLevel === "low"
        ? "התאריך דורש בדיקה; ייתכן שהמסמך כולל כמה תאריכים או תאריך לא ברור."
        : dateLevel === "medium"
          ? "התאריך נראה סביר, אבל כדאי לוודא שזה תאריך העסקה ולא תאריך אחר במסמך."
          : null,
    reviewMode === "financial" && directionLevel === "low"
      ? "לא ברור אם זו הכנסה או הוצאה. הבחירה הזו קובעת איך הדוח יתעדכן."
      : null,
    categoryLevel === "low"
      ? "הקטגוריה לא מספיק ברורה. תיקון שלה יעזור לדוחות ולחבילה לרו״ח."
      : categoryLevel === "medium"
        ? "הקטגוריה היא הערכה טובה, אבל אפשר לדייק אותה לפני האישור."
        : null,
    pid === "unknown_review"
      ? "לא זוהתה עסקה פיננסית חד-משמעית, לכן המערכת מבקשת החלטה שלך לפני השפעה על הדוחות."
      : null,
    pid === "non_financial"
      ? "המסמך נראה כמו מידע כללי ולא כמו קבלה או עסקה פיננסית."
      : null,
    pid === "tax_or_pension_document"
      ? "המסמך נראה כמו אישור/מידע פיננסי, לא בהכרח עסקה שצריכה להיכנס לדוח כהכנסה או הוצאה."
      : null,
    pid === "quote_or_order"
      ? "המסמך נראה כמו הצעה או הזמנה. לא כל הצעה היא עסקה שבוצעה בפועל."
      : null,
  ].filter((reason): reason is string => Boolean(reason));

  const trustLevel =
    reviewMode !== "financial" || pid !== "financial_transaction"
      ? "ambiguous"
      : trustReasons.length === 0
        ? "high"
        : trustReasons.length <= 2
          ? "medium"
          : "low";

  const trustTitle =
    trustLevel === "high"
      ? "אפשר לסמוך על ההבנה העסקית"
      : trustLevel === "medium"
        ? "צריך בדיקה קצרה לפני אישור"
        : trustLevel === "low"
          ? "צריך לתקן לפני שזה נכנס לדוחות"
          : "צריך החלטה עסקית שלך";

  const trustSummary =
    trustReasons.length === 0
      ? "הסכום, הצד השני והתאריך נראים עקביים. אפשר לאשר במהירות."
      : trustReasons[0];

  const approvalImpact =
    reviewMode === "financial"
      ? "אישור יוסיף את העסקה לדוח החודשי, לחיפוש המסמכים ולחבילה לרו״ח."
      : "שמירה כמסמך מידע תשמור את המסמך, בלי להוסיף אותו לדוחות או לחיפוש העסקאות.";

  if (pageLoading) {
    return <DocumentsReviewSkeleton />;
  }

  if (!document) {
    return (
      <div dir="rtl" style={basePageStyle()}>
        <DocumentsHeader title="בדיקת מסמך" />
        <main style={mainStyle()}>
          <div style={card}>
            <div
              style={{
                fontSize: 22,
                color: "#111827",
                margin: 0,
                textAlign: "center",
                fontWeight: 900,
              }}
            >
              לא מצאנו את המסמך
            </div>
            <div
              style={{
                fontSize: 15,
                color: "#6b7280",
                textAlign: "center",
                marginTop: 12,
              }}
            >
              נסה לחזור לרשימת המסמכים ולפתוח שוב.
            </div>
            <div style={{ marginTop: 18 }}>
              <button
                type="button"
                style={primaryDarkButton(false)}
                onClick={() => router.push("/documents")}
              >
                חזרה למסמכים
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div dir="rtl" style={basePageStyle()}>
      <main style={mainStyle()}>
        <section style={{ textAlign: "center", padding: "4px 0 6px" }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              background: "#002b6b",
              color: "#ffffff",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              fontWeight: 950,
              marginBottom: 8,
            }}
          >
            {state === "done" ? "3" : "2"}
          </div>
          <h1
            style={{
              margin: 0,
              color: "#0f172a",
              fontSize: 28,
              lineHeight: 1.2,
              fontWeight: 950,
            }}
          >
            {state === "done" ? "אישור הושלם - התוצאה העסקית" : "בדיקת מסמך - אישור מערכת"}
          </h1>
          <p
            style={{
              margin: "6px 0 0",
              color: "#64748b",
              fontSize: 14,
              lineHeight: 1.6,
              fontWeight: 800,
            }}
          >
            {state === "done"
              ? "המסמך נוסף לדוחות - מה עכשיו?"
              : "המערכת ניתחה את המסמך - אתה רק מאשר ומתקן במידת הצורך"}
          </p>
        </section>

        {error ? <div style={alertError}>{error}</div> : null}

        {state === "decision" ? (
          <section style={{ ...card, borderRadius: 18, borderColor: "#dfe7f3" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                marginBottom: 14,
              }}
            >
              <button
                type="button"
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#002b6b",
                  fontSize: 13,
                  fontWeight: 900,
                  cursor: "pointer",
                }}
                onClick={() => router.push("/documents")}
              >
                חזרה →
              </button>
              <div style={{ color: "#0f172a", fontSize: 15, fontWeight: 950 }}>
                {reviewMode === "financial" ? "הוצאה עסקית" : "מסמך מידע"}
              </div>
              <div
                style={{
                  borderRadius: 999,
                  background: trustLevel === "high" ? "#dcfce7" : "#fef3c7",
                  color: trustLevel === "high" ? "#166534" : "#92400e",
                  padding: "6px 10px",
                  fontSize: 11,
                  fontWeight: 950,
                }}
              >
                {trustLevel === "high" ? "המערכת בטוחה" : "דורש בדיקה"}
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(260px, 1fr) minmax(260px, 1fr)",
                gap: 16,
              }}
            >
              <div
                style={{
                  border: "1px solid #dfe7f3",
                  background: "#f8fbff",
                  borderRadius: 14,
                  padding: 14,
                }}
              >
                <div
                  style={{
                    minHeight: 300,
                    background: "#ffffff",
                    border: "1px solid #e5e7eb",
                    borderRadius: 10,
                    padding: 18,
                    boxShadow: "0 10px 24px rgba(15, 23, 42, 0.08)",
                  }}
                >
                  {showPreviewFallback ? (
                    <>
                      <div style={{ textAlign: "center", fontSize: 22, fontWeight: 950 }}>
                        {vendorDisplay}
                      </div>
                      <div
                        style={{
                          textAlign: "center",
                          color: "#64748b",
                          fontSize: 12,
                          fontWeight: 800,
                          marginTop: 6,
                        }}
                      >
                        מקור המסמך
                      </div>
                      <div style={{ marginTop: 22, display: "grid", gap: 10 }}>
                        <ExtractedDetailRow icon="₪" label="סכום" value={amountDisplay} />
                        <ExtractedDetailRow icon="◷" label="תאריך" value={dateDisplay} />
                        <ExtractedDetailRow icon="▣" label="קטגוריה" value={categoryDisplay} />
                        <ExtractedDetailRow icon="↗" label="כיוון" value={directionDisplay} />
                      </div>
                    </>
                  ) : previewKind === "pdf" ? (
                    <iframe
                      src={fileBlobUrl as string}
                      title="תצוגת מסמך"
                      onError={() => setPreviewFailed(true)}
                      style={{
                        width: "100%",
                        height: 300,
                        border: "none",
                        borderRadius: 8,
                        background: "#ffffff",
                      }}
                    />
                  ) : (
                    <img
                      src={fileBlobUrl as string}
                      alt="תצוגת מסמך"
                      onError={() => setPreviewFailed(true)}
                      style={{
                        width: "100%",
                        maxHeight: 300,
                        objectFit: "contain",
                        borderRadius: 8,
                      }}
                    />
                  )}
                </div>
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                <div
                  style={{
                    border: "1px solid #bbf7d0",
                    background: "#f0fdf4",
                    borderRadius: 14,
                    padding: 14,
                  }}
                >
                  <div style={{ color: "#166534", fontSize: 12, fontWeight: 950, marginBottom: 8 }}>
                    המערכת זיהתה
                  </div>
                  <ExtractedDetailRow icon="⌂" label="ספק" value={vendorDisplay} />
                  <ExtractedDetailRow icon="₪" label="סכום" value={amountDisplay} />
                  <ExtractedDetailRow icon="◷" label="תאריך" value={dateDisplay} />
                  <ExtractedDetailRow icon="▣" label="קטגוריה" value={categoryDisplay} />
                  <ExtractedDetailRow icon="→" label="כיוון" value={directionDisplay} />
                </div>

                <div
                  style={{
                    border: "1px solid #e9d5ff",
                    background: "#fbf7ff",
                    borderRadius: 14,
                    padding: 14,
                  }}
                >
                  <div style={{ color: "#6b21a8", fontSize: 13, fontWeight: 950, marginBottom: 10 }}>
                    מה יקרה אחרי אישור?
                  </div>
                  <div style={{ display: "grid", gap: 7 }}>
                    <TrustChecklistItem>יתווסף לדוח החודשי</TrustChecklistItem>
                    <TrustChecklistItem>זמין בחיפוש מסמכים</TrustChecklistItem>
                    <TrustChecklistItem>ייכלל בחבילה לרו״ח</TrustChecklistItem>
                    <TrustChecklistItem>{approvalImpact}</TrustChecklistItem>
                  </div>
                </div>
              </div>
            </div>

            <div
              style={{
                border: "1px solid #dfe7f3",
                background: "#ffffff",
                borderRadius: 14,
                padding: 14,
                marginTop: 14,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span
                  style={{
                    borderRadius: 999,
                    background: trustLevel === "high" ? "#dcfce7" : "#fef3c7",
                    color: trustLevel === "high" ? "#166534" : "#92400e",
                    padding: "5px 9px",
                    fontSize: 12,
                    fontWeight: 950,
                  }}
                >
                  {trustTitle}
                </span>
              </div>
              <p
                style={{
                  margin: 0,
                  color: trustLevel === "high" ? "#166534" : "#92400e",
                  fontSize: 13,
                  fontWeight: 850,
                  lineHeight: 1.55,
                }}
              >
                {trustSummary}
              </p>
              {trustReasons.length > 1 ? (
                <div style={{ marginTop: 8, display: "grid", gap: 5 }}>
                  {trustReasons.slice(1, 4).map((reason) => (
                    <TrustChecklistItem key={reason}>{reason}</TrustChecklistItem>
                  ))}
                </div>
              ) : null}
            </div>

            <div style={{ marginTop: 12 }}>
              <ReliabilityScale level={trustLevel} />
            </div>

            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                style={secondaryButton(loading)}
                disabled={loading}
                onClick={() => setShowFieldDetails((v) => !v)}
              >
                {showFieldDetails ? "הסתר פרטים ועריכה" : "הצג פרטים ועריכה"}
              </button>
            </div>

            {showFieldDetails ? (
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                <ReviewFieldRow
                  label="סכום"
                  missing={!isValidPositiveAmount(draft.amount)}
                  displayValue={
                    typeof draft.amount === "number" ? formatAmountDisplay(draft.amount) : ""
                  }
                  level={amountLevel}
                  onPrimary={() => {
                    setEditReturnTarget("decision");
                    setEditField("amount");
                    setState("edit-field");
                  }}
                />
                <ReviewFieldRow
                  label="ספק"
                  missing={!hasNonEmptyText(draft.vendorName)}
                  displayValue={draft.vendorName}
                  level={vendorLevel}
                  onPrimary={() => {
                    setEditReturnTarget("decision");
                    setEditField("vendorName");
                    setState("edit-field");
                  }}
                />
                <ReviewFieldRow
                  label="תאריך"
                  missing={!draft.date || !formatDateShort(draft.date)}
                  displayValue={formatDateShort(draft.date)}
                  level={dateLevel}
                  onPrimary={() => {
                    setEditReturnTarget("decision");
                    setEditField("date");
                    setState("edit-field");
                  }}
                />
                <ReviewFieldRow
                  label="קטגוריה"
                  missing={!hasNonEmptyText(draft.category)}
                  displayValue={CATEGORY_MAP[draft.category] || draft.category}
                  level={categoryLevel}
                  onPrimary={() => {
                    setEditReturnTarget("decision");
                    setEditField("category");
                    setState("edit-field");
                  }}
                />
                <ReviewFieldRow
                  label="כיוון"
                  missing={draft.direction === "unknown"}
                  displayValue={
                    draft.direction === "expense"
                      ? "הוצאה"
                      : draft.direction === "income"
                        ? "הכנסה"
                        : ""
                  }
                  level={directionLevel}
                  onPrimary={() => {
                    setEditReturnTarget("decision");
                    setEditField("direction");
                    setState("edit-field");
                  }}
                />
              </div>
            ) : null}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                marginTop: 16,
              }}
            >
              <button
                type="button"
                disabled={loading}
                style={secondaryButton(loading)}
                onClick={() => void approveDocumentOnly()}
              >
                שמור כמסמך מידע
              </button>
              <button
                type="button"
                disabled={loading}
                style={primaryDarkButton(loading)}
                onClick={() => {
                  if (reviewMode !== "financial") {
                    if (isUnknown) {
                      setReviewMode("financial");
                      return;
                    }
                    void approveDocumentOnly();
                    return;
                  }

                  const missing = firstMissingFinancialField();
                  if (missing) {
                    setEditReturnTarget("decision");
                    setEditField(missing);
                    setState("edit-field");
                    return;
                  }
                  void approveFinancial();
                }}
              >
                {loading
                  ? "שומר..."
                  : reviewMode === "financial"
                    ? "אשר ושמור כעסקה"
                    : isUnknown
                      ? "זו קבלה / עסקה"
                      : "אשר ושמור"}
              </button>
            </div>
          </section>
        ) : null}

        {state === "summary" ? (
          <section style={card}>
            {reviewMode === "financial" ? (
              <>
                <div style={{ fontWeight: 950, color: "#111827", fontSize: 18, marginBottom: 8 }}>
                  אישור העסקה
                </div>
                <p style={{ margin: "0 0 14px", color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
                  {aiSummaryBody} {approvalImpact}
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <ReviewFieldRow
                    label="סכום"
                    missing={!isValidPositiveAmount(draft.amount)}
                    displayValue={
                      typeof draft.amount === "number" ? formatAmountDisplay(draft.amount) : ""
                    }
                    level={trafficForAmount(extractionMeta, draft)}
                    onPrimary={() => {
                      setEditReturnTarget("summary");
                      setEditField("amount");
                      setState("edit-field");
                    }}
                  />
                  <ReviewFieldRow
                    label="ספק"
                    missing={!hasNonEmptyText(draft.vendorName)}
                    displayValue={draft.vendorName}
                    level={trafficForVendor(extractionMeta, draft)}
                    onPrimary={() => {
                      setEditReturnTarget("summary");
                      setEditField("vendorName");
                      setState("edit-field");
                    }}
                  />
                  <ReviewFieldRow
                    label="תאריך"
                    missing={!draft.date || !formatDateShort(draft.date)}
                    displayValue={formatDateShort(draft.date)}
                    level={trafficForDate(extractionMeta, draft)}
                    onPrimary={() => {
                      setEditReturnTarget("summary");
                      setEditField("date");
                      setState("edit-field");
                    }}
                  />
                  <ReviewFieldRow
                    label="כיוון"
                    missing={draft.direction === "unknown"}
                    displayValue={
                      draft.direction === "expense"
                        ? "הוצאה"
                        : draft.direction === "income"
                          ? "הכנסה"
                          : ""
                    }
                    level={trafficForDirection(draft)}
                    onPrimary={() => {
                      setEditReturnTarget("summary");
                      setEditField("direction");
                      setState("edit-field");
                    }}
                  />
                  <ReviewFieldRow
                    label="קטגוריה"
                    missing={!hasNonEmptyText(draft.category)}
                    displayValue={CATEGORY_MAP[draft.category] || draft.category}
                    level={trafficForCategory(extractionMeta, draft)}
                    onPrimary={() => {
                      setEditReturnTarget("summary");
                      setEditField("category");
                      setState("edit-field");
                    }}
                  />
                </div>

                {/* Outcome notice — explains exactly what will happen on approve */}
                <div
                  style={{
                    marginTop: 14,
                    border: "1px solid #bbf7d0",
                    background: "#f0fdf4",
                    color: "#065f46",
                    borderRadius: 16,
                    padding: 12,
                    fontSize: 13,
                    fontWeight: 800,
                    lineHeight: 1.5,
                  }}
                >
                  אחרי האישור: העסקה תיכנס לדוח החודשי, תהיה זמינה בחיפוש ותיכלל בחבילה לרו״ח.
                </div>

                <div style={{ marginTop: 16 }}>
                  <button
                    type="button"
                    disabled={loading}
                    style={primaryDarkButton(loading)}
                    onClick={() => {
                      const missing = firstMissingFinancialField();
                      if (missing) {
                        setEditReturnTarget("summary");
                        setEditField(missing);
                        setState("edit-field");
                        return;
                      }
                      void approveFinancial();
                    }}
                  >
                    {(() => {
                      const missing = firstMissingFinancialField();
                      if (loading) return "שומר...";
                      if (missing) return "השלם שדה נדרש";
                      return "אשר והוסף לדוח";
                    })()}
                  </button>
                </div>

                {/* Allow the user to fall back to document-only mode if they
                    decide this is informational, not an actual transaction. */}
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    disabled={loading}
                    style={secondaryButton(loading)}
                    onClick={() => setReviewMode("document")}
                  >
                    שמור כמסמך מידע במקום
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 950, color: "#111827", fontSize: 18, marginBottom: 10 }}>
                  שמירה כמסמך מידע
                </div>

                <div style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
                  {aiSummaryBody} אפשר לערוך שדות לזיהוי פנימי, אבל האישור לא ייצור עסקה פיננסית.
                </div>

                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                  <ReviewFieldRow
                    label="סכום"
                    missing={!isValidPositiveAmount(draft.amount)}
                    displayValue={
                      typeof draft.amount === "number" ? formatAmountDisplay(draft.amount) : ""
                    }
                    level={trafficForAmount(extractionMeta, draft)}
                    onPrimary={() => {
                      setEditReturnTarget("summary");
                      setEditField("amount");
                      setState("edit-field");
                    }}
                  />
                  <ReviewFieldRow
                    label="ספק"
                    missing={!hasNonEmptyText(draft.vendorName)}
                    displayValue={draft.vendorName}
                    level={trafficForVendor(extractionMeta, draft)}
                    onPrimary={() => {
                      setEditReturnTarget("summary");
                      setEditField("vendorName");
                      setState("edit-field");
                    }}
                  />
                  <ReviewFieldRow
                    label="תאריך"
                    missing={!draft.date || !formatDateShort(draft.date)}
                    displayValue={formatDateShort(draft.date)}
                    level={trafficForDate(extractionMeta, draft)}
                    onPrimary={() => {
                      setEditReturnTarget("summary");
                      setEditField("date");
                      setState("edit-field");
                    }}
                  />
                  <ReviewFieldRow
                    label="קטגוריה"
                    missing={!hasNonEmptyText(draft.category)}
                    displayValue={CATEGORY_MAP[draft.category] || draft.category}
                    level={trafficForCategory(extractionMeta, draft)}
                    onPrimary={() => {
                      setEditReturnTarget("summary");
                      setEditField("category");
                      setState("edit-field");
                    }}
                  />
                  <ReviewFieldRow
                    label="כיוון"
                    missing={draft.direction === "unknown"}
                    displayValue={
                      draft.direction === "expense"
                        ? "הוצאה"
                        : draft.direction === "income"
                          ? "הכנסה"
                          : ""
                    }
                    level={trafficForDirection(draft)}
                    onPrimary={() => {
                      setEditReturnTarget("summary");
                      setEditField("direction");
                      setState("edit-field");
                    }}
                  />
                </div>

                {/* Outcome notice — explicit about what will NOT happen */}
                <div
                  style={{
                    marginTop: 14,
                    border: "1px solid #e5e7eb",
                    background: "#f9fafb",
                    color: "#374151",
                    borderRadius: 16,
                    padding: 12,
                    fontSize: 13,
                    fontWeight: 800,
                    lineHeight: 1.5,
                  }}
                >
                  ייקלט כמסמך מידע. לא ייכנס לדוחות, לחיפוש העסקאות או לחבילה לרו״ח.
                </div>

                <div style={{ marginTop: 16 }}>
                  <button
                    type="button"
                    disabled={loading}
                    style={primaryDarkButton(loading)}
                    onClick={() => void approveDocumentOnly()}
                  >
                    {loading ? "שומר..." : "אשר ושמור כמסמך מידע"}
                  </button>
                </div>

                {/* Escape hatch: only for `unknown_review` profiles, since the
                    approve API only honours explicitFinancial=true for those.
                    For tax/quote/non_financial profiles we keep document-only
                    behaviour to avoid auto-promoting non-financial documents. */}
                {isUnknown ? (
                  <div style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      disabled={loading}
                      style={secondaryButton(loading)}
                      onClick={() => setReviewMode("financial")}
                    >
                      זו בעצם קבלה / עסקה — שמור כעסקה
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </section>
        ) : null}

        {state === "edit-field" ? (
          <section style={card}>
            <div style={{ fontWeight: 950, color: "#111827", fontSize: 18, marginBottom: 10 }}>
              {editFieldTitle}
            </div>

            {editField === "amount" ? (
              <input
                type="number"
                value={draft.amount ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    amount: e.target.value === "" ? null : Number(e.target.value),
                  }))
                }
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 14,
                  border: "1px solid #d1d5db",
                  fontSize: 16,
                  boxSizing: "border-box",
                }}
              />
            ) : null}

            {editField === "vendorName" ? (
              <input
                value={draft.vendorName}
                onChange={(e) => setDraft((d) => ({ ...d, vendorName: e.target.value }))}
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 14,
                  border: "1px solid #d1d5db",
                  fontSize: 16,
                  boxSizing: "border-box",
                }}
              />
            ) : null}

            {editField === "date" ? (
              <input
                type="date"
                value={draft.date ? draft.date.slice(0, 10) : ""}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    date: e.target.value ? new Date(e.target.value).toISOString() : null,
                  }))
                }
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 14,
                  border: "1px solid #d1d5db",
                  fontSize: 16,
                  boxSizing: "border-box",
                }}
              />
            ) : null}

            {editField === "direction" ? (
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  style={{
                    flex: 1,
                    padding: "12px 14px",
                    borderRadius: 16,
                    border: "1px solid #e5e7eb",
                    background: draft.direction === "expense" ? "#111827" : "#ffffff",
                    color: draft.direction === "expense" ? "#ffffff" : "#111827",
                    fontWeight: 950,
                    cursor: "pointer",
                  }}
                  onClick={() => setDraft((d) => ({ ...d, direction: "expense" }))}
                >
                  הוצאה
                </button>
                <button
                  type="button"
                  style={{
                    flex: 1,
                    padding: "12px 14px",
                    borderRadius: 16,
                    border: "1px solid #e5e7eb",
                    background: draft.direction === "income" ? "#111827" : "#ffffff",
                    color: draft.direction === "income" ? "#ffffff" : "#111827",
                    fontWeight: 950,
                    cursor: "pointer",
                  }}
                  onClick={() => setDraft((d) => ({ ...d, direction: "income" }))}
                >
                  הכנסה
                </button>
              </div>
            ) : null}

            {editField === "category" ? (
              <select
                value={draft.category}
                onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 14,
                  border: "1px solid #d1d5db",
                  fontSize: 16,
                  boxSizing: "border-box",
                  background: "#ffffff",
                }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            ) : null}

            {/* The "confirm" button here only commits the field edit to local
                draft state and returns to the summary; the actual DB write
                happens when the user approves on the summary screen. The copy
                is intentionally "אישור" rather than "שמור" so users do not
                expect this click alone to persist the document. */}
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                disabled={loading}
                style={primaryDarkButton(loading)}
                onClick={() => setState(editReturnTarget)}
              >
                אישור
              </button>
            </div>

            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                disabled={loading}
                style={secondaryButton(loading)}
                onClick={() => setState(editReturnTarget)}
              >
                ביטול
              </button>
            </div>
          </section>
        ) : null}

        {state === "done" ? (
          <section
            style={{
              ...card,
              borderRadius: 18,
              borderColor: "#dfe7f3",
              maxWidth: 620,
              width: "100%",
              margin: "0 auto",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 96,
                height: 96,
                borderRadius: 999,
                background: "#22c55e",
                color: "#ffffff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 54,
                fontWeight: 950,
                margin: "4px auto 18px",
              }}
            >
              ✓
            </div>
            <h2
              style={{
                margin: 0,
                color: "#0f172a",
                fontSize: 22,
                lineHeight: 1.3,
                fontWeight: 950,
              }}
            >
              המסמך אושר בהצלחה!
            </h2>
            <p
              style={{
                margin: "8px 0 18px",
                color: "#64748b",
                fontSize: 14,
                fontWeight: 850,
                lineHeight: 1.6,
              }}
            >
              {approvedAs === "financial"
                ? `${directionDisplay} בסך ${amountDisplay} נוספה לדוחות ${new Date().getFullYear()}.`
                : "המסמך נשמר כמידע עסקי ולא השפיע על הדוחות."}
            </p>

            <div
              style={{
                border: "1px solid #bbf7d0",
                background: "#f0fdf4",
                borderRadius: 12,
                textAlign: "right",
                overflow: "hidden",
              }}
            >
              <OutcomeRow
                icon="▤"
                title="נוסף לדוח החודשי"
                body={
                  approvedAs === "financial"
                    ? "התנועה מופיעה בדוח החודש"
                    : "המסמך נשמר בארכיון המסמכים"
                }
              />
              <OutcomeRow
                icon="₪"
                title="עודכן בהוצאות העסק"
                body={
                  approvedAs === "financial"
                    ? "הנתונים הפיננסיים עודכנו"
                    : "לא נוצרה תנועה פיננסית"
                }
              />
              <OutcomeRow
                icon="⌕"
                title="זמין בחיפוש"
                body="ניתן לחפש לפי ספק, תאריך, סכום וסטטוס"
              />
              <OutcomeRow
                icon="□"
                title="ייכלל בחבילה לרו״ח"
                body={
                  approvedAs === "financial"
                    ? "ייצא בקובצי הייצוא הבאים"
                    : "יישמר לעיון פנימי"
                }
              />
            </div>

            <div
              style={{
                marginTop: 18,
                border: "1px solid #dfe7f3",
                borderRadius: 14,
                padding: 14,
                background: "#ffffff",
              }}
            >
              <div style={{ color: "#0f172a", fontSize: 14, fontWeight: 950, marginBottom: 10 }}>
                מה תרצה לעשות עכשיו?
              </div>
              <button
                type="button"
                style={{ ...primaryDarkButton(false), background: "#002b6b" }}
                onClick={() =>
                  nextPendingDocumentId
                    ? router.push(`/documents/review/${nextPendingDocumentId}`)
                    : router.push("/documents/inbox")
                }
              >
                {nextPendingDocumentId
                  ? "בדוק את המסמך הבא"
                  : "חזור למסמכים שמחכים לבדיקה"}
                <span style={{ marginInlineStart: 10 }}>←</span>
              </button>
              <button
                type="button"
                style={{ ...secondaryButton(false), marginTop: 10 }}
                onClick={() => router.push("/documents")}
              >
                חזור למרכז הפיננסי
              </button>
            </div>

            {approvedAs === "financial" ? (
              <button
                type="button"
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#002b6b",
                  marginTop: 14,
                  fontSize: 12,
                  fontWeight: 900,
                  cursor: "pointer",
                }}
                onClick={() => router.push("/documents/search")}
              >
                צפה בפרטי המסמך
              </button>
            ) : null}
          </section>
        ) : null}

        {shouldShowDocumentPreview ? (
          <section style={card}>
            <div style={{ fontWeight: 950, color: "#111827", fontSize: 16, marginBottom: 12 }}>
              תצוגת מסמך
            </div>

            {showPreviewFallback ? (
              <div
                style={{
                  border: "1px dashed #d1d5db",
                  borderRadius: 22,
                  background: "#f9fafb",
                  padding: 22,
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 34, marginBottom: 8 }}>📄</div>
                <div style={{ fontSize: 18, fontWeight: 950, color: "#111827" }}>
                  {previewLoading
                    ? "טוען תצוגת מסמך..."
                    : "אין תצוגה מקדימה זמינה"}
                </div>
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 14,
                    color: "#6b7280",
                    lineHeight: 1.6,
                  }}
                >
                  {previewLoading
                    ? "מורידים את קובץ המקור."
                    : "אין קובץ מקור זמין למסמך הזה. הנתונים שחולצו עדיין שמורים, אבל לא נשמר עותק להצגה."}
                </div>
              </div>
            ) : previewKind === "pdf" ? (
              <iframe
                src={fileBlobUrl as string}
                title="תצוגת מסמך"
                onError={() => setPreviewFailed(true)}
                style={{
                  width: "100%",
                  height: 520,
                  borderRadius: 18,
                  border: "1px solid #e5e7eb",
                  background: "#ffffff",
                }}
              />
            ) : (
              <img
                src={fileBlobUrl as string}
                alt="תצוגת מסמך"
                onError={() => setPreviewFailed(true)}
                style={{
                  width: "100%",
                  maxHeight: 620,
                  objectFit: "contain",
                  borderRadius: 18,
                  border: "1px solid #e5e7eb",
                  display: "block",
                  background: "#ffffff",
                }}
              />
            )}
          </section>
        ) : null}
      </main>
    </div>
  );
}