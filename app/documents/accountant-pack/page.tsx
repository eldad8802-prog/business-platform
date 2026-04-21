"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  header,
  subheader,
  card,
  primaryBtn,
  secondaryBtn,
  input,
  emptyState,
} from "../ui";
import { CATEGORIES } from "@/lib/constants/categories";

type Step = 1 | 2 | 3 | 4;

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
      const res = await fetch("/api/reports/export-zip", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type,
          month,
          year,
          quarter,
          categories: allCategories ? [] : categories,
        }),
      });

      if (!res.ok) throw new Error("שגיאה ביצירת חבילה");

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "accountant-pack.zip";
      a.click();
    } catch (e: any) {
      setError(e.message || "שגיאה");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      {/* STEP 1 */}
      {step === 1 && (
        <>
          <h1 style={header}>בחירת תקופה</h1>
          <p style={subheader}>על איזה זמן להכין את החבילה</p>

          <div style={card}>
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
          <h1 style={header}>בחירת קטגוריות</h1>

          <div style={card}>
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
                  background: categories.includes(cat.value)
                    ? "#111"
                    : "#f5f5f5",
                  color: categories.includes(cat.value) ? "#fff" : "#000",
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
          <h1 style={header}>סיכום</h1>

          <div style={card}>
            <p>📅 תקופה: {type}</p>
            <p>
              📂 קטגוריות:{" "}
              {allCategories
                ? "הכל"
                : categories
                    .map(
                      (c) =>
                        CATEGORIES.find((cat) => cat.value === c)?.label || c
                    )
                    .join(", ")}
            </p>
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
          <h1 style={header}>יצירת חבילה</h1>

          {loading ? (
            <div style={emptyState}>מכין חבילה...</div>
          ) : (
            <button style={primaryBtn} onClick={handleGenerate}>
              הורד ZIP
            </button>
          )}

          {error && <div style={emptyState}>{error}</div>}
        </>
      )}
    </div>
  );
}