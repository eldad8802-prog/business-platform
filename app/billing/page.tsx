"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/ui/page-header";
import { parseBillingPdfTemplateStyle } from "@/lib/billing/billing-pdf-template-style";
import { BillingIdentityBanner } from "@/components/billing/BillingIdentityBanner";
import {
  BusinessIdentitySetupForm,
  emptyInvoiceIdentityForm,
  type InvoiceProfileFormState,
} from "@/components/billing/BusinessIdentitySetupForm";

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

const STATUS_LABEL: Record<BillingStatus, string> = {
  DRAFT: "טיוטה",
  PENDING_REVIEW: "ממתין לאישור",
  ISSUED: "הופק",
};

const STATUS_STYLE: Record<
  BillingStatus,
  { bg: string; fg: string; border: string }
> = {
  DRAFT: { bg: "#f1f5f9", fg: "#334155", border: "#e2e8f0" },
  PENDING_REVIEW: { bg: "#fef3c7", fg: "#92400e", border: "#fde68a" },
  ISSUED: { bg: "#dcfce7", fg: "#166534", border: "#bbf7d0" },
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
    void loadInitial();
  }, [loadInitial]);

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

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: "#f8fafc" }}>
      <PageHeader
        title="חשבוניות"
        backHref="/tools"
        backLabel="חזרה"
        showBack
      />

      <main
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: "16px",
          paddingBottom: 80,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          boxSizing: "border-box",
          direction: "rtl",
        }}
      >
        {/* ─── Operational header ─── */}
        <section
          style={{
            borderRadius: 20,
            padding: "14px 18px",
            background:
              "linear-gradient(135deg, #111827 0%, #1f2937 60%, #0f766e 100%)",
            color: "#ffffff",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, lineHeight: 1.2 }}>
            מסמכי חיוב
          </h1>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => {
                if (billingIdentityOk === false) {
                  setPendingCreateType("TAX_INVOICE");
                  setGateError(null);
                  setIdentityGateOpen(true);
                  return;
                }
                setCreateDocumentType("TAX_INVOICE");
                setCreateOpen(true);
              }}
              style={{
                padding: "9px 16px",
                borderRadius: 12,
                border: "none",
                background: "#ffffff",
                color: "#111827",
                fontSize: 14,
                fontWeight: 800,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              + חשבונית חדשה
            </button>
            <button
              type="button"
              onClick={() => {
                if (billingIdentityOk === false) {
                  setPendingCreateType("QUOTE");
                  setGateError(null);
                  setIdentityGateOpen(true);
                  return;
                }
                setCreateDocumentType("QUOTE");
                setCreateOpen(true);
              }}
              style={{
                padding: "9px 16px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.4)",
                background: "rgba(255,255,255,0.1)",
                color: "#ffffff",
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              + הצעת מחיר
            </button>
          </div>
        </section>

        {/* ─── Business identity (not editable inline when complete) ─── */}
        <BillingIdentityBanner onIdentityResolved={setBillingIdentityOk} />

        {/* ─── Summary strip ─── */}
        {totals !== null ? (
          <section
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              padding: "10px 14px",
              background: "#ffffff",
              border: "1px solid #e5e7eb",
              borderRadius: 16,
              boxShadow: "0 2px 8px rgba(15,23,42,0.04)",
            }}
            aria-label="סיכום מסמכים"
          >
            <SummaryPill label="סה״כ" count={totals.all} />
            <SummaryPill label="חשבוניות" count={totals.invoices} />
            <SummaryPill label="הצעות מחיר" count={totals.quotes} />
            <SummaryPill label="טיוטות" count={totals.drafts} />
            <SummaryPill label="הופקו" count={totals.issued} />
          </section>
        ) : null}

        {/* ─── Search + filter ─── */}
        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 20,
            background: "#ffffff",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            boxShadow: "0 2px 8px rgba(15,23,42,0.04)",
          }}
          role="region"
          aria-label="סינון וחיפוש"
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
                color: "#94a3b8",
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
                borderRadius: 12,
                border: "1px solid #e2e8f0",
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
                    padding: "7px 14px",
                    borderRadius: 999,
                    border: "1px solid",
                    borderColor: active ? "#111827" : "#e5e7eb",
                    background: active ? "#111827" : "#f9fafb",
                    color: active ? "#ffffff" : "#475569",
                    fontSize: 13,
                    fontWeight: active ? 700 : 500,
                    cursor: "pointer",
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

        {loading ? (
          <DocumentsSkeleton />
        ) : error ? (
          <ErrorBanner message={error} onRetry={() => void loadInitial()} />
        ) : docs.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "grid",
                gap: 12,
              }}
            >
              {docs.map((d) => (
                <DocumentCard key={d.id} doc={d} />
              ))}
            </ul>
            {nextCursor !== null ? (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                style={{
                  marginTop: 8,
                  width: "100%",
                  padding: "12px 16px",
                  borderRadius: 12,
                  border: "1px solid #cbd5e1",
                  background: "#f8fafc",
                  fontSize: 14,
                  fontWeight: 700,
                  color: "#334155",
                  cursor: loadingMore ? "wait" : "pointer",
                }}
              >
                {loadingMore ? "טוען…" : "טען עוד"}
              </button>
            ) : null}
          </>
        )}

      </main>

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
              setIdentityGateOpen(false);
              if (ok) {
                setCreateDocumentType(pendingCreateType);
                setCreateOpen(true);
              } else {
                setGateError("חסרים עדיין שדות חובה לזהות העסק.");
              }
            } catch {
              setGateError("שגיאת רשת");
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
        background: "rgba(15, 23, 42, 0.5)",
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
          background: "#ffffff",
          borderRadius: 16,
          padding: 20,
          boxShadow: "0 12px 40px rgba(0,0,0,0.2)",
        }}
      >
        <h2
          id="identity-gate-title"
          style={{
            margin: "0 0 8px",
            fontSize: 17,
            fontWeight: 800,
            color: "#0f172a",
          }}
        >
          הגדרת זהות העסק
        </h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "#475569" }}>
          לפני שמתחילים צריך להגדיר את פרטי העסק שיופיעו על המסמכים שלך.
        </p>
        <BusinessIdentitySetupForm form={form} onChange={onFormChange} />
        {error ? (
          <div
            role="alert"
            style={{
              marginTop: 12,
              background: "#fef2f2",
              color: "#991b1b",
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
              padding: "9px 14px",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              background: "#fff",
              fontSize: 13,
              fontWeight: 600,
              color: "#64748b",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            ביטול
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void onSaved()}
            style={{
              padding: "9px 16px",
              borderRadius: 8,
              border: "none",
              background: saving ? "#94a3b8" : "#0f172a",
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: saving ? "not-allowed" : "pointer",
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
        setErrorMsg("תגובת השרת לא תקינה");
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
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
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
          background: "#ffffff",
          borderRadius: 18,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: "0 10px 40px rgba(0, 0, 0, 0.18)",
        }}
      >
        <section
          style={{
            background: isQuote ? "#f8fafc" : "#f0fdf4",
            border: isQuote ? "1px solid #e2e8f0" : "1px solid #bbf7d0",
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
              fontWeight: 800,
              color: isQuote ? "#0f172a" : "#166534",
              margin: 0,
            }}
          >
            {isQuote ? "הצעת מחיר חדשה" : "יצירת טיוטת חשבונית"}
          </h2>
          <p
            style={{
              fontSize: 13,
              color: "#475569",
              margin: 0,
              lineHeight: 1.55,
            }}
          >
            בחרו לקוח מהרשימה או הקלידו שם חופשי. בהמשך נוסיף שורות וסיכומים במסך
            העריכה.
          </p>
          <div
            style={{
              marginTop: 6,
              paddingTop: 10,
              borderTop: isQuote
                ? "1px solid #e2e8f0"
                : "1px solid rgba(22, 101, 52, 0.18)",
              fontSize: 12,
              color: isQuote ? "#475569" : "#065f46",
              lineHeight: 1.5,
              fontWeight: 700,
            }}
          >
            {isQuote
              ? "הצעת מחיר היא מסמך עסקי בלבד. ניתן לשתף PDF ולהמיר לחשבונית מס כשמוכנים."
              : "אחרי היצירה תועבר למסך עריכת טיוטה כדי להוסיף שורות ולהפיק חשבונית."}
          </div>
        </section>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#334155",
            }}
          >
            בחירת לקוח מהירה
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
              border: "1px solid #cbd5e1",
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
              color: "#334155",
            }}
          >
            או שם לקוח (חופשי)
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
              border: "1px solid #cbd5e1",
              background: submitting ? "#f8fafc" : "#ffffff",
              fontSize: 14,
              color: "#0f172a",
              outline: "none",
              width: "100%",
              boxSizing: "border-box",
            }}
          />
          <span style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
            נדרש לבחור לקוח מהרשימה או למלא שם חופשי.
          </span>
        </label>

        {errorMsg ? (
          <div
            role="alert"
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
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
              padding: "10px 16px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              color: "#334155",
              fontSize: 14,
              fontWeight: 600,
              cursor: submitting ? "not-allowed" : "pointer",
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
              padding: "10px 16px",
              borderRadius: 10,
              border: "1px solid #0f172a",
              background: canSubmit ? "#0f172a" : "#94a3b8",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 600,
              cursor: canSubmit ? "pointer" : "not-allowed",
              minWidth: 130,
            }}
          >
            {submitting ? "יוצר טיוטה..." : "צור טיוטה והמשך"}
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
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        fontSize: 12,
        color: "#334155",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color: "#94a3b8", fontWeight: 400 }}>{label}</span>
      <span style={{ fontWeight: 800, color: "#0f172a" }}>{count}</span>
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
            background:
              "linear-gradient(90deg, #f1f5f9 0%, #e2e8f0 50%, #f1f5f9 100%)",
            backgroundSize: "200% 100%",
            animation: "billing-skeleton 1.2s ease-in-out infinite",
            border: "1px solid #e2e8f0",
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
        background: "#fef2f2",
        border: "1px solid #fecaca",
        color: "#991b1b",
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 15 }}>שגיאה בטעינת המסמכים</div>
      <div style={{ fontSize: 14, lineHeight: 1.5 }}>{message}</div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          alignSelf: "flex-start",
          padding: "8px 14px",
          borderRadius: 10,
          border: "1px solid #991b1b",
          background: "#991b1b",
          color: "#ffffff",
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        נסה שוב
      </button>
    </div>
  );
}

function EmptyState({ filter }: { filter: FilterView }) {
  const filterLabel = FILTER_OPTIONS.find((o) => o.value === filter)?.label;
  const subtitle =
    filter === "ALL"
      ? "עדיין לא נוצרו מסמכי חיוב."
      : `אין מסמכים בסטטוס ״${filterLabel ?? ""}״.`;

  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px dashed #cbd5e1",
        borderRadius: 14,
        padding: "32px 16px",
        textAlign: "center",
        color: "#475569",
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
        אין מסמכים להצגה
      </div>
      <div style={{ fontSize: 14 }}>{subtitle}</div>
    </div>
  );
}

function DocumentCard({ doc }: { doc: BillingDocumentListItem }) {
  const status = doc.status;
  const statusStyle = STATUS_STYLE[status];
  const number = getDisplayNumber(doc);
  const customer = doc.customerNameSnapshot ?? "—";
  const date = getDisplayDate(doc);
  const money = formatMoney(doc.totalAmount, doc.currency);
  const pdfIssue = doc.status === "ISSUED" && doc.pdfRenderStatus === "FAILED";
  const pdfOk = doc.status === "ISSUED" && doc.pdfRenderStatus === "DONE";
  const isQuote = doc.documentType === "QUOTE";
  const isConverted = isQuote && (doc.convertedToInvoiceId ?? null) !== null;
  const typeLabel = DOCUMENT_TYPE_LABEL[doc.documentType] ?? doc.documentType;
  const updatedDate = doc.updatedAt ? formatDate(doc.updatedAt) : null;

  return (
    <li>
      <Link
        href={`/billing/${doc.id}`}
        style={{
          display: "block",
          textDecoration: "none",
          color: "inherit",
          background: "#ffffff",
          border: pdfIssue
            ? "1px solid #fecaca"
            : isQuote
            ? "1px solid #99f6e4"
            : "1px solid #e2e8f0",
          borderRadius: 14,
          padding: 14,
          boxShadow: "0 2px 10px rgba(15, 23, 42, 0.04)",
        }}
      >
        {/* Row 1: number + badges */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#0f172a", lineHeight: 1.3 }}>
              {number}
            </span>
            {isQuote ? (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  border: "1px solid #99f6e4",
                  background: "#f0fdfa",
                  color: "#0f766e",
                  fontSize: 11,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                }}
              >
                {typeLabel}
              </span>
            ) : null}
          </div>
          <span
            style={{
              display: "inline-flex",
              gap: 5,
              alignItems: "center",
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            {pdfIssue ? (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  border: "1px solid #fecaca",
                  background: "#fef2f2",
                  color: "#991b1b",
                  fontSize: 11,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                }}
              >
                PDF נכשל
              </span>
            ) : null}
            {pdfOk ? (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  border: "1px solid #bbf7d0",
                  background: "#f0fdf4",
                  color: "#15803d",
                  fontSize: 11,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                }}
              >
                PDF ✓
              </span>
            ) : null}
            <span
              style={{
                padding: "2px 8px",
                borderRadius: 999,
                border: `1px solid ${statusStyle?.border ?? "#e2e8f0"}`,
                background: statusStyle?.bg ?? "#f1f5f9",
                color: statusStyle?.fg ?? "#334155",
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              {STATUS_LABEL[status] ?? status}
            </span>
          </span>
        </div>

        {/* Row 2: customer */}
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 8 }}>
          <span style={{ color: "#94a3b8" }}>לקוח: </span>
          <span style={{ fontWeight: 600, color: "#0f172a" }}>{customer}</span>
        </div>

        {/* Row 3: continuity */}
        {isConverted ? (
          <div
            style={{
              marginBottom: 8,
              padding: "4px 10px",
              borderRadius: 8,
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              fontSize: 12,
              color: "#15803d",
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            ✓ הומרה לחשבונית מס
          </div>
        ) : null}

        {/* Row 4: amount + date + open */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 14, color: "#0f172a" }}>
            <span style={{ fontWeight: 700 }}>{money}</span>
            {date ? (
              <span style={{ color: "#94a3b8", fontSize: 12, marginInlineStart: 6 }}>
                · {date}
              </span>
            ) : null}
            {updatedDate && updatedDate !== date ? (
              <span style={{ color: "#cbd5e1", fontSize: 11, marginInlineStart: 6 }}>
                עודכן {updatedDate}
              </span>
            ) : null}
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#475569", whiteSpace: "nowrap" }}>
            פתח ←
          </span>
        </div>
      </Link>
    </li>
  );
}
