"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type PricingItem = {
  id: number;
  name: string;
};

type BusinessProfile = {
  id: number;
  businessId: number;
  category: string | null;
  subCategory: string | null;
  businessModel: string | null;
  createdAt: string;
  updatedAt: string;
};

type Result = {
  costBreakdown: {
    materialCost: number;
    laborCost: number;
    directCost: number;
    overheadCost: number;
    fullCost: number;
  };
  priceOptions: {
    minimum: number;
    recommended: number;
    premium: number;
  };
  profit: {
    amount: number;
    percent: number;
    indicator: "LOW" | "OK" | "HIGH";
    label: string;
  };
  explanation: string;
};

function Pressable({
  children,
  onPress,
  disabled = false,
  style,
}: {
  children: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const handlePress = () => {
    if (disabled) return;
    onPress();
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={handlePress}
      onTouchEnd={(e) => {
        e.preventDefault();
        handlePress();
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handlePress();
        }
      }}
      style={{
        ...pressableBaseStyle,
        ...(disabled ? disabledPressableStyle : null),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "#f8fafc",
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        padding: 14,
      }}
    >
      <div style={{ color: "#6b7280", fontSize: 13, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontWeight: 800, color: "#111827" }}>{value}</div>
    </div>
  );
}

export default function PricingPage() {
  const router = useRouter();

  const [token, setToken] = useState<string | null>(null);
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile | null>(null);

  const [items, setItems] = useState<PricingItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const [bootLoading, setBootLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingCalculation, setLoadingCalculation] = useState(false);
  const [creatingItem, setCreatingItem] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  const [showCreateForm, setShowCreateForm] = useState(false);

  const [newItemName, setNewItemName] = useState("");
  const [newItemType, setNewItemType] = useState("SERVICE");
  const [newItemCategory, setNewItemCategory] = useState("");
  const [newMaterialCost, setNewMaterialCost] = useState("");
  const [newLaborMinutes, setNewLaborMinutes] = useState("");
  const [newHourlyRate, setNewHourlyRate] = useState("");
  const [newOverheadPercent, setNewOverheadPercent] = useState("");

  useEffect(() => {
    const run = async () => {
      const savedToken = localStorage.getItem("token");

      if (!savedToken) {
        router.replace("/login");
        return;
      }

      try {
        const profileRes = await fetch("/api/business/profile", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${savedToken}`,
          },
          cache: "no-store",
        });

        const profileData = await profileRes.json();

        if (profileRes.status === 401) {
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          router.replace("/login");
          return;
        }

        if (!profileRes.ok) {
          throw new Error(profileData?.error || "שגיאה בבדיקת פרופיל העסק");
        }

        if (!profileData?.hasProfile || !profileData?.profile) {
          router.replace("/onboarding");
          return;
        }

        setBusinessProfile(profileData.profile);
        setToken(savedToken);
      } catch (err) {
        console.error("Pricing boot check failed:", err);
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        router.replace("/login");
      } finally {
        setBootLoading(false);
      }
    };

    run();
  }, [router]);

  useEffect(() => {
    if (!businessProfile?.businessModel) return;

    if (businessProfile.businessModel === "product") {
      setNewItemType("PRODUCT");
      return;
    }

    setNewItemType("SERVICE");
  }, [businessProfile]);

  const loadItems = async (currentToken: string) => {
    try {
      setLoadingItems(true);
      setError(null);

      const res = await fetch("/api/pricing/profiles", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${currentToken}`,
        },
        cache: "no-store",
      });

      const data = await res.json();

      if (res.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        router.replace("/login");
        return;
      }

      if (!res.ok) {
        throw new Error(data?.error || "שגיאה בטעינת המוצרים והשירותים");
      }

      const nextItems = Array.isArray(data.profiles) ? data.profiles : [];
      setItems(nextItems);

      if (nextItems.length > 0 && !selectedItemId) {
        setSelectedItemId(nextItems[0].id);
      }
    } catch (err) {
      console.error("Failed to load pricing items:", err);
      setItems([]);
      setError(
        err instanceof Error ? err.message : "שגיאה בטעינת המוצרים והשירותים"
      );
    } finally {
      setLoadingItems(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    loadItems(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleCalculate = async () => {
    if (!selectedItemId || !token) return;

    try {
      setLoadingCalculation(true);
      setError(null);
      setResult(null);

      const res = await fetch("/api/pricing/calculate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          pricingProfileId: selectedItemId,
        }),
      });

      const data = await res.json();

      if (res.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        router.replace("/login");
        return;
      }

      if (!res.ok) {
        throw new Error(data?.error || "שגיאה בחישוב המחיר");
      }

      setResult(data);
    } catch (err) {
      console.error("Failed to calculate price:", err);
      setError(err instanceof Error ? err.message : "שגיאה בחישוב המחיר");
    } finally {
      setLoadingCalculation(false);
    }
  };

  const resetCreateForm = () => {
    setNewItemName("");
    setNewItemType("SERVICE");
    setNewItemCategory("");
    setNewMaterialCost("");
    setNewLaborMinutes("");
    setNewHourlyRate("");
    setNewOverheadPercent("");
  };

  const handleCreateItem = async () => {
    if (!token) return;

    try {
      setCreatingItem(true);
      setCreateError(null);
      setCreateSuccess(null);

      const res = await fetch("/api/pricing/profiles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: newItemName,
          type: newItemType,
          category: newItemCategory,
          defaultMaterialCost: Number(newMaterialCost || 0),
          defaultLaborMinutes: Number(newLaborMinutes || 0),
          defaultHourlyRate: Number(newHourlyRate || 0),
          defaultOverheadPercent: Number(newOverheadPercent || 0),
          isActive: true,
        }),
      });

      const data = await res.json();

      if (res.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        router.replace("/login");
        return;
      }

      if (!res.ok) {
        throw new Error(data?.error || "שגיאה ביצירת המוצר או השירות");
      }

      setCreateSuccess("המוצר / השירות נוצר בהצלחה");
      resetCreateForm();
      setShowCreateForm(false);

      await loadItems(token);

      if (data?.profile?.id) {
        setSelectedItemId(data.profile.id);
      }
    } catch (err) {
      console.error("Failed to create pricing item:", err);
      setCreateError(
        err instanceof Error ? err.message : "שגיאה ביצירת המוצר או השירות"
      );
    } finally {
      setCreatingItem(false);
    }
  };

  const isProduct = newItemType === "PRODUCT";

  const selectedItemName = useMemo(() => {
    return items.find((item) => item.id === selectedItemId)?.name ?? null;
  }, [items, selectedItemId]);

  const businessModelLabel = useMemo(() => {
    if (!businessProfile?.businessModel) return "—";

    if (businessProfile.businessModel === "service") return "שירות";
    if (businessProfile.businessModel === "product") return "מוצר";
    if (businessProfile.businessModel === "hybrid") return "היברידי";

    return businessProfile.businessModel;
  }, [businessProfile]);

  const businessContextText = useMemo(() => {
    if (!businessProfile?.category) return null;

    const normalizedCategory = businessProfile.category.toLowerCase();

    if (normalizedCategory.includes("beauty")) {
      return "בעסקי שירות כמו שלך, חשוב במיוחד להבין את זמן העבודה והרווח מכל טיפול.";
    }

    if (normalizedCategory.includes("food")) {
      return "בעסקי מוצר כמו שלך, שליטה בעלויות חומר ומחיר מכירה היא קריטית לרווח.";
    }

    return "המערכת מותאמת לסוג העסק שלך ותעזור לך להבין בדיוק את הרווחיות.";
  }, [businessProfile]);

  const pricingText = useMemo(() => {
    if (!businessProfile?.businessModel) {
      return {
        createTitle: "יצירת מוצר / שירות חדש",
        createDescription: "מלא את הפרטים כדי לחשב מחיר בצורה מדויקת.",
      };
    }

    if (businessProfile.businessModel === "service") {
      return {
        createTitle: "יצירת שירות חדש",
        createDescription:
          "בשירותים חשוב להבין את זמן העבודה שלך ואת הערך לשעה כדי לשמור על רווחיות.",
      };
    }

    if (businessProfile.businessModel === "product") {
      return {
        createTitle: "יצירת מוצר חדש",
        createDescription:
          "במוצרים חשוב לשלוט בעלות החומר ובמחיר המכירה כדי להבטיח רווח.",
      };
    }

    return {
      createTitle: "יצירת מוצר / שירות חדש",
      createDescription:
        "המערכת תעזור לך לחשב עלויות ורווח בצורה פשוטה וברורה.",
    };
  }, [businessProfile]);

  const fieldText = useMemo(() => {
    if (!businessProfile?.businessModel) {
      return {
        material: "הזן את עלות החומרים או העלות הישירה.",
        labor: "הזן זמן עבודה אם רלוונטי.",
      };
    }

    if (businessProfile.businessModel === "service") {
      return {
        material:
          "אם יש חומרים שנצרכים במהלך השירות, הזן כאן את העלות שלהם.",
        labor:
          "כמה זמן לוקח לך לבצע את השירות בפועל. זה אחד הגורמים הכי חשובים לרווח.",
      };
    }

    if (businessProfile.businessModel === "product") {
      return {
        material:
          "כמה עולה לך לקנות או לייצר את המוצר לפני מכירה.",
        labor:
          "אם יש זמן עבודה באריזה או בהכנה, הזן אותו כאן. אחרת אפשר להשאיר נמוך.",
      };
    }

    return {
      material: "הזן את עלות החומרים.",
      labor: "הזן זמן עבודה.",
    };
  }, [businessProfile]);

  const calculationInsight = useMemo(() => {
    if (!result || !businessProfile?.businessModel) return null;

    const fullCost = Number(result.costBreakdown.fullCost || 0);
    const materialCost = Number(result.costBreakdown.materialCost || 0);
    const laborCost = Number(result.costBreakdown.laborCost || 0);

    if (fullCost <= 0) return null;

    if (businessProfile.businessModel === "service") {
      const laborShare = Math.round((laborCost / fullCost) * 100);

      return {
        title: "תובנה לעסק שירותי",
        text:
          laborShare >= 50
            ? `עלות העבודה מהווה בערך ${laborShare}% מהעלות המלאה. בעסק שירותי זה סימן שכדאי לשים לב במיוחד לזמן העבודה ולתמחור לשעה.`
            : `עלות העבודה מהווה בערך ${laborShare}% מהעלות המלאה. כרגע העבודה לא שולטת ברוב העלות, אבל עדיין חשוב לוודא שהתמחור משקף את הזמן שלך.`,
      };
    }

    if (businessProfile.businessModel === "product") {
      const materialShare = Math.round((materialCost / fullCost) * 100);

      return {
        title: "תובנה לעסק מוצרי",
        text:
          materialShare >= 50
            ? `עלות החומר מהווה בערך ${materialShare}% מהעלות המלאה. בעסק מוצרי זה סימן קריטי שכדאי לשלוט היטב בעלות הקנייה או הייצור.`
            : `עלות החומר מהווה בערך ${materialShare}% מהעלות המלאה. זה אומר שיש גם מרכיבים נוספים בעלות הכוללת שכדאי לא להתעלם מהם.`,
      };
    }

    const materialShare = Math.round((materialCost / fullCost) * 100);
    const laborShare = Math.round((laborCost / fullCost) * 100);

    return {
      title: "תובנה לעסק היברידי",
      text: `אצלך יש שילוב בין חומר לעבודה: חומר כ־${materialShare}% מהעלות המלאה, ועבודה כ־${laborShare}%. בעסק היברידי חשוב לאזן בין שניהם בתמחור.`,
    };
  }, [result, businessProfile]);

  const cardStyle: React.CSSProperties = {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 18,
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
    padding: 20,
  };

  const sectionTitleStyle: React.CSSProperties = {
    margin: "0 0 6px 0",
    fontSize: 22,
    color: "#111827",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: 8,
    fontWeight: 600,
    color: "#111827",
    fontSize: 14,
  };

  const helperStyle: React.CSSProperties = {
    marginTop: -6,
    marginBottom: 14,
    color: "#6b7280",
    fontSize: 13,
    lineHeight: 1.5,
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    marginBottom: 16,
    border: "1px solid #d1d5db",
    borderRadius: 12,
    outline: "none",
    fontSize: 15,
    background: "#fff",
    boxSizing: "border-box",
    fontFamily: "inherit",
    WebkitAppearance: "none",
    appearance: "none",
    pointerEvents: "auto",
  };

  const buttonStyle: React.CSSProperties = {
    minHeight: 48,
    padding: "12px 16px",
    borderRadius: 12,
    border: "1px solid #111827",
    background: "#111827",
    color: "#ffffff",
    fontWeight: 700,
    fontSize: 14,
  };

  const secondaryButtonStyle: React.CSSProperties = {
    minHeight: 48,
    padding: "12px 16px",
    borderRadius: 12,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#111827",
    fontWeight: 600,
    fontSize: 14,
  };

  const mutedTextStyle: React.CSSProperties = {
    color: "#6b7280",
    fontSize: 14,
    lineHeight: 1.6,
  };

  const resultBoxStyle: React.CSSProperties = {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: 14,
  };

  const highlightValueStyle: React.CSSProperties = {
    fontSize: 28,
    fontWeight: 800,
    color: "#2563eb",
    margin: "6px 0 0 0",
  };

  if (bootLoading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          direction: "rtl",
          background: "#f8fafc",
        }}
      >
        <div style={cardStyle}>טוען...</div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        direction: "rtl",
        padding: "24px 16px 40px",
      }}
    >
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        <div
          style={{
            ...cardStyle,
            marginBottom: 20,
            background:
              "linear-gradient(135deg, #ffffff 0%, #f8fafc 55%, #eef2ff 100%)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1
                style={{
                  margin: "0 0 8px 0",
                  fontSize: 30,
                  color: "#111827",
                }}
              >
                מנוע תמחור
              </h1>
              <p style={{ ...mutedTextStyle, margin: 0, maxWidth: 680 }}>
                כאן אפשר ליצור מוצר או שירות, לבחור אותו, ולקבל תמחור ברור:
                עלות מלאה, מחיר מומלץ, רווח כספי ואחוז רווח — בלי להתעסק
                בחישובים מאחורי הקלעים.
              </p>
              {businessContextText && (
                <p style={{ marginTop: 10, color: "#374151", fontWeight: 600 }}>
                  {businessContextText}
                </p>
              )}
            </div>
          </div>
        </div>

        <div
          style={{
            ...cardStyle,
            marginBottom: 20,
            background: "#ffffff",
          }}
        >
          <h2 style={{ margin: "0 0 14px 0", fontSize: 20, color: "#111827" }}>
            פרטי העסק שלך
          </h2>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <InfoBox label="קטגוריה" value={businessProfile?.category || "—"} />
            <InfoBox label="תת קטגוריה" value={businessProfile?.subCategory || "—"} />
            <InfoBox label="מודל עסקי" value={businessModelLabel} />
          </div>
        </div>

        {error && (
          <div
            style={{
              ...cardStyle,
              marginBottom: 20,
              border: "1px solid #fecaca",
              background: "#fef2f2",
              color: "#991b1b",
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 20,
          }}
        >
          <div style={{ display: "grid", gap: 20 }}>
            <div style={cardStyle}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                  marginBottom: 16,
                }}
              >
                <div>
                  <h2 style={sectionTitleStyle}>1. בוחרים או יוצרים פריט</h2>
                  <p style={{ ...mutedTextStyle, margin: 0 }}>
                    אפשר לבחור מוצר או שירות קיים, או ליצור פריט חדש עם ברירות
                    מחדל שיחסכו זמן בחישובים הבאים.
                  </p>
                </div>

                <Pressable
                  onPress={() => {
                    setShowCreateForm((prev) => !prev);
                    setCreateError(null);
                    setCreateSuccess(null);
                  }}
                  style={secondaryButtonStyle}
                >
                  {showCreateForm ? "סגור יצירה" : "צור מוצר / שירות"}
                </Pressable>
              </div>

              {loadingItems && <p style={mutedTextStyle}>טוען מוצרים ושירותים...</p>}

              {!loadingItems && items.length === 0 && (
                <div
                  style={{
                    padding: 16,
                    borderRadius: 14,
                    background: "#f9fafb",
                    border: "1px dashed #d1d5db",
                  }}
                >
                  <p style={{ margin: 0, color: "#374151", fontWeight: 700 }}>
                    עדיין אין מוצרים או שירותים.
                  </p>
                  <p style={{ ...mutedTextStyle, margin: "8px 0 0 0" }}>
                    צור את הפריט הראשון שלך כדי להתחיל לחשב מחיר בצורה פשוטה.
                  </p>
                </div>
              )}

              {items.length > 0 && (
                <>
                  <label style={labelStyle}>בחר מוצר או שירות לתמחור</label>
                  <select
                    value={selectedItemId ?? ""}
                    onChange={(e) =>
                      setSelectedItemId(e.target.value ? Number(e.target.value) : null)
                    }
                    disabled={loadingItems}
                    style={{
                      ...inputStyle,
                      marginBottom: 8,
                    }}
                  >
                    <option value="">בחר...</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <div style={helperStyle}>
                    בחר את הפריט שעליו תרצה להריץ את החישוב. הנתונים שכבר שמורים
                    עליו ישמשו כברירות המחדל שלך.
                  </div>
                </>
              )}
            </div>

            {showCreateForm && (
              <div style={cardStyle}>
                <h2 style={sectionTitleStyle}>{pricingText.createTitle}</h2>
                <p style={{ ...mutedTextStyle, marginTop: 0, marginBottom: 20 }}>
                  {pricingText.createDescription}
                </p>

                {createError && (
                  <div
                    style={{
                      marginBottom: 16,
                      padding: 12,
                      borderRadius: 12,
                      background: "#fef2f2",
                      border: "1px solid #fecaca",
                      color: "#991b1b",
                    }}
                  >
                    {createError}
                  </div>
                )}

                {createSuccess && (
                  <div
                    style={{
                      marginBottom: 16,
                      padding: 12,
                      borderRadius: 12,
                      background: "#f0fdf4",
                      border: "1px solid #bbf7d0",
                      color: "#166534",
                    }}
                  >
                    {createSuccess}
                  </div>
                )}

                <label style={labelStyle}>שם המוצר / השירות</label>
                <input
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 8 }}
                  placeholder="לדוגמה: טיפול פנים / מארז מתנה / תיקון מזגן"
                />
                <div style={helperStyle}>
                  תן שם ברור שתזהה בקלות כשתרצה לחשב שוב את אותו הפריט.
                </div>

                <label style={labelStyle}>סוג הפריט</label>
                <select
                  value={newItemType}
                  onChange={(e) => setNewItemType(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 8 }}
                >
                  <option value="SERVICE">שירות</option>
                  <option value="PRODUCT">מוצר</option>
                </select>
                <div style={helperStyle}>
                  בחר "שירות" אם עיקר העלות הוא זמן עבודה. בחר "מוצר" אם עיקר
                  העלות הוא חומר או קנייה.
                </div>

                <label style={labelStyle}>קטגוריה</label>
                <input
                  value={newItemCategory}
                  onChange={(e) => setNewItemCategory(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 8 }}
                  placeholder="לדוגמה: טיפוח, אוכל, תיקונים, אופנה"
                />
                <div style={helperStyle}>
                  שדה עזר פנימי לסדר וזיהוי. אפשר להשאיר פשוט וברור.
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 14,
                  }}
                >
                  <div>
                    <label style={labelStyle}>
                      {isProduct ? "עלות חומר / קנייה" : "עלות חומרים"}
                    </label>
                    <input
                      type="number"
                      value={newMaterialCost}
                      onChange={(e) => setNewMaterialCost(e.target.value)}
                      style={{ ...inputStyle, marginBottom: 8 }}
                      placeholder="0"
                    />
                    <div style={helperStyle}>{fieldText.material}</div>
                  </div>

                  <div>
                    <label style={labelStyle}>זמן עבודה בדקות</label>
                    <input
                      type="number"
                      value={newLaborMinutes}
                      onChange={(e) => setNewLaborMinutes(e.target.value)}
                      style={{ ...inputStyle, marginBottom: 8 }}
                      placeholder="0"
                    />
                    <div style={helperStyle}>{fieldText.labor}</div>
                  </div>

                  <div>
                    <label style={labelStyle}>עלות לשעה</label>
                    <input
                      type="number"
                      value={newHourlyRate}
                      onChange={(e) => setNewHourlyRate(e.target.value)}
                      style={{ ...inputStyle, marginBottom: 8 }}
                      placeholder="0"
                    />
                    <div style={helperStyle}>
                      כמה שווה לך שעת עבודה אחת. המערכת תשתמש בזה כדי לחשב את
                      עלות העבודה.
                    </div>
                  </div>

                  <div>
                    <label style={labelStyle}>אחוז הוצאות</label>
                    <input
                      type="number"
                      value={newOverheadPercent}
                      onChange={(e) => setNewOverheadPercent(e.target.value)}
                      style={{ ...inputStyle, marginBottom: 8 }}
                      placeholder="10"
                    />
                    <div style={helperStyle}>
                      הוצאות כלליות כמו שכירות, חשמל, משלוחים, ציוד או עלויות
                      קבועות אחרות.
                    </div>
                  </div>
                </div>

                <Pressable
                  onPress={handleCreateItem}
                  disabled={creatingItem}
                  style={{
                    ...buttonStyle,
                    opacity: creatingItem ? 0.7 : 1,
                  }}
                >
                  {creatingItem ? "שומר..." : "שמור מוצר / שירות"}
                </Pressable>
              </div>
            )}
          </div>

          <div style={{ display: "grid", gap: 20 }}>
            <div style={cardStyle}>
              <h2 style={sectionTitleStyle}>2. מחשבים את המחיר</h2>
              <p style={{ ...mutedTextStyle, marginTop: 0, marginBottom: 18 }}>
                אחרי שבחרת פריט, לחץ על הכפתור וקבל תשובה ברורה: כמה זה עולה לך,
                בכמה כדאי למכור, וכמה אתה מרוויח.
              </p>

              {selectedItemName && (
                <div
                  style={{
                    marginBottom: 16,
                    padding: 12,
                    borderRadius: 12,
                    background: "#f8fafc",
                    border: "1px solid #e5e7eb",
                  }}
                >
                  <div style={{ color: "#6b7280", fontSize: 13, marginBottom: 4 }}>
                    פריט נבחר
                  </div>
                  <div style={{ fontWeight: 800, color: "#111827" }}>
                    {selectedItemName}
                  </div>
                </div>
              )}

              <Pressable
                onPress={handleCalculate}
                disabled={!selectedItemId || loadingCalculation}
                style={{
                  ...buttonStyle,
                  width: "100%",
                  opacity: !selectedItemId || loadingCalculation ? 0.6 : 1,
                }}
              >
                {loadingCalculation
                  ? "מחשב..."
                  : !selectedItemId
                  ? "בחר פריט כדי לחשב"
                  : "חשב מחיר"}
              </Pressable>
            </div>

            <div style={cardStyle}>
              <h2 style={sectionTitleStyle}>3. תוצאה</h2>

              {!result && (
                <p style={{ ...mutedTextStyle, margin: 0 }}>
                  כאן תופיע התוצאה המלאה מיד אחרי החישוב — עלות, מחיר מומלץ,
                  רווח, והסבר קצר שיעזור לך להבין את המספרים.
                </p>
              )}

              {result && (
                <>
                  <div
                    style={{
                      ...resultBoxStyle,
                      marginBottom: 14,
                      background: "#eff6ff",
                      border: "1px solid #bfdbfe",
                    }}
                  >
                    <div style={{ color: "#475569", fontSize: 13 }}>
                      מחיר מומלץ למכירה
                    </div>
                    <div style={highlightValueStyle}>
                      ₪ {result.priceOptions.recommended}
                    </div>
                  </div>

                  {calculationInsight && (
                    <div
                      style={{
                        marginBottom: 14,
                        background: "#f8fafc",
                        border: "1px solid #e5e7eb",
                        borderRadius: 14,
                        padding: 14,
                      }}
                    >
                      <h4 style={{ marginTop: 0, marginBottom: 8 }}>
                        {calculationInsight.title}
                      </h4>
                      <p style={{ margin: 0, color: "#374151", lineHeight: 1.8 }}>
                        {calculationInsight.text}
                      </p>
                    </div>
                  )}

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                      gap: 12,
                      marginBottom: 18,
                    }}
                  >
                    <div style={resultBoxStyle}>
                      <h4 style={{ marginTop: 0, marginBottom: 10 }}>עלות מלאה</h4>
                      <p style={{ margin: 0, fontWeight: 800, fontSize: 22 }}>
                        ₪ {result.costBreakdown.fullCost}
                      </p>
                      <p style={{ ...mutedTextStyle, margin: "10px 0 0 0" }}>
                        כולל חומרים, עבודה והוצאות כלליות.
                      </p>
                    </div>

                    <div style={resultBoxStyle}>
                      <h4 style={{ marginTop: 0, marginBottom: 10 }}>רווח משוער</h4>
                      <p style={{ margin: 0, fontWeight: 800, fontSize: 22 }}>
                        ₪ {result.profit.amount}
                      </p>
                      <p style={{ ...mutedTextStyle, margin: "10px 0 0 0" }}>
                        אחוז רווח: {result.profit.percent}% · מצב:{" "}
                        <strong>{result.profit.label}</strong>
                      </p>
                    </div>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                      gap: 12,
                      marginBottom: 18,
                    }}
                  >
                    <div style={resultBoxStyle}>
                      <h4 style={{ marginTop: 0, marginBottom: 10 }}>פירוט עלויות</h4>
                      <p style={{ margin: "0 0 8px 0" }}>
                        עלות חומרים: ₪ {result.costBreakdown.materialCost}
                      </p>
                      <p style={{ margin: "0 0 8px 0" }}>
                        עלות עבודה: ₪ {result.costBreakdown.laborCost}
                      </p>
                      <p style={{ margin: "0 0 8px 0" }}>
                        עלות ישירה: ₪ {result.costBreakdown.directCost}
                      </p>
                      <p style={{ margin: 0 }}>
                        הוצאות כלליות: ₪ {result.costBreakdown.overheadCost}
                      </p>
                    </div>

                    <div style={resultBoxStyle}>
                      <h4 style={{ marginTop: 0, marginBottom: 10 }}>
                        טווחי מחיר
                      </h4>
                      <p style={{ margin: "0 0 8px 0" }}>
                        מחיר מינימום: ₪ {result.priceOptions.minimum}
                      </p>
                      <p
                        style={{
                          margin: "0 0 8px 0",
                          fontWeight: 700,
                          color: "#2563eb",
                        }}
                      >
                        מחיר מומלץ: ₪ {result.priceOptions.recommended}
                      </p>
                      <p style={{ margin: 0 }}>
                        מחיר פרימיום: ₪ {result.priceOptions.premium}
                      </p>
                    </div>
                  </div>

                  <div
                    style={{
                      background: "#f8fafc",
                      border: "1px solid #e5e7eb",
                      borderRadius: 14,
                      padding: 14,
                    }}
                  >
                    <h4 style={{ marginTop: 0, marginBottom: 10 }}>הסבר פשוט</h4>
                    <p style={{ margin: 0, color: "#374151", lineHeight: 1.8 }}>
                      {result.explanation}
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const pressableBaseStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  userSelect: "none",
  WebkitTapHighlightColor: "transparent",
  touchAction: "manipulation",
  fontFamily: "inherit",
  position: "relative",
  zIndex: 1,
  pointerEvents: "auto",
  boxSizing: "border-box",
};

const disabledPressableStyle: React.CSSProperties = {
  opacity: 0.6,
  cursor: "not-allowed",
};