"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { fetchDocumentsHubSummary } from "@/lib/documents/fetch-inbox";
import { alertError } from "../../ui";
import DocumentsReviewSkeleton from "@/components/documents/skeletons/DocumentsReviewSkeleton";
import ReviewHero from "@/components/documents/review/ReviewHero";
import ReviewDecisionPanel from "@/components/documents/review/ReviewDecisionPanel";
import ReviewSummarySection from "@/components/documents/review/ReviewSummarySection";
import {
  ReviewDocumentPreviewLazy,
  ReviewDoneStateLazy,
  ReviewFieldEditorLazy,
} from "@/components/documents/review/review-lazy";
import ReviewNotFound from "@/components/documents/review/ReviewNotFound";
import { basePageStyle, mainStyle } from "@/components/documents/review/review-ui";
import { TOKEN } from "@/lib/design/documents-theme";
import { errorMessage } from "@/lib/documents/review/format";
import { buildExtractionMeta } from "@/lib/documents/review/meta";
import { getPreviewKind } from "@/lib/documents/review/preview";
import {
  resolvePreviewView,
  shouldLoadDocumentPreview,
} from "@/lib/documents/review/preview-visibility";
import { computeTrustContext, trafficLevelsForDraft } from "@/lib/documents/review/trust";
import {
  firstMissingFinancialField,
  parseDirection,
} from "@/lib/documents/review/validation";
import type {
  ApiDocument,
  ApiExtracted,
  EditableField,
  ExtractionConfidenceMeta,
  GetDocumentResponse,
  OutputProfile,
  ReviewDraft,
  ReviewMode,
  ReviewState,
} from "@/lib/documents/review/types";

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
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [documentOnlyConfirmOpen, setDocumentOnlyConfirmOpen] = useState(false);
  const [nextPendingDocumentId, setNextPendingDocumentId] = useState<number | null>(null);

  const [document, setDocument] = useState<ApiDocument | null>(null);
  const [outputProfile, setOutputProfile] = useState<OutputProfile | null>(null);
  const [extractionMeta, setExtractionMeta] = useState<ExtractionConfidenceMeta | null>(null);

  const [fileBlobUrl, setFileBlobUrl] = useState<string | null>(null);
  const [fileStatus, setFileStatus] = useState<"idle" | "loading" | "ready" | "missing">(
    "idle"
  );
  const blobUrlRef = useRef<string | null>(null);

  const [draft, setDraft] = useState<ReviewDraft>({
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

  useEffect(() => {
    if (!document || !authHeader || !id) {
      return;
    }

    if (!shouldLoadDocumentPreview(state)) {
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
          setFileStatus("missing");
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

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

  const trustContext = useMemo(
    () =>
      computeTrustContext({
        draft,
        extractionMeta,
        reviewMode,
        profileId: pid,
      }),
    [draft, extractionMeta, reviewMode, pid]
  );

  const trafficLevels = useMemo(
    () => trafficLevelsForDraft(extractionMeta, draft),
    [extractionMeta, draft]
  );

  const refreshNextPendingDocument = useCallback(async () => {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) return;

    try {
      const snap = await fetchDocumentsHubSummary(token);
      const next = snap.nextPending;
      if (next && String(next.documentId) !== String(id)) {
        setNextPendingDocumentId(next.documentId);
      } else {
        setNextPendingDocumentId(null);
      }
    } catch {
      setNextPendingDocumentId(null);
    }
  }, [id]);

  const approveDocumentOnly = useCallback(async () => {
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
  }, [authHeader, draft, id, refreshNextPendingDocument]);

  const approveFinancial = useCallback(async () => {
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
  }, [authHeader, draft, id, refreshNextPendingDocument]);

  const previewReady = fileStatus === "ready" && !!fileBlobUrl;
  const previewLoading = fileStatus === "loading";
  const previewKind = getPreviewKind(fileBlobUrl || "", document?.mimeType);
  const shouldShowDocumentPreview = state !== "done" && state !== "decision";
  const showPreviewFallback =
    !previewReady || previewKind === "unsupported" || previewFailed;
  const previewView = resolvePreviewView({
    fileStatus,
    previewKind,
    fileBlobUrl,
    previewFailed,
  });

  const handleEditField = useCallback(
    (field: EditableField) => {
      setEditField(field);
      setEditModalOpen(true);
    },
    []
  );

  const handleSummaryEditField = useCallback((field: EditableField) => {
    setEditField(field);
    setEditModalOpen(true);
  }, []);

  const handleSummaryApproveFinancial = useCallback(() => {
    const missing = firstMissingFinancialField(draft);
    if (missing) {
      setEditField(missing);
      setEditModalOpen(true);
      return;
    }
    void approveFinancial();
  }, [draft, approveFinancial]);

  const handleDecisionPrimaryApprove = useCallback(() => {
    if (reviewMode !== "financial") {
      if (isUnknown) {
        setReviewMode("financial");
        return;
      }
      setDocumentOnlyConfirmOpen(true);
      return;
    }

    const missing = firstMissingFinancialField(draft);
    if (missing) {
      setEditField(missing);
      setEditModalOpen(true);
      return;
    }
    void approveFinancial();
  }, [reviewMode, isUnknown, draft, approveFinancial]);

  if (pageLoading) {
    return <DocumentsReviewSkeleton />;
  }

  if (!document) {
    return <ReviewNotFound onBack={() => router.push("/documents")} />;
  }

  return (
    <div dir="rtl" style={basePageStyle()}>
      <main style={mainStyle()}>
        <section style={reviewTopBarStyle}>
          <button
            type="button"
            onClick={() => router.push("/documents")}
            style={reviewBackButtonStyle}
          >
            <BackChevronIcon />
            חזרה למסמכים
          </button>
          <div style={reviewTopTitleWrapStyle}>
            <div style={reviewTopTitleStyle}>אימות מסמך</div>
            <div style={reviewTopMetaStyle}>בדיקה, תיקון ואישור במקום אחד</div>
          </div>
          <div style={reviewTopStatusStyle}>
            {state === "done" ? "הושלם" : "בתהליך"}
          </div>
        </section>
        <ReviewHero state={state} />

        {error ? <div style={alertError}>{error}</div> : null}

        {state === "decision" ? (
          <ReviewDecisionPanel
            reviewMode={reviewMode}
            trustLevel={trustContext.trustLevel}
            onBack={() => router.push("/documents")}
            previewView={previewView}
            fileBlobUrl={fileBlobUrl}
            onPreviewFailed={() => setPreviewFailed(true)}
            vendorDisplay={trustContext.vendorDisplay}
            amountDisplay={trustContext.amountDisplay}
            dateDisplay={trustContext.dateDisplay}
            categoryDisplay={trustContext.categoryDisplay}
            directionDisplay={trustContext.directionDisplay}
            approvalImpact={trustContext.approvalImpact}
            trustTitle={trustContext.trustTitle}
            trustSummary={trustContext.trustSummary}
            trustReasons={trustContext.trustReasons}
            fieldList={{
              showFieldDetails,
              onToggleFieldDetails: () => setShowFieldDetails((v) => !v),
              loading,
              draft,
              extractionMeta,
              ...trafficLevels,
              editReturnTarget: "decision",
              onEditField: handleEditField,
            }}
            actions={{
              loading,
              reviewMode,
              isUnknown,
              onApproveDocumentOnly: () => setDocumentOnlyConfirmOpen(true),
              onPrimaryApprove: handleDecisionPrimaryApprove,
            }}
          />
        ) : null}

        {state === "summary" ? (
          <ReviewSummarySection
            reviewMode={reviewMode}
            isUnknown={isUnknown}
            loading={loading}
            draft={draft}
            extractionMeta={extractionMeta}
            aiSummaryBody={trustContext.aiSummaryBody}
            approvalImpact={trustContext.approvalImpact}
            onEditField={handleSummaryEditField}
            onSetReviewMode={setReviewMode}
            onApproveFinancial={handleSummaryApproveFinancial}
            onApproveDocumentOnly={() => setDocumentOnlyConfirmOpen(true)}
          />
        ) : null}

        {state === "done" ? (
          <ReviewDoneStateLazy
            approvedAs={approvedAs}
            directionDisplay={trustContext.directionDisplay}
            amountDisplay={trustContext.amountDisplay}
            nextPendingDocumentId={nextPendingDocumentId}
            onNext={() =>
              nextPendingDocumentId
                ? router.push(`/documents/review/${nextPendingDocumentId}`)
                : router.push("/documents/inbox")
            }
            onHub={() => router.push("/documents")}
            onSearch={() => router.push("/documents/search")}
          />
        ) : null}

        {shouldShowDocumentPreview ? (
          <ReviewDocumentPreviewLazy
            showPreviewFallback={showPreviewFallback}
            previewLoading={previewLoading}
            previewKind={previewKind}
            fileBlobUrl={fileBlobUrl}
            onPreviewFailed={() => setPreviewFailed(true)}
          />
        ) : null}

        {editModalOpen ? (
          <ReviewOverlayShell title={editFieldTitle} onClose={() => setEditModalOpen(false)}>
            <ReviewFieldEditorLazy
              editFieldTitle={editFieldTitle}
              editField={editField}
              draft={draft}
              loading={loading}
              onDraftChange={setDraft}
              onConfirm={() => setEditModalOpen(false)}
              onCancel={() => setEditModalOpen(false)}
            />
          </ReviewOverlayShell>
        ) : null}

        {documentOnlyConfirmOpen ? (
          <ReviewOverlayShell
            title="שמור כמסמך עזר?"
            onClose={() => setDocumentOnlyConfirmOpen(false)}
          >
            <p style={confirmTextStyle}>
              המסמך יישמר ללא רישום כספי. אפשר יהיה למצוא אותו ברשומות.
            </p>
            <div style={confirmActionGridStyle}>
              <button
                type="button"
                disabled={loading}
                style={reviewConfirmSecondaryStyle}
                onClick={() => setDocumentOnlyConfirmOpen(false)}
              >
                ביטול
              </button>
              <button
                type="button"
                disabled={loading}
                style={reviewConfirmPrimaryStyle(loading)}
                onClick={() => {
                  setDocumentOnlyConfirmOpen(false);
                  void approveDocumentOnly();
                }}
              >
                שמור כמסמך עזר
              </button>
            </div>
          </ReviewOverlayShell>
        ) : null}
      </main>
      <style jsx global>{`
        @media (max-width: 640px) {
          .documents-review-overlay {
            align-items: flex-end !important;
            padding: 0 !important;
          }

          .documents-review-dialog {
            width: 100% !important;
            max-width: none !important;
            border-radius: 22px 22px 0 0 !important;
            max-height: 86vh !important;
          }
        }
      `}</style>
    </div>
  );
}

function ReviewOverlayShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="documents-review-overlay" style={reviewOverlayStyle}>
      <section className="documents-review-dialog" role="dialog" aria-modal="true" style={reviewDialogStyle}>
        <div style={reviewDialogHeaderStyle}>
          <div style={reviewDialogTitleStyle}>{title}</div>
          <button type="button" aria-label="סגור" onClick={onClose} style={reviewDialogCloseStyle}>
            ×
          </button>
        </div>
        {children}
      </section>
    </div>,
    document.body
  );
}

function BackChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const reviewTopBarStyle = {
  marginTop: 18,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: "14px 16px",
  display: "grid",
  gridTemplateColumns: "minmax(120px, auto) minmax(0, 1fr) auto",
  gap: 14,
  alignItems: "center",
} as const;

const reviewBackButtonStyle = {
  width: 40,
  height: 40,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.button,
  background: TOKEN.surface.card,
  color: TOKEN.brand.mid,
  fontSize: 0,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
} as const;

const reviewTopTitleWrapStyle = {
  minWidth: 0,
  textAlign: "right",
} as const;

const reviewTopTitleStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
} as const;

const reviewTopMetaStyle = {
  marginTop: 4,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
} as const;

const reviewTopStatusStyle = {
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.surface.inset,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  color: TOKEN.ink.secondary,
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 600,
} as const;

const reviewOverlayStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 2147483000,
  background: "rgba(70, 50, 30, 0.28)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
} as const;

const reviewDialogStyle = {
  width: "min(560px, 100%)",
  maxHeight: "82vh",
  overflow: "auto",
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.modal,
  background: TOKEN.surface.overlay,
  padding: 20,
  boxShadow: TOKEN.shadow.floating,
} as const;

const reviewDialogHeaderStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 14,
} as const;

const reviewDialogTitleStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.display,
  fontWeight: TOKEN.weight.bold,
} as const;

const reviewDialogCloseStyle = {
  width: 40,
  height: 40,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.button,
  background: TOKEN.surface.card,
  color: TOKEN.ink.muted,
  fontSize: 24,
  lineHeight: 1,
  cursor: "pointer",
} as const;

const confirmTextStyle = {
  margin: 0,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
  lineHeight: 1.6,
} as const;

const confirmActionGridStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
  marginTop: 18,
} as const;

const reviewConfirmSecondaryStyle = {
  minHeight: 50,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.button,
  background: TOKEN.surface.card,
  color: TOKEN.brand.mid,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
} as const;

const reviewConfirmPrimaryStyle = (loading: boolean) =>
  ({
    minHeight: 50,
    border: "none",
    borderRadius: TOKEN.radius.button,
    background: loading ? TOKEN.ink.disabled : TOKEN.brand.gradient,
    color: TOKEN.ink.inverse,
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.bold,
    cursor: loading ? "not-allowed" : "pointer",
  }) as const;
