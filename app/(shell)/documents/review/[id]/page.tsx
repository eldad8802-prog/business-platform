"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { fetchDocumentsHubSummary } from "@/lib/documents/fetch-inbox";
import { alertError } from "../../ui";
import DocumentsReviewSkeleton from "@/components/documents/skeletons/DocumentsReviewSkeleton";
import ReviewHero from "@/components/documents/review/ReviewHero";
import ReviewDecisionPanel from "@/components/documents/review/ReviewDecisionPanel";
import ReviewSummarySection from "@/components/documents/review/ReviewSummarySection";
import ReviewFieldEditor from "@/components/documents/review/ReviewFieldEditor";
import ReviewDocumentPreview from "@/components/documents/review/ReviewDocumentPreview";
import ReviewDoneState from "@/components/documents/review/ReviewDoneState";
import ReviewNotFound from "@/components/documents/review/ReviewNotFound";
import { basePageStyle, mainStyle } from "@/components/documents/review/review-ui";
import { errorMessage } from "@/lib/documents/review/format";
import { buildExtractionMeta } from "@/lib/documents/review/meta";
import { getPreviewKind } from "@/lib/documents/review/preview";
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
  const [nextPendingDocumentId, setNextPendingDocumentId] = useState<number | null>(null);

  const [document, setDocument] = useState<ApiDocument | null>(null);
  const [outputProfile, setOutputProfile] = useState<OutputProfile | null>(null);
  const [extractionMeta, setExtractionMeta] = useState<ExtractionConfidenceMeta | null>(null);
  const [editReturnTarget, setEditReturnTarget] = useState<"decision" | "summary">("summary");

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

  const handleEditField = useCallback(
    (field: EditableField, returnTarget: "decision" | "summary") => {
      setEditReturnTarget(returnTarget);
      setEditField(field);
      setState("edit-field");
    },
    []
  );

  const handleSummaryEditField = useCallback((field: EditableField) => {
    setEditReturnTarget("summary");
    setEditField(field);
    setState("edit-field");
  }, []);

  const handleSummaryApproveFinancial = useCallback(() => {
    const missing = firstMissingFinancialField(draft);
    if (missing) {
      setEditReturnTarget("summary");
      setEditField(missing);
      setState("edit-field");
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
      void approveDocumentOnly();
      return;
    }

    const missing = firstMissingFinancialField(draft);
    if (missing) {
      setEditReturnTarget("decision");
      setEditField(missing);
      setState("edit-field");
      return;
    }
    void approveFinancial();
  }, [reviewMode, isUnknown, draft, approveDocumentOnly, approveFinancial]);

  if (pageLoading) {
    return <DocumentsReviewSkeleton />;
  }

  if (!document) {
    return <ReviewNotFound onBack={() => router.push("/documents")} />;
  }

  return (
    <div dir="rtl" style={basePageStyle()}>
      <main style={mainStyle()}>
        <ReviewHero state={state} />

        {error ? <div style={alertError}>{error}</div> : null}

        {state === "decision" ? (
          <ReviewDecisionPanel
            reviewMode={reviewMode}
            trustLevel={trustContext.trustLevel}
            onBack={() => router.push("/documents")}
            showPreviewFallback={showPreviewFallback}
            previewKind={previewKind}
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
              onApproveDocumentOnly: () => void approveDocumentOnly(),
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
            onApproveDocumentOnly={() => void approveDocumentOnly()}
          />
        ) : null}

        {state === "edit-field" ? (
          <ReviewFieldEditor
            editFieldTitle={editFieldTitle}
            editField={editField}
            draft={draft}
            loading={loading}
            onDraftChange={setDraft}
            onConfirm={() => setState(editReturnTarget)}
            onCancel={() => setState(editReturnTarget)}
          />
        ) : null}

        {state === "done" ? (
          <ReviewDoneState
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
          <ReviewDocumentPreview
            showPreviewFallback={showPreviewFallback}
            previewLoading={previewLoading}
            previewKind={previewKind}
            fileBlobUrl={fileBlobUrl}
            onPreviewFailed={() => setPreviewFailed(true)}
          />
        ) : null}
      </main>
    </div>
  );
}
