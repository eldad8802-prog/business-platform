"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const categoryOptions = [
  {
    value: "Beauty",
    label: "יופי וטיפוח",
    subCategories: [
      { value: "Nails", label: "ציפורניים" },
      { value: "Hair", label: "שיער" },
      { value: "Skincare", label: "טיפוח פנים ועור" },
      { value: "Cosmetics", label: "קוסמטיקה" },
      { value: "Lashes", label: "ריסים וגבות" },
      { value: "Makeup", label: "איפור" },
    ],
  },
  {
    value: "Food",
    label: "אוכל ומשקאות",
    subCategories: [
      { value: "Restaurant", label: "מסעדה" },
      { value: "Bakery", label: "מאפייה" },
      { value: "Catering", label: "קייטרינג" },
      { value: "Street Food", label: "אוכל רחוב" },
      { value: "Desserts", label: "קינוחים" },
      { value: "Cafe", label: "בית קפה" },
    ],
  },
  {
    value: "Fitness",
    label: "כושר ואימון",
    subCategories: [
      { value: "Personal Training", label: "אימון אישי" },
      { value: "Pilates", label: "פילאטיס" },
      { value: "Yoga", label: "יוגה" },
      { value: "Nutrition", label: "תזונה" },
      { value: "Studio", label: "סטודיו" },
    ],
  },
  {
    value: "Home Services",
    label: "שירותי בית",
    subCategories: [
      { value: "Cleaning", label: "ניקיון" },
      { value: "Moving", label: "הובלות" },
      { value: "Repairs", label: "תיקונים" },
      { value: "Air Conditioning", label: "מיזוג אוויר" },
      { value: "Plumbing", label: "אינסטלציה" },
      { value: "Electrical", label: "חשמל" },
    ],
  },
  {
    value: "Events",
    label: "אירועים",
    subCategories: [
      { value: "Photography", label: "צילום" },
      { value: "DJ", label: "די ג'יי" },
      { value: "Decor", label: "עיצוב" },
      { value: "Production", label: "הפקה" },
      { value: "Bar", label: "בר לאירועים" },
    ],
  },
  {
    value: "Retail",
    label: "קמעונאות ומכירה",
    subCategories: [
      { value: "Fashion", label: "אופנה" },
      { value: "Gifts", label: "מתנות" },
      { value: "Accessories", label: "אקססוריז" },
      { value: "Home Design", label: "עיצוב לבית" },
      { value: "Online Store", label: "חנות אונליין" },
    ],
  },
  {
    value: "Other",
    label: "אחר",
    subCategories: [{ value: "General", label: "כללי" }],
  },
];

const businessModelOptions = [
  { value: "service", label: "שירות" },
  { value: "product", label: "מוצר" },
  { value: "hybrid", label: "שירות + מוצר" },
];

export default function OnboardingPage() {
  const router = useRouter();

  const [category, setCategory] = useState("");
  const [subCategory, setSubCategory] = useState("");
  const [businessModel, setBusinessModel] = useState("service");
  const [loading, setLoading] = useState(false);

  const currentCategory = useMemo(() => {
    return categoryOptions.find((item) => item.value === category) || null;
  }, [category]);

  const availableSubCategories = currentCategory?.subCategories || [];

  const handleCategoryChange = (value: string) => {
    setCategory(value);
    setSubCategory("");
  };

  const handleSubmit = async () => {
    try {
      if (!category || !subCategory || !businessModel) {
        alert("יש למלא את כל השדות לפני שממשיכים");
        return;
      }

      setLoading(true);

      const token = localStorage.getItem("token");

      const res = await fetch("/api/business/profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          category,
          subCategory,
          businessModel,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "שגיאה בשמירה");
      }

      router.replace("/");
    } catch (err) {
      console.error(err);
      alert("שגיאה בשמירה");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        direction: "rtl",
        padding: "24px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 560,
          background: "#ffffff",
          border: "1px solid #e5e7eb",
          borderRadius: 22,
          boxShadow: "0 10px 30px rgba(15, 23, 42, 0.07)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "28px 24px 18px",
            background: "linear-gradient(135deg, #ffffff 0%, #f8fafc 55%, #eef2ff 100%)",
            borderBottom: "1px solid #eef2f7",
          }}
        >
          <h1 style={{ margin: "0 0 8px 0", fontSize: 30, color: "#111827" }}>
            הגדרת העסק
          </h1>

          <p style={{ margin: 0, color: "#6b7280", lineHeight: 1.7 }}>
            כדי להתאים את המערכת לעסק שלך, נבקש ממך לבחור 3 פרטים בסיסיים בלבד.
          </p>
        </div>

        <div style={{ padding: 24 }}>
          <div style={{ marginBottom: 18 }}>
            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontWeight: 700,
                color: "#111827",
                fontSize: 14,
              }}
            >
              תחום העסק
            </label>

            <select
              value={category}
              onChange={(e) => handleCategoryChange(e.target.value)}
              style={{
                width: "100%",
                padding: "12px 14px",
                border: "1px solid #d1d5db",
                borderRadius: 12,
                fontSize: 15,
                background: "#fff",
                boxSizing: "border-box",
              }}
            >
              <option value="">בחר תחום</option>
              {categoryOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <div
              style={{
                marginTop: 8,
                color: "#6b7280",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              בחר את התחום הכללי שהכי מתאים לעסק שלך.
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontWeight: 700,
                color: "#111827",
                fontSize: 14,
              }}
            >
              תת תחום
            </label>

            <select
              value={subCategory}
              onChange={(e) => setSubCategory(e.target.value)}
              disabled={!category}
              style={{
                width: "100%",
                padding: "12px 14px",
                border: "1px solid #d1d5db",
                borderRadius: 12,
                fontSize: 15,
                background: category ? "#fff" : "#f3f4f6",
                boxSizing: "border-box",
              }}
            >
              <option value="">
                {category ? "בחר תת תחום" : "קודם בחר תחום"}
              </option>
              {availableSubCategories.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <div
              style={{
                marginTop: 8,
                color: "#6b7280",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              בחר את סוג העסק המדויק יותר בתוך התחום שבחרת.
            </div>
          </div>

          <div style={{ marginBottom: 22 }}>
            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontWeight: 700,
                color: "#111827",
                fontSize: 14,
              }}
            >
              מודל עסקי
            </label>

            <select
              value={businessModel}
              onChange={(e) => setBusinessModel(e.target.value)}
              style={{
                width: "100%",
                padding: "12px 14px",
                border: "1px solid #d1d5db",
                borderRadius: 12,
                fontSize: 15,
                background: "#fff",
                boxSizing: "border-box",
              }}
            >
              {businessModelOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <div
              style={{
                marginTop: 8,
                color: "#6b7280",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              האם העסק שלך מבוסס בעיקר על שירות, על מוצר, או על שילוב של שניהם.
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={loading}
            style={{
              width: "100%",
              padding: "14px 16px",
              borderRadius: 12,
              border: "1px solid #111827",
              background: "#111827",
              color: "#ffffff",
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 700,
              fontSize: 15,
            }}
          >
            {loading ? "שומר..." : "שמירה והמשך"}
          </button>
        </div>
      </div>
    </div>
  );
}