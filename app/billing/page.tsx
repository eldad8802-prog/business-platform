"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import BackButton from "@/components/ui/back-button";
import { parseBillingPdfTemplateStyle } from "@/lib/billing/billing-pdf-template-style";
import { BillingIdentityBanner } from "@/components/billing/BillingIdentityBanner";
import {
  BusinessIdentitySetupForm,
  emptyInvoiceIdentityForm,
  type InvoiceProfileFormState,
} from "@/components/billing/BusinessIdentitySetupForm";
import { TOKEN } from "@/lib/design/billing-theme";
import { chipActionStyle, glassActionStyle, primaryActionStyle } from "@/lib/design/billing-theme";

type BillingStatus = "DRAFT" | "PENDING_REVIEW" | "ISSUED";

type BillingDocumentListItem = {
  id: number;
  documentType: string;
  status: BillingStatus;
  documentNumber: number | null;
  documentNumberFormatted: string | null;
  customerId: number | null;
  customerNameSnapshot: string | null;
  totalAmount: string;
  currency: string;
  issuedAt: string | null;
  createdAt: string;
  updatedAt: string;
  pdfRenderStatus?: string | null;
  convertedToInvoiceId?: number | null;
};

type DocumentTotals = {
  all: number;
  invoices: number;
  quotes: number;
  drafts: number;
  issued: number;
};

type FilterView = "ALL" | BillingStatus | "QUOTE_TYPE";

const FILTER_OPTIONS: { value: FilterView; label: string }[] = [
  { value: "ALL", label: "הכל" },
  { value: "DRAFT", label: "טיוטה" },
  { value: "ISSUED", label: "הופק" },
  { value: "QUOTE_TYPE", label: "הצעות מחיר" },
  { value: "PENDING_REVIEW", label: "ממתין לאישור" },
];

const STATUS_STYLE: Record<
  BillingStatus | "QUOTE",
  { bg: string; fg: string; border: string }
> = {
  DRAFT: { bg: TOKEN.semantic.info.bg, fg: TOKEN.semantic.info.ink, border: TOKEN.semantic.info.border },
  PENDING_REVIEW: { bg: TOKEN.semantic.attention.bg, fg: TOKEN.semantic.attention.ink, border: TOKEN.semantic.attention.border },
  ISSUED: { bg: TOKEN.semantic.success.bg, fg: TOKEN.semantic.success.ink, border: TOKEN.semantic.success.border },
  QUOTE: { bg: TOKEN.semantic.info.bg, fg: TOKEN.semantic.info.ink, border: TOKEN.semantic.info.border },
};

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  TAX_INVOICE: "חשבונית מס",
  QUOTE: "הצעת מחיר",
};

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: currency || "ILS",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}

function getDisplayNumber(doc: BillingDocumentListItem): string {
  return doc.documentNumberFormatted ?? "טיוטה ללא מספר";
}

function getDisplayDate(doc: BillingDocumentListItem): string {
  return formatDate(doc.issuedAt ?? doc.createdAt);
}

export default function BillingHubPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterView>("ALL");
  const [docs, setDocs] = useState<BillingDocumentListItem[]>([]);
  const [totals, setTotals] = useState<DocumentTotals | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [createDocumentType, setCreateDocumentType] = useState<
    "TAX_INVOICE" | "QUOTE"
  >("TAX_INVOICE");
  const [identityGateOpen, setIdentityGateOpen] = useState(false);
  const [billingIdentityOk, setBillingIdentityOk] = useState<
    boolean | undefined
  >(undefined);
  const [gateForm, setGateForm] = useState<InvoiceProfileFormState>(
    emptyInvoiceIdentityForm
  );
  const [gateSaving, setGateSaving] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [pendingCreateType, setPendingCreateType] = useState<
    "TAX_INVOICE" | "QUOTE"
  >("TAX_INVOICE");
  const [searchInput, setSearchInput] = useState<string>("");
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");
  const [visibleDocsCount, setVisibleDocsCount] = useState<number>(5);

  useEffect(() => {
    const t = window.setTimeout(
      () => setDebouncedSearch(searchInput.trim()),
      380
    );
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNextCursor(null);

    try {
      const token = getAuthToken();
      const params = new URLSearchParams({ limit: "40" });
      if (filter === "QUOTE_TYPE") {
        params.set("documentType", "QUOTE");
      } else if (filter !== "ALL") {
        params.set("status", filter);
      }
      if (debouncedSearch.length > 0) {
        params.set("search", debouncedSearch);
      }

      const res = await fetch(`/api/billing/documents?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (!res.ok) {
        let message = "אירעה שגיאה בטעינת המסמכים";
        try {
          const data = await res.json();
          if (data && typeof data.error === "string") {
            message = data.error;
          }
        } catch {
        }
        throw new Error(message);
      }

      const data = await res.json();
      const list: BillingDocumentListItem[] = Array.isArray(data?.documents)
        ? data.documents
        : [];
      setDocs(list);
      const nc = data?.nextCursor;
      setNextCursor(typeof nc === "number" ? nc : null);
      if (data?.totals && typeof data.totals.all === "number") {
        setTotals(data.totals as DocumentTotals);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "אירעה שגיאה בטעינת המסמכים"
      );
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, [filter, debouncedSearch]);

  const loadMore = useCallback(async () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const token = getAuthToken();
      const params = new URLSearchParams({
        limit: "40",
        cursor: String(nextCursor),
      });
      if (filter === "QUOTE_TYPE") {
        params.set("documentType", "QUOTE");
      } else if (filter !== "ALL") {
        params.set("status", filter);
      }
      if (debouncedSearch.length > 0) {
        params.set("search", debouncedSearch);
      }

      const res = await fetch(`/api/billing/documents?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (!res.ok) return;

      const data = await res.json();
      const list: BillingDocumentListItem[] = Array.isArray(data?.documents)
        ? data.documents
        : [];
      setDocs((prev) => [...prev, ...list]);
      const nc = data?.nextCursor;
      setNextCursor(typeof nc === "number" ? nc : null);
    } finally {
      setLoadingMore(false);
    }
  }, [filter, debouncedSearch, nextCursor, loadingMore]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadInitial(), 0);
    return () => window.clearTimeout(t);
  }, [loadInitial]);

  useEffect(() => {
    const t = window.setTimeout(() => setVisibleDocsCount(5), 0);
    return () => window.clearTimeout(t);
  }, [filter, debouncedSearch]);

  useEffect(() => {
    if (!identityGateOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const token = getAuthToken();
        const res = await fetch("/api/billing/invoice-profile", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const p = data?.profile ?? {};
        if (cancelled) return;
        setGateForm({
          billingLegalName: p.billingLegalName ?? null,
          billingBusinessKind: p.billingBusinessKind ?? null,
          billingTaxId: p.billingTaxId ?? null,
          billingPhone: p.billingPhone ?? null,
          billingEmail: p.billingEmail ?? null,
          billingAddress: p.billingAddress ?? null,
          billingPdfTemplateStyle: parseBillingPdfTemplateStyle(
            typeof p.billingPdfTemplateStyle === "string"
              ? p.billingPdfTemplateStyle
              : undefined
          ),
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identityGateOpen]);

  function openCreateFlow(type: "TAX_INVOICE" | "QUOTE") {
    if (billingIdentityOk === false) {
      setPendingCreateType(type);
      setGateError(null);
      setIdentityGateOpen(true);
      return;
    }
    setCreateDocumentType(type);
    setCreateOpen(true);
  }

  const latestDraft = docs.find((doc) => doc.status === "DRAFT") ?? null;
  const visibleDocs = docs.slice(0, visibleDocsCount);
  const hasMoreVisibleDocs =
    visibleDocsCount < docs.length || nextCursor !== null;

  async function handleShowMoreDocuments() {
    if (visibleDocsCount < docs.length) {
      setVisibleDocsCount((prev) => prev + 5);
      return;
    }
    if (nextCursor !== null) {
      await loadMore();
      setVisibleDocsCount((prev) => prev + 5);
    }
  }

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.card }}>
      <header
        className="billing-hub-header"
        style={{
          background: TOKEN.surface.card,
          borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
          minHeight: 64,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 16,
          padding: "0 26px",
          boxSizing: "border-box",
        }}
      >
        <BackButton href="/tools" />
      </header>

      <main
        className="billing-hub-main"
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: "30px 26px",
          paddingBottom: 80,
          display: "flex",
          flexDirection: "column",
          gap: 18,
          boxSizing: "border-box",
          direction: "rtl",
        }}
      >
        {/* ─── Document workspace actions ─── */}
        <section
          className="billing-actions-section"
          style={{
            display: "grid",
            gap: 18,
            padding: "6px 0 18px",
            borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 600, color: TOKEN.ink.primary }}>
              מה עושים עכשיו?!
            </div>
            <div style={{ fontSize: 13, color: TOKEN.ink.muted, marginTop: 4 }}>
              צרו מסמך חדש או המשיכו עבודה קיימת מול לקוח.
            </div>
          </div>

          <div
            className="billing-action-buttons"
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
            }}
          >
            <button
              className="billing-action-button"
              type="button"
              onClick={() => openCreateFlow("TAX_INVOICE")}
              style={{
                ...primaryActionStyle({ height: 48 }),
                padding: "12px 18px",
                fontSize: 14,
                fontWeight: 600,
                whiteSpace: "nowrap",
                minHeight: 48,
                flex: "0 1 264px",
              }}
            >
              + צור חשבונית
            </button>
            <button
              className="billing-action-button"
              type="button"
              onClick={() => openCreateFlow("QUOTE")}
              style={{
                ...glassActionStyle({ height: 48 }),
                padding: "12px 18px",
                fontSize: 14,
                fontWeight: 600,
                whiteSpace: "nowrap",
                minHeight: 48,
                flex: "0 1 264px",
              }}
            >
              + צור הצעת מחיר
            </button>
          </div>
        </section>

        {latestDraft ? (
          <section style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: TOKEN.ink.primary }}>
              המשך עבודה
            </div>
            <ContinueDraftCard doc={latestDraft} />
          </section>
        ) : null}

        {billingIdentityOk !== true ? (
          <BillingIdentityBanner onIdentityResolved={setBillingIdentityOk} />
        ) : null}

        <section className="billing-utility-section" style={{ display: "grid", gap: 10 }}>
          <div
            className="billing-utility-row"
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "flex-start",
            }}
          >
            {billingIdentityOk === true ? (
              <details
                className="billing-utility-details"
                style={{
                  background: TOKEN.surface.card,
                  border: `1px solid ${TOKEN.border.DEFAULT}`,
                  borderRadius: 12,
                  padding: "8px 12px",
                  flex: "1 1 230px",
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    color: TOKEN.ink.muted,
                  }}
                >
                  פרטי העסק במסמכים
                </summary>
                <div style={{ marginTop: 10 }}>
                  <BillingIdentityBanner onIdentityResolved={setBillingIdentityOk} />
                </div>
              </details>
            ) : null}

            {totals !== null ? (
              <details
                className="billing-utility-details"
                style={{
                  background: TOKEN.surface.card,
                  border: `1px solid ${TOKEN.border.DEFAULT}`,
                  borderRadius: 12,
                  padding: "8px 12px",
                  flex: "1 1 230px",
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    color: TOKEN.ink.muted,
                  }}
                >
                  סקירה קצרה
                </summary>
                <section
                  style={{
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                    marginTop: 10,
                  }}
                  aria-label="סיכום מסמכים"
                >
                  <SummaryPill label="סה״כ" count={totals.all} />
                  <SummaryPill label="חשבוניות" count={totals.invoices} />
                  <SummaryPill label="הצעות מחיר" count={totals.quotes} />
                  <SummaryPill label="טיוטות" count={totals.drafts} />
                  <SummaryPill label="הופקו" count={totals.issued} />
                </section>
              </details>
            ) : null}
          </div>

          <section
            className="billing-search-panel"
            style={{
              display: "grid",
              gap: 10,
              background: TOKEN.surface.card,
              border: `1px solid ${TOKEN.border.DEFAULT}`,
              borderRadius: 12,
              padding: 12,
            }}
            role="region"
            aria-label="חיפוש וסינון מסמכים"
          >
            <div style={{ position: "relative" }}>
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  insetInlineStart: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: 15,
                  pointerEvents: "none",
                  color: TOKEN.ink.meta,
                  lineHeight: 1,
                }}
              >
                🔍
              </span>
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="חיפוש לפי לקוח או מספר מסמך..."
                style={{
                  paddingInlineStart: 34,
                  paddingInlineEnd: 12,
                  paddingTop: 10,
                  paddingBottom: 10,
                  borderRadius: 10,
                  border: `1px solid ${TOKEN.border.DEFAULT}`,
                  fontSize: 14,
                  width: "100%",
                  boxSizing: "border-box",
                  minHeight: 44,
                }}
              />
            </div>
            <div
              style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
              role="tablist"
              aria-label="סינון לפי סטטוס"
            >
              {FILTER_OPTIONS.map((opt) => {
                const active = filter === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(opt.value)}
                    style={{
                      ...chipActionStyle(active),
                      padding: "7px 14px",
                      fontSize: 13,
                      fontWeight: active ? 600 : 500,
                      minHeight: 36,
                      lineHeight: 1,
                      whiteSpace: "nowrap",
                      transition: "background 140ms ease, border-color 140ms ease",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </section>
        </section>

        {loading ? (
          <DocumentsSkeleton />
        ) : error ? (
          <ErrorBanner message={error} onRetry={() => void loadInitial()} />
        ) : docs.length === 0 ? (
          <EmptyState
            filter={filter}
            onClearFilter={() => {
              setFilter("ALL");
              setSearchInput("");
            }}
            onCreate={() => openCreateFlow("TAX_INVOICE")}
          />
        ) : (
          <section
            className="billing-archive"
            style={{
              background: TOKEN.surface.card,
              border: `1px solid ${TOKEN.border.DEFAULT}`,
              borderRadius: 8,
              overflowX: "hidden",
              overflowY: "hidden",
            }}
            aria-label="ארכיון מסמכים"
          >
            <div
              className="billing-archive-title-row"
              style={{
                padding: "11px 14px",
                borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "baseline",
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 600, color: TOKEN.ink.primary }}>
                מסמכים אחרונים ({Math.min(visibleDocsCount, docs.length)} מתוך {docs.length})
              </div>
              <div style={{ fontSize: 12, color: TOKEN.ink.meta }}>
                ארכיון מסמכים
              </div>
            </div>
            <div
              className="billing-archive-columns"
              aria-hidden="true"
              style={{
                display: "grid",
                gridTemplateColumns:
                  "112px 100px 132px minmax(170px, 1fr) 128px 132px 96px",
                gap: 12,
                alignItems: "center",
                padding: "9px 14px",
                borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
                background: TOKEN.surface.card,
                color: TOKEN.ink.secondary,
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <span>תאריך</span>
              <span>מספר</span>
              <span>סוג</span>
              <span>לקוח</span>
              <span>סכום</span>
              <span>סטטוס</span>
              <span>פתיחה</span>
            </div>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
              }}
            >
              {visibleDocs.map((d, index) => (
                <DocumentCard
                  key={d.id}
                  doc={d}
                  hasDivider={index < visibleDocs.length - 1}
                />
              ))}
            </ul>
            {hasMoreVisibleDocs ? (
              <div style={{ padding: 10, borderTop: `1px solid ${TOKEN.border.DEFAULT}` }}>
                <button
                  className="billing-load-more-button"
                  type="button"
                  onClick={() => void handleShowMoreDocuments()}
                  disabled={loadingMore}
                  style={{
                    ...glassActionStyle({ disabled: loadingMore, fullWidth: true, height: 44 }),
                    width: "100%",
                    padding: "11px 16px",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: loadingMore ? "wait" : "pointer",
                  }}
                >
                  {loadingMore ? "טוען…" : "טען עוד"}
                </button>
              </div>
            ) : null}
          </section>
        )}

      </main>

      <style jsx global>{`
        .billing-action-button:focus-visible,
        .billing-load-more-button:focus-visible,
        .billing-hub-header button:focus-visible,
        .billing-doc-row:focus-visible,
        .billing-active-record:focus-visible {
          outline: 3px solid ${TOKEN.brand.focus};
          outline-offset: 2px;
        }

        @media (max-width: 980px) {
          .billing-hub-header {
            min-height: 56px !important;
            padding: 0 14px !important;
          }

          .billing-hub-main {
            padding: 18px 14px 72px !important;
            gap: 14px !important;
          }

          .billing-actions-section {
            gap: 14px !important;
            padding: 2px 0 16px !important;
          }

          .billing-action-buttons {
            flex-direction: column !important;
            align-items: stretch !important;
          }

          .billing-action-button {
            width: 100% !important;
            flex: 1 1 auto !important;
            min-height: 48px !important;
          }

          .billing-utility-row {
            flex-direction: column !important;
          }

          .billing-utility-details {
            width: 100% !important;
            flex: 1 1 auto !important;
            box-sizing: border-box !important;
          }

          .billing-search-panel {
            padding: 10px !important;
          }

          .billing-archive {
            overflow-x: visible !important;
            border-radius: 12px !important;
          }

          .billing-archive-title-row {
            align-items: flex-start !important;
            flex-direction: column !important;
            gap: 4px !important;
          }

          .billing-archive-columns {
            display: none !important;
          }

          .billing-doc-row {
            min-width: 0 !important;
            grid-template-columns: minmax(0, 1fr) auto !important;
            gap: 10px 12px !important;
            min-height: 0 !important;
            padding: 14px !important;
            align-items: start !important;
          }

          .billing-doc-row > div:nth-child(1) {
            order: 4;
            grid-column: 1;
          }

          .billing-doc-row > div:nth-child(2) {
            order: 2;
            grid-column: 1;
          }

          .billing-doc-row > div:nth-child(3) {
            order: 3;
            grid-column: 1;
          }

          .billing-doc-row > div:nth-child(4) {
            order: 1;
            grid-column: 1;
          }

          .billing-doc-row > div:nth-child(5) {
            order: 1;
            grid-column: 2;
            text-align: left;
          }

          .billing-doc-row > div:nth-child(6) {
            order: 2;
            grid-column: 2;
            justify-self: end;
          }

          .billing-doc-row > div:nth-child(7) {
            order: 5;
            grid-column: 1 / -1;
            justify-self: stretch;
            padding-top: 10px;
            border-top: 1px solid ${TOKEN.border.DEFAULT};
            text-align: center;
          }

          .billing-active-record {
            grid-template-columns: 4px minmax(0, 1fr) !important;
          }

          .billing-active-record-amount {
            grid-column: 2 !important;
            border-right: 0 !important;
            border-top: 1px solid ${TOKEN.border.DEFAULT} !important;
            padding: 12px 18px !important;
            justify-items: start !important;
          }
        }
      `}</style>

      {identityGateOpen ? (
        <IdentityGateModal
          form={gateForm}
          onFormChange={setGateForm}
          saving={gateSaving}
          error={gateError}
          onClose={() => {
            if (gateSaving) return;
            setIdentityGateOpen(false);
          }}
          onSaved={async () => {
            setGateSaving(true);
            setGateError(null);
            try {
              const token = getAuthToken();
              const res = await fetch("/api/billing/invoice-profile", {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(gateForm),
              });
              if (!res.ok) {
                let msg = "שמירה נכשלה";
                try {
                  const j = await res.json();
                  if (j?.error) msg = j.error;
                } catch {}
                setGateError(msg);
                return;
              }
              const data = await res.json();
              const ok = !!data?.identityComplete;
              setBillingIdentityOk(ok);
              if (ok) {
                // Identity complete: close the gate and open the create flow.
                setIdentityGateOpen(false);
                setCreateDocumentType(pendingCreateType);
                setCreateOpen(true);
              } else {
                // Incomplete: keep the gate OPEN so the error is visible and the
                // user can finish. Do NOT clear pendingCreateType.
                setGateError(
                  'חסרים עדיין שדות חובה לזהות העסק. ודאו שמולאו: שם העסק, סוג עסק, ע.מ./ח.פ., כתובת, טלפון ודוא"ל.'
                );
              }
            } catch {
              setGateError("לא הצלחנו להתחבר כדי לשמור. נסו שוב בעוד רגע.");
            } finally {
              setGateSaving(false);
            }
          }}
        />
      ) : null}

      {createOpen ? (
        <CreateDraftModal
          documentType={createDocumentType}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            router.push(`/billing/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function IdentityGateModal({
  form,
  onFormChange,
  saving,
  error,
  onClose,
  onSaved,
}: {
  form: InvoiceProfileFormState;
  onFormChange: (v: InvoiceProfileFormState) => void;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="identity-gate-title"
      onClick={() => {
        if (!saving) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(70, 50, 30, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 120,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 440,
          maxHeight: "calc(100dvh - 32px)",
          overflowY: "auto",
          background: TOKEN.surface.card,
          borderRadius: 16,
          padding: 20,
          boxShadow: TOKEN.shadow.floating,
        }}
      >
        <h2
          id="identity-gate-title"
          style={{
            margin: "0 0 8px",
            fontSize: 17,
            fontWeight: 600,
            color: TOKEN.ink.primary,
          }}
        >
          הגדרת זהות העסק
        </h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: TOKEN.ink.secondary }}>
          צריך רק להשלים את פרטי העסק שיופיעו במסמך הראשון.
        </p>
        <BusinessIdentitySetupForm form={form} onChange={onFormChange} />
        {error ? (
          <div
            role="alert"
            style={{
              marginTop: 12,
              background: TOKEN.semantic.urgent.bg,
              color: TOKEN.semantic.urgent.ink,
              padding: "8px 10px",
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            style={{
              ...glassActionStyle({ disabled: saving, height: 40 }),
              padding: "9px 14px",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            ביטול
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void onSaved()}
            style={{
              ...primaryActionStyle({ disabled: saving, height: 42 }),
              padding: "9px 16px",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {saving ? "שומר…" : "שמור והמשך"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateDraftModal({
  documentType,
  onClose,
  onCreated,
}: {
  documentType: "TAX_INVOICE" | "QUOTE";
  onClose: () => void;
  onCreated: (documentId: number) => void;
}) {
  const [name, setName] = useState<string>("");
  const [pickedCustomerId, setPickedCustomerId] = useState<number | null>(
    null
  );
  const [customers, setCustomers] = useState<
    { id: number; name: string; phone: string | null }[]
  >([]);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = getAuthToken();
        const res = await fetch("/api/billing/customers?limit=50", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const list = Array.isArray(data?.customers) ? data.customers : [];
        if (!cancelled) {
          setCustomers(
            list.map((c: { id: number; name: string; phone: string | null }) => ({
              id: c.id,
              name: c.name,
              phone: c.phone ?? null,
            }))
          );
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = name.trim();
  const canSubmit =
    !submitting && (pickedCustomerId !== null || trimmed.length > 0);

  const isQuote = documentType === "QUOTE";

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMsg(null);

    try {
      const token = getAuthToken();
      const payload: Record<string, unknown> = {
        documentType,
      };
      if (pickedCustomerId !== null) {
        payload.customerId = pickedCustomerId;
      } else {
        payload.customerNameSnapshot = trimmed;
      }

      const res = await fetch("/api/billing/documents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let message = "אירעה שגיאה ביצירת הטיוטה";
        try {
          const data = await res.json();
          if (data && typeof data.error === "string") {
            message = data.error;
          }
        } catch {
        }
        setErrorMsg(message);
        setSubmitting(false);
        return;
      }

      const data = await res.json();
      const id: unknown = data?.document?.id;
      if (typeof id !== "number") {
        setErrorMsg("התקבלה תגובה לא תקינה");
        setSubmitting(false);
        return;
      }

      onCreated(id);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "אירעה שגיאה ביצירת הטיוטה"
      );
      setSubmitting(false);
    }
  }

  function handleClose() {
    if (submitting) return;
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isQuote ? "יצירת הצעת מחיר" : "יצירת טיוטת חשבונית"}
      onClick={handleClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(70, 50, 30, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 130,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 480,
          maxHeight: "calc(100dvh - 32px)",
          overflowY: "auto",
          background: TOKEN.surface.card,
          borderRadius: 18,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: TOKEN.shadow.floating,
        }}
      >
        <section
          style={{
            background: isQuote ? TOKEN.surface.inset : TOKEN.semantic.success.bg,
            border: isQuote ? `1px solid ${TOKEN.border.DEFAULT}` : `1px solid ${TOKEN.semantic.success.border}`,
            borderRadius: 16,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <h2
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: isQuote ? TOKEN.ink.primary : TOKEN.semantic.success.ink,
              margin: 0,
            }}
          >
            {isQuote ? "הצעת מחיר חדשה" : "יצירת טיוטת חשבונית"}
          </h2>
          <p
            style={{
              fontSize: 13,
              color: TOKEN.ink.secondary,
              margin: 0,
              lineHeight: 1.55,
            }}
          >
            בחרו למי המסמך מיועד. אחר כך נוסיף את מה שסוכם עם הלקוח ונבדוק את
            הסיכום לפני שליחה.
          </p>
          <div
            style={{
              marginTop: 6,
              paddingTop: 10,
              borderTop: isQuote
                ? `1px solid ${TOKEN.border.DEFAULT}`
                : `1px solid ${TOKEN.semantic.success.border}`,
              fontSize: 12,
              color: isQuote ? TOKEN.ink.secondary : TOKEN.semantic.success.ink,
              lineHeight: 1.5,
              fontWeight: 600,
            }}
          >
            {isQuote
              ? "הצעה היא מסמך עסקי לשיתוף עם הלקוח. כשיש הסכמה, אפשר להפוך אותה לחשבונית."
              : "אחרי היצירה תועבר לטיוטה, שם בודקים את הפריטים ומפיקים חשבונית רשמית."}
          </div>
        </section>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: TOKEN.ink.secondary,
            }}
          >
            לקוח קיים
          </span>
          <select
            value={pickedCustomerId ?? ""}
            disabled={submitting}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                setPickedCustomerId(null);
                return;
              }
              const id = Number(v);
              setPickedCustomerId(Number.isFinite(id) ? id : null);
              const c = customers.find((x) => x.id === id);
              if (c) setName(c.name);
            }}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${TOKEN.border.hover}`,
              fontSize: 14,
              width: "100%",
              boxSizing: "border-box",
            }}
          >
            <option value="">— ללא בחירה —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.phone ? ` · ${c.phone}` : ""}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: TOKEN.ink.secondary,
            }}
          >
            או שם לקוח חדש
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setPickedCustomerId(null);
              setName(e.target.value);
            }}
            disabled={submitting}
            autoFocus
            placeholder='לדוגמה: חברה לדוגמה בע"מ'
            maxLength={200}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${TOKEN.border.hover}`,
              background: submitting ? TOKEN.surface.inset : TOKEN.surface.card,
              fontSize: 14,
              color: TOKEN.ink.primary,
              outline: "none",
              width: "100%",
              boxSizing: "border-box",
            }}
          />
          <span style={{ fontSize: 12, color: TOKEN.ink.muted, lineHeight: 1.5 }}>
            השם יופיע במסמך כפי שייכתב כאן.
          </span>
        </label>

        {errorMsg ? (
          <div
            role="alert"
            style={{
              background: TOKEN.semantic.urgent.bg,
              border: `1px solid ${TOKEN.semantic.urgent.border}`,
              color: TOKEN.semantic.urgent.ink,
              borderRadius: 10,
              padding: "8px 12px",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {errorMsg}
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            flexWrap: "wrap",
            marginTop: 4,
          }}
        >
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            style={{
              ...glassActionStyle({ disabled: submitting, height: 42 }),
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: 600,
              opacity: submitting ? 0.55 : 1,
              minWidth: 110,
            }}
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            aria-busy={submitting}
            style={{
              ...primaryActionStyle({ disabled: !canSubmit, height: 42 }),
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: 600,
              minWidth: 130,
            }}
          >
            {submitting ? "יוצר טיוטה..." : "התחל מסמך"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryPill({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 10px",
        borderRadius: 999,
        background: TOKEN.surface.inset,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        fontSize: 12,
        color: TOKEN.ink.secondary,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color: TOKEN.ink.meta, fontWeight: 400 }}>{label}</span>
      <span style={{ fontWeight: 600, color: TOKEN.ink.primary }}>{count}</span>
    </div>
  );
}

function DocumentsSkeleton() {
  return (
    <ul
      style={{
        listStyle: "none",
        padding: 0,
        margin: 0,
        display: "grid",
        gap: 10,
      }}
      aria-busy="true"
      aria-live="polite"
    >
      {[0, 1, 2, 3].map((i) => (
        <li
          key={i}
          aria-hidden="true"
          style={{
            height: 88,
            borderRadius: 14,
            background: `linear-gradient(90deg, ${TOKEN.surface.inset} 0%, ${TOKEN.border.DEFAULT} 50%, ${TOKEN.surface.inset} 100%)`,
            backgroundSize: "200% 100%",
            animation: "billing-skeleton 1.2s ease-in-out infinite",
            border: `1px solid ${TOKEN.border.DEFAULT}`,
          }}
        />
      ))}
      <style>{`
        @keyframes billing-skeleton {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </ul>
  );
}

function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        background: TOKEN.semantic.urgent.bg,
        border: `1px solid ${TOKEN.semantic.urgent.border}`,
        color: TOKEN.semantic.urgent.ink,
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 15 }}>שגיאה בטעינת המסמכים</div>
      <div style={{ fontSize: 14, lineHeight: 1.5 }}>{message}</div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          ...primaryActionStyle({ height: 40 }),
          alignSelf: "flex-start",
          padding: "8px 14px",
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        נסה שוב
      </button>
    </div>
  );
}

function EmptyState({
  filter,
  onClearFilter,
  onCreate,
}: {
  filter: FilterView;
  onClearFilter: () => void;
  onCreate: () => void;
}) {
  const filterLabel = FILTER_OPTIONS.find((o) => o.value === filter)?.label;
  const subtitle =
    filter === "ALL"
      ? "התחילו במסמך ראשון ללקוח. אפשר ליצור חשבונית או הצעה ולהמשיך משם."
      : `אין כרגע מסמכים בסטטוס ״${filterLabel ?? ""}״.`;

  return (
    <div
      style={{
        background: TOKEN.surface.card,
        border: `1px dashed ${TOKEN.border.hover}`,
        borderRadius: 14,
        padding: "32px 16px",
        textAlign: "center",
        color: TOKEN.ink.secondary,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
        אין עדיין מסמכים להצגה
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.5 }}>{subtitle}</div>
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 8,
          flexWrap: "wrap",
          marginTop: 16,
        }}
      >
        {filter === "ALL" ? (
          <button
            type="button"
            onClick={onCreate}
            style={{
              ...primaryActionStyle({ height: 42 }),
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            התחל מסמך ללקוח
          </button>
        ) : (
          <button
            type="button"
            onClick={onClearFilter}
            style={{
              ...glassActionStyle({ height: 42 }),
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            נקה סינון
          </button>
        )}
      </div>
    </div>
  );
}

function ContinueDraftCard({ doc }: { doc: BillingDocumentListItem }) {
  const customer = doc.customerNameSnapshot ?? "לקוח לא הוגדר";
  const money = formatMoney(doc.totalAmount, doc.currency);
  const typeLabel = DOCUMENT_TYPE_LABEL[doc.documentType] ?? "מסמך";
  const number = getDisplayNumber(doc);

  return (
    <Link
      className="billing-active-record"
      href={`/billing/${doc.id}`}
      style={{
        display: "grid",
        gridTemplateColumns: "4px minmax(0, 1fr) minmax(150px, 190px)",
        gap: 0,
        border: `1px solid ${TOKEN.semantic.info.border}`,
        background: TOKEN.surface.card,
        borderRadius: 6,
        overflow: "hidden",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ background: TOKEN.semantic.info.ink }} aria-hidden="true" />
      <div className="billing-active-record-main" style={{ display: "grid", gap: 10, padding: "16px 18px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "baseline",
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: TOKEN.semantic.info.ink }}>
              טיוטה
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, color: TOKEN.ink.primary, marginTop: 4 }}>
              {typeLabel} # {number}
            </div>
            <div style={{ fontSize: 12, color: TOKEN.ink.muted, marginTop: 3 }}>
              לקוח: {customer}
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
            borderTop: `1px solid ${TOKEN.border.DEFAULT}`,
            paddingTop: 8,
          }}
        >
          <div style={{ fontSize: 12, color: TOKEN.ink.meta }}>
            עודכן לאחרונה לפי רשומת המסמך
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: TOKEN.semantic.info.ink }}>
            פתח והמשך
          </div>
        </div>
      </div>
      <div
        className="billing-active-record-amount"
        style={{
          borderRight: `1px solid ${TOKEN.border.DEFAULT}`,
          padding: "18px 20px",
          display: "grid",
          alignContent: "center",
          justifyItems: "start",
          gap: 5,
        }}
      >
        <div style={{ fontSize: 11, color: TOKEN.ink.muted, fontWeight: 600 }}>
          סכום
        </div>
        <div
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: TOKEN.ink.primary,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {money}
        </div>
      </div>
    </Link>
  );
}

function DocumentCard({
  doc,
  hasDivider = false,
}: {
  doc: BillingDocumentListItem;
  hasDivider?: boolean;
}) {
  const status = doc.status;
  const number = getDisplayNumber(doc);
  const customer = doc.customerNameSnapshot ?? "—";
  const date = getDisplayDate(doc);
  const money = formatMoney(doc.totalAmount, doc.currency);
  const pdfIssue = doc.status === "ISSUED" && doc.pdfRenderStatus === "FAILED";
  const isQuote = doc.documentType === "QUOTE";
  const isConverted = isQuote && (doc.convertedToInvoiceId ?? null) !== null;
  const typeLabel = DOCUMENT_TYPE_LABEL[doc.documentType] ?? doc.documentType;
  const statusTone = isQuote && status !== "PENDING_REVIEW" && !pdfIssue ? "QUOTE" : status;
  const statusStyle = STATUS_STYLE[statusTone];
  const lifecycleLabel = pdfIssue
    ? "דורש טיפול"
    : isQuote && status !== "PENDING_REVIEW"
    ? "הצעה"
    : status === "ISSUED"
    ? "הופק"
    : status === "PENDING_REVIEW"
    ? "ממתין לאישור"
    : "טיוטה";

  return (
    <li>
      <Link
        className="billing-doc-row"
        href={`/billing/${doc.id}`}
        style={{
          display: "grid",
          gridTemplateColumns:
            "112px 100px 132px minmax(170px, 1fr) 128px 132px 96px",
          gap: 12,
          alignItems: "center",
          minHeight: 58,
          padding: "0 14px",
          textDecoration: "none",
          color: "inherit",
          background: TOKEN.surface.card,
          borderBottom: hasDivider ? `1px solid ${TOKEN.border.DEFAULT}` : "none",
          boxShadow: "none",
          boxSizing: "border-box",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: TOKEN.ink.primary,
              fontSize: 12,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {date}
          </div>
          <div style={{ color: TOKEN.ink.meta, fontSize: 11, marginTop: 2 }}>
            {status === "ISSUED" ? "הופק" : status === "PENDING_REVIEW" ? "נשלח לאישור" : "עודכן"}
          </div>
        </div>

        <div
          style={{
            color: TOKEN.ink.primary,
            fontSize: 12,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {number}
        </div>

        <div
          style={{
            color: TOKEN.ink.secondary,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            whiteSpace: "nowrap",
          }}
        >
          <span aria-hidden="true" style={{ color: TOKEN.ink.muted }}>
            ◰
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {typeLabel}
          </span>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: TOKEN.ink.primary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {customer}
          </div>
          {isConverted || pdfIssue ? (
            <div style={{ fontSize: 11, color: pdfIssue ? TOKEN.semantic.urgent.ink : TOKEN.semantic.success.ink, marginTop: 2, fontWeight: 600 }}>
              {pdfIssue ? "צריך טיפול ב־PDF" : "הומרה לחשבונית"}
            </div>
          ) : null}
        </div>

        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: TOKEN.ink.primary,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {money}
        </div>

        <div>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 10px",
              borderRadius: 999,
              border: `1px solid ${statusStyle?.border ?? TOKEN.border.DEFAULT}`,
              background: statusStyle?.bg ?? TOKEN.surface.inset,
              color: statusStyle?.fg ?? TOKEN.ink.secondary,
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: statusStyle?.fg ?? TOKEN.ink.secondary,
              }}
            />
            {lifecycleLabel}
          </span>
        </div>

        <div
          style={{
            color: TOKEN.brand.mid,
            fontSize: 12,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          פתח מסמך
        </div>
      </Link>
    </li>
  );
}
