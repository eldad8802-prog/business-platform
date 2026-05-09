"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  card,
  primaryBtn,
  secondaryBtn,
  input,
  emptyState,
  pageMain,
  hero,
  heroKicker,
  heroTitle,
  heroSubText,
  alertError,
  cardTitle,
  iconWrap,
} from "../ui";
import { CATEGORIES } from "@/lib/constants/categories";
import DocumentsHeader from "@/components/documents/DocumentsHeader";

type Step = 1 | 2 | 3 | 4;

const cardHeaderRow = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 12,
};

export default function AccountantPackPage() {
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);

  const [type, setType] = useState<"month" | "quarter" | "year">("month");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [quarter, setQuarter] = useState("");

  const [categories, setCategories] = useState<string[]>([]);
  const [allCategories, setAllCategories] = useState(true);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const toggleCategory = (cat: string) => {
    if (categories.includes(cat)) {
      setCategories(categories.filter((c) => c !== cat));
    } else {
      setCategories([...categories, cat]);
    }
  };

  const handleNext = () => setStep((s) => (s + 1) as Step);
  const handleBack = () => setStep((s) => (s - 1) as Step);

  const handleGenerate = async () => {
    setLoading(true);
    setError("");

    try {
      // The export endpoint runs through `getCurrentUser`, which requires a
      // Bearer token. Without it the server returns 401 and the user just sees
      // a generic "error" toast. Send the same token used everywhere else in
      // the Documents feature.
      const token =
        typeof window !== "undefined"
          ? window.localStorage.getItem("token")
          : null;

      if (!token) {
        router.replace("/login");
        return;
      }

      const res = await fetch("/api/reports/export-zip", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type,
          month,
          year,
          quarter,
          categories: allCategories ? [] : categories,
        }),
      });

      if (res.status === 401) {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem("token");
          window.localStorage.removeItem("user");
        }
        router.replace("/login");
        return;
      }

      if (!res.ok) throw new Error("שגיאה ביצירת חבילה");

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "accountant-pack.zip";
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message || "שגיאה");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div dir="rtl">
      <DocumentsHeader title="חבילה לרו״ח" />

      <main style={pageMain}>
        <section style={hero}>
          <div style={heroKicker}>ייצוא</div>
          <h1 style={heroTitle}>חבילה לרואה חשבון</h1>
          <p style={heroSubText}>בחר תקופה, סנן קטגוריות, והורד ZIP.</p>
        </section>

        {/* STEP 1 */}
        {step === 1 && (
          <>
            <div style={card}>
              <div style={cardHeaderRow}>
                <div style={iconWrap} aria-hidden>
                  📅
                </div>
                <div style={cardTitle}>בחירת תקופה</div>
              </div>

              <button style={secondaryBtn} onClick={() => setType("month")}>
                חודש
              </button>
              <button style={secondaryBtn} onClick={() => setType("quarter")}>
                רבעון
              </button>
              <button style={secondaryBtn} onClick={() => setType("year")}>
                שנה קודמת
              </button>

              {type === "month" && (
                <input
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  style={input}
                />
              )}

              {type === "quarter" && (
                <>
                  <input
                    placeholder="שנה (2026)"
                    value={year}
                    onChange={(e) => setYear(e.target.value)}
                    style={input}
                  />
                  <input
                    placeholder="רבעון (1-4)"
                    value={quarter}
                    onChange={(e) => setQuarter(e.target.value)}
                    style={input}
                  />
                </>
              )}
            </div>

            <button style={primaryBtn} onClick={handleNext}>
              המשך
            </button>
          </>
        )}

        {/* STEP 2 */}
        {step === 2 && (
          <>
            <div style={card}>
              <div style={cardHeaderRow}>
                <div style={iconWrap} aria-hidden>
                  🏷️
                </div>
                <div style={cardTitle}>בחירת קטגוריות</div>
              </div>

              <button
                style={secondaryBtn}
                onClick={() => {
                  setAllCategories(true);
                  setCategories([]);
                }}
              >
                כל הקטגוריות
              </button>

              {CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  style={{
                    ...secondaryBtn,
                    background: categories.includes(cat.value) ? "#111827" : "#ffffff",
                    color: categories.includes(cat.value) ? "#ffffff" : "#111827",
                    border: "1px solid #e5e7eb",
                  }}
                  onClick={() => {
                    setAllCategories(false);
                    toggleCategory(cat.value);
                  }}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            <button style={primaryBtn} onClick={handleNext}>
              המשך
            </button>
            <button style={secondaryBtn} onClick={handleBack}>
              חזרה
            </button>
          </>
        )}

        {/* STEP 3 */}
        {step === 3 && (
          <>
            <div style={card}>
              <div style={cardHeaderRow}>
                <div style={iconWrap} aria-hidden>
                  📋
                </div>
                <div style={cardTitle}>סיכום</div>
              </div>
              <div style={{ color: "#111827", fontWeight: 800, lineHeight: 1.7 }}>
                <div>תקופה: {type}</div>
                <div style={{ marginTop: 8 }}>
                  קטגוריות:{" "}
                  {allCategories
                    ? "הכל"
                    : categories
                        .map(
                          (c) =>
                            CATEGORIES.find((cat) => cat.value === c)?.label || c
                        )
                        .join(", ")}
                </div>
              </div>
            </div>

            <button style={primaryBtn} onClick={handleNext}>
              הכנס חבילה
            </button>
            <button style={secondaryBtn} onClick={handleBack}>
              חזרה
            </button>
          </>
        )}

        {/* STEP 4 */}
        {step === 4 && (
          <>
            {loading ? (
              <div style={emptyState}>מכין חבילה...</div>
            ) : (
              <button style={primaryBtn} onClick={handleGenerate}>
                הורד ZIP
              </button>
            )}

            {error && <div style={alertError}>{error}</div>}
          </>
        )}
      </main>
    </div>
  );
}
