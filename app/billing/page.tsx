"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

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
};

type StatusFilter = "ALL" | BillingStatus;

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "ALL", label: "הכל" },
  { value: "DRAFT", label: "טיוטה" },
  { value: "PENDING_REVIEW", label: "ממתין לאישור" },
  { value: "ISSUED", label: "הופק" },
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
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [docs, setDocs] = useState<BillingDocumentListItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState<boolean>(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const token = getAuthToken();
      const params = new URLSearchParams({ limit: "50" });
      if (filter !== "ALL") {
        params.set("status", filter);
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
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "אירעה שגיאה בטעינת המסמכים"
      );
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main
      style={{
        minHeight: "100dvh",
        background: "#f8fafc",
        padding: "24px 16px 80px",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <header style={{ marginBottom: 16 }}>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: "#0f172a",
              margin: 0,
            }}
          >
            מסמכי חיוב
          </h1>
          <p
            style={{
              fontSize: 14,
              color: "#64748b",
              margin: "4px 0 16px 0",
            }}
          >
            חשבוניות מס ומסמכים שהעסק מפיק ללקוחות
          </p>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            style={{
              cursor: "pointer",
              padding: "10px 16px",
              borderRadius: 10,
              border: "1px solid #0f172a",
              background: "#0f172a",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            + חשבונית חדשה
          </button>
        </header>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 16,
          }}
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
                  padding: "6px 14px",
                  borderRadius: 999,
                  border: "1px solid",
                  borderColor: active ? "#0f172a" : "#e2e8f0",
                  background: active ? "#0f172a" : "#ffffff",
                  color: active ? "#ffffff" : "#334155",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {loading ? (
          <DocumentsSkeleton />
        ) : error ? (
          <ErrorBanner message={error} onRetry={() => void load()} />
        ) : docs.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 10,
            }}
          >
            {docs.map((d) => (
              <DocumentCard key={d.id} doc={d} />
            ))}
          </ul>
        )}
      </div>

      {createOpen ? (
        <CreateDraftModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            router.push(`/billing/${id}`);
          }}
        />
      ) : null}
    </main>
  );
}

function CreateDraftModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (documentId: number) => void;
}) {
  const [name, setName] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const trimmed = name.trim();
  const canSubmit = !submitting && trimmed.length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMsg(null);

    try {
      const token = getAuthToken();
      const res = await fetch("/api/billing/documents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          documentType: "TAX_INVOICE",
          customerNameSnapshot: trimmed,
        }),
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
      aria-label="יצירת חשבונית חדשה"
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
          borderRadius: 16,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: "0 10px 40px rgba(0, 0, 0, 0.18)",
        }}
      >
        <h2
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: "#0f172a",
            margin: 0,
          }}
        >
          חשבונית חדשה
        </h2>
        <p
          style={{
            fontSize: 13,
            color: "#64748b",
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          ייווצר מסמך בסטטוס טיוטה. עריכת שורות וכותרת תתווסף בשלב הבא.
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#334155",
            }}
          >
            שם לקוח <span style={{ color: "#ef4444" }}>*</span>
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
            {submitting ? "יוצר טיוטה..." : "צור טיוטה"}
          </button>
        </div>
      </div>
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

function EmptyState({ filter }: { filter: StatusFilter }) {
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

  return (
    <li>
      <Link
        href={`/billing/${doc.id}`}
        style={{
          display: "block",
          textDecoration: "none",
          color: "inherit",
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: 14,
          padding: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: "#0f172a",
            }}
          >
            {number}
          </span>
          <span
            style={{
              padding: "3px 10px",
              borderRadius: 999,
              border: `1px solid ${statusStyle?.border ?? "#e2e8f0"}`,
              background: statusStyle?.bg ?? "#f1f5f9",
              color: statusStyle?.fg ?? "#334155",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {STATUS_LABEL[status] ?? status}
          </span>
        </div>

        <div style={{ fontSize: 14, color: "#334155", marginBottom: 6 }}>
          לקוח: <span style={{ fontWeight: 500 }}>{customer}</span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 14, color: "#0f172a" }}>
            <span style={{ fontWeight: 600 }}>{money}</span>
            {date ? (
              <>
                {" "}
                <span style={{ color: "#64748b" }}>· {date}</span>
              </>
            ) : null}
          </div>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#0f172a",
            }}
          >
            פתח ←
          </span>
        </div>
      </Link>
    </li>
  );
}
