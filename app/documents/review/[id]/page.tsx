"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CATEGORIES, CATEGORY_MAP } from "@/lib/constants/categories";

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

function isUsableFileUrl(fileUrl: string): boolean {
  const value = fileUrl.trim();
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("/")
  );
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
  return { minHeight: "100vh", background: "#f8fafc" as const };
}

function mainStyle() {
  return {
    maxWidth: 1120,
    margin: "0 auto",
    padding: "18px 16px 28px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 18,
  };
}

function heroStyle() {
  return {
    width: "100%",
    borderRadius: 30,
    padding: 24,
    background:
      "linear-gradient(135deg, #111827 0%, #1f2937 50%, #0f766e 100%)",
    color: "#ffffff",
    boxShadow: "0 18px 44px rgba(15, 23, 42, 0.22)",
    display: "flex",
    flexDirection: "column" as const,
    gap: 18,
    boxSizing: "border-box" as const,
  };
}

function cardStyle() {
  return {
    border: "1px solid #e5e7eb",
    borderRadius: 26,
    background: "#ffffff",
    padding: 18,
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
    boxSizing: "border-box" as const,
  };
}

function alertErrorStyle() {
  return {
    border: "1px solid #fecaca",
    background: "#fef2f2",
    color: "#991b1b",
    borderRadius: 18,
    padding: 14,
    fontSize: 14,
    fontWeight: 800,
    lineHeight: 1.5,
  };
}

function alertSuccessStyle() {
  return {
    border: "1px solid #bbf7d0",
    background: "#f0fdf4",
    color: "#166534",
    borderRadius: 18,
    padding: 14,
    fontSize: 14,
    fontWeight: 800,
    lineHeight: 1.5,
  };
}

function primaryDarkButton(disabled?: boolean) {
  return {
    width: "100%",
    minHeight: 54,
    borderRadius: 18,
    border: "none",
    background: disabled ? "rgba(17, 24, 39, 0.45)" : "#111827",
    color: "#ffffff",
    fontSize: 15,
    fontWeight: 950,
    cursor: disabled ? "not-allowed" : "pointer",
  } as const;
}

function secondaryButton(disabled?: boolean) {
  return {
    width: "100%",
    minHeight: 52,
    borderRadius: 18,
    border: "1px solid #e5e7eb",
    background: "#ffffff",
    color: "#111827",
    fontSize: 14,
    fontWeight: 900,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  } as const;
}

function smallPillButton(disabled?: boolean) {
  return {
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.12)",
    padding: "10px 12px",
    color: "#ffffff",
    fontWeight: 900,
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.65 : 1,
    width: "fit-content",
  } as const;
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

  const [document, setDocument] = useState<ApiDocument | null>(null);
  const [outputProfile, setOutputProfile] = useState<OutputProfile | null>(null);

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
        setReviewMode(pid === "financial_transaction" ? "financial" : "document");
        setState("decision");
      } catch (e: any) {
        setError(e?.message || "שגיאה בטעינת המסמך");
      } finally {
        setPageLoading(false);
      }
    };

    void load();
  }, [id, authHeader]);

  const pid = outputProfile?.profileId || "unknown_review";
  const isUnknown = pid === "unknown_review";
  const isFinancial = pid === "financial_transaction";
  const isTaxOrPension = pid === "tax_or_pension_document";

  const baseDecisionTitle = isFinancial
    ? "נראה כמו קבלה/עסקה"
    : isTaxOrPension
      ? "זה נראה כמו מסמך מידע"
      : "זה נראה כמו מסמך מידע";

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

  const heroTitle =
    state === "decision"
      ? baseDecisionTitle
      : state === "summary"
        ? "בדוק את הפרטים לפני אישור"
        : state === "edit-field"
          ? editFieldTitle
          : "המסמך נשמר בהצלחה";

  const heroSubText =
    state === "decision"
      ? isUnknown
        ? "אם זו קבלה או עסקה אפשר לשנות לפני השמירה"
        : "זיהינו את הפרטים המרכזיים — אפשר לבדוק ולאשר"
      : state === "summary"
        ? "אפשר לערוך כל שדה לפני שמאשרים ושומרים במערכת"
        : state === "edit-field"
          ? "עדכן את הערך ולחץ שמור כדי לחזור לסיכום"
          : "המידע נשמר וזמין במערכת";

  const heroBadge =
    state === "decision"
      ? isFinancial
        ? "שלב 1 מתוך 3 · מסמך פיננסי"
        : "שלב 1 מתוך 3 · בדיקת מסמך"
      : state === "summary"
        ? "שלב 2 מתוך 3 · אישור פרטים"
        : state === "edit-field"
          ? "עריכה נקודתית"
          : "סיום";

  function firstMissingFinancialField(): EditableField | null {
    if (!isValidPositiveAmount(draft.amount)) return "amount";
    if (!hasNonEmptyText(draft.vendorName)) return "vendorName";
    if (!draft.date || !formatDateShort(draft.date)) return "date";
    if (draft.direction !== "expense" && draft.direction !== "income")
      return "direction";
    if (!hasNonEmptyText(draft.category)) return "category";
    return null;
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

      setState("done");
    } catch (e: any) {
      setError(e?.message || "שגיאה באישור המסמך");
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

      setState("done");
    } catch (e: any) {
      setError(e?.message || "שגיאה בשמירת העסקה");
    } finally {
      setLoading(false);
    }
  }

  const fileUrl = document?.fileUrl || "";
  const canUseFileUrl = isUsableFileUrl(fileUrl);
  const previewKind = getPreviewKind(fileUrl, document?.mimeType);
  const shouldShowDocumentPreview = state !== "done";
  const showPreviewFallback =
    !canUseFileUrl || previewKind === "unsupported" || previewFailed;

  if (pageLoading) {
    return (
      <div dir="rtl" style={basePageStyle()}>
        <main style={mainStyle()}>
          <div style={cardStyle()}>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#111827",
                marginBottom: 10,
                textAlign: "center",
              }}
            >
              טוען מסמך...
            </div>
            <div style={{ fontSize: 15, color: "#6b7280", textAlign: "center" }}>
              עוד רגע מסיימים להכין את התצוגה.
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!document) {
    return (
      <div dir="rtl" style={basePageStyle()}>
        <main style={mainStyle()}>
          <div style={cardStyle()}>
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
        <section style={heroStyle()}>
          <div>
            <div
              style={{
                display: "inline-flex",
                padding: "7px 11px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.18)",
                fontSize: 12,
                fontWeight: 900,
                marginBottom: 12,
              }}
            >
              {heroBadge}
            </div>
            <h1 style={{ margin: 0, fontSize: 28, lineHeight: 1.25, fontWeight: 950 }}>
              {heroTitle}
            </h1>
            <p
              style={{
                margin: "8px 0 0",
                color: "rgba(255,255,255,0.78)",
                fontSize: 14,
                lineHeight: 1.7,
              }}
            >
              {heroSubText}
            </p>
          </div>

          {state === "decision" && isUnknown ? (
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <button
                type="button"
                disabled={loading}
                style={smallPillButton(loading)}
                onClick={() => setReviewMode("financial")}
              >
                זה קבלה / עסקה
              </button>
            </div>
          ) : null}
        </section>

        {error ? <div style={alertErrorStyle()}>{error}</div> : null}

        {state === "decision" ? (
          <section style={cardStyle()}>
            <div style={{ fontWeight: 950, color: "#111827", fontSize: 18, marginBottom: 14 }}>
              מה זיהינו עד עכשיו
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: 10,
              }}
            >
              <div
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 22,
                  padding: 14,
                  background: "#f9fafb",
                }}
              >
                <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 800 }}>
                  ספק
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 18,
                    fontWeight: 950,
                    color: "#111827",
                    overflowWrap: "anywhere",
                  }}
                >
                  {draft.vendorName || "—"}
                </div>
              </div>

              <div
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 22,
                  padding: 14,
                  background: "#f9fafb",
                }}
              >
                <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 800 }}>
                  סכום
                </div>
                <div style={{ marginTop: 6, fontSize: 28, fontWeight: 950, color: "#111827" }}>
                  {typeof draft.amount === "number" ? draft.amount : "—"}
                </div>
              </div>

              <div
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 22,
                  padding: 14,
                  background: "#f9fafb",
                }}
              >
                <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 800 }}>
                  תאריך
                </div>
                <div style={{ marginTop: 6, fontSize: 18, fontWeight: 950, color: "#111827" }}>
                  {formatDateShort(draft.date) || "—"}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                disabled={loading}
                style={primaryDarkButton(loading)}
                onClick={() => setState("summary")}
              >
                בדוק ואשר
              </button>
            </div>

            {isUnknown ? (
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  disabled={loading}
                  style={secondaryButton(loading)}
                  onClick={() => {
                    setReviewMode("financial");
                    setState("summary");
                  }}
                >
                  זה קבלה / עסקה
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {state === "summary" ? (
          <section style={cardStyle()}>
            {reviewMode === "financial" ? (
              <>
                <div style={{ fontWeight: 950, color: "#111827", fontSize: 18, marginBottom: 10 }}>
                  פרטי עסקה
                </div>

                {(
                  [
                    {
                      k: "amount",
                      label: "סכום",
                      value: typeof draft.amount === "number" ? String(draft.amount) : "לא הוזן",
                    },
                    {
                      k: "vendorName",
                      label: "ספק",
                      value: draft.vendorName ? draft.vendorName : "לא הוזן",
                    },
                    {
                      k: "date",
                      label: "תאריך",
                      value: formatDateShort(draft.date) || "לא הוזן",
                    },
                    {
                      k: "direction",
                      label: "כיוון",
                      value:
                        draft.direction === "expense"
                          ? "הוצאה"
                          : draft.direction === "income"
                            ? "הכנסה"
                            : "לא הוזן",
                    },
                    {
                      k: "category",
                      label: "קטגוריה",
                      value: CATEGORY_MAP[draft.category] || draft.category || "לא הוזן",
                    },
                  ] as const
                ).map((row) => (
                  <div
                    key={row.k}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "12px 0",
                      borderBottom: "1px solid #f1f5f9",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "#6b7280", fontWeight: 800 }}>
                        {row.label}
                      </div>
                      <div style={{ fontSize: 16, fontWeight: 950, color: "#111827" }}>
                        {row.value}
                      </div>
                    </div>
                    <button
                      type="button"
                      style={{
                        padding: "10px 12px",
                        borderRadius: 14,
                        border: "1px solid #e5e7eb",
                        background: "#f9fafb",
                        color: "#111827",
                        fontWeight: 900,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                      onClick={() => {
                        setEditField(row.k);
                        setState("edit-field");
                      }}
                    >
                      ערוך
                    </button>
                  </div>
                ))}

                <div style={{ marginTop: 16 }}>
                  <button
                    type="button"
                    disabled={loading}
                    style={primaryDarkButton(loading)}
                    onClick={() => {
                      const missing = firstMissingFinancialField();
                      if (missing) {
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
                      return "מאשר ושומר";
                    })()}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 950, color: "#111827", fontSize: 18, marginBottom: 10 }}>
                  סיכום מסמך
                </div>

                <div style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
                  בדיקה קצרה לפני שמירה. אפשר לערוך קטגוריה אם צריך.
                </div>

                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 13, color: "#6b7280", fontWeight: 800 }}>
                    קטגוריה
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ fontSize: 16, fontWeight: 950, color: "#111827" }}>
                      {CATEGORY_MAP[draft.category] || draft.category || "general"}
                    </div>
                    <button
                      type="button"
                      style={{
                        padding: "10px 12px",
                        borderRadius: 14,
                        border: "1px solid #e5e7eb",
                        background: "#f9fafb",
                        color: "#111827",
                        fontWeight: 900,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                      onClick={() => {
                        setEditField("category");
                        setState("edit-field");
                      }}
                    >
                      ערוך
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 16 }}>
                  <button
                    type="button"
                    disabled={loading}
                    style={primaryDarkButton(loading)}
                    onClick={() => void approveDocumentOnly()}
                  >
                    {loading ? "שומר..." : "מאשר ושומר"}
                  </button>
                </div>
              </>
            )}
          </section>
        ) : null}

        {state === "edit-field" ? (
          <section style={cardStyle()}>
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

            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                disabled={loading}
                style={primaryDarkButton(loading)}
                onClick={() => setState("summary")}
              >
                שמור
              </button>
            </div>

            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                disabled={loading}
                style={secondaryButton(loading)}
                onClick={() => setState("summary")}
              >
                ביטול
              </button>
            </div>
          </section>
        ) : null}

        {state === "done" ? (
          <section style={cardStyle()}>
            <div style={alertSuccessStyle()}>
              {reviewMode === "financial"
                ? draft.direction === "income"
                  ? "נשמר כהכנסה"
                  : "נשמר כהוצאה"
                : "המסמך אושר"}
            </div>

            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                style={primaryDarkButton(false)}
                onClick={() => router.push("/documents")}
              >
                חזרה למסמכים
              </button>
            </div>
          </section>
        ) : null}

        {shouldShowDocumentPreview ? (
          <section style={cardStyle()}>
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
                  אין תצוגה מקדימה זמינה
                </div>
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 14,
                    color: "#6b7280",
                    lineHeight: 1.6,
                  }}
                >
                  המסמך קיים במערכת, אבל לא ניתן להציג אותו כאן כרגע.
                </div>
                {canUseFileUrl ? (
                  <a
                    href={fileUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "inline-flex",
                      marginTop: 14,
                      padding: "12px 16px",
                      borderRadius: 14,
                      background: "#111827",
                      color: "#ffffff",
                      fontWeight: 900,
                      textDecoration: "none",
                    }}
                  >
                    פתח מסמך
                  </a>
                ) : null}
              </div>
            ) : previewKind === "pdf" ? (
              <iframe
                src={fileUrl}
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
                src={fileUrl}
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