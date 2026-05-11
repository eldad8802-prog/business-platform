"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type PricingItem = {
  id: number;
  name: string;
  defaultMaterialCost: number;
  defaultLaborMinutes: number;
  defaultHourlyRate: number;
  defaultOverheadPercent: number;
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
  transparency?: {
    cost: {
      total: number;
      breakdown: {
        materials: number;
        labor: number;
        overhead: number;
      };
    };
    priceOptions: {
      minimum: number;
      recommended: number;
      premium: number;
    };
    profit: {
      value: number;
      percent: number;
    };
    breakEven: {
      price: number;
    };
    simulations: {
      minimum: {
        price: number;
        profitValue: number;
        profitPercent: number;
      };
      recommended: {
        price: number;
        profitValue: number;
        profitPercent: number;
      };
      premium: {
        price: number;
        profitValue: number;
        profitPercent: number;
      };
    };
    market:
      | null
      | {
          low: number;
          high: number;
          status: string;
          positionRatio: number | null;
        };
    insights: string[];
  };
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

export default function PricingPage() {
  const router = useRouter();

  const [token, setToken] = useState<string | null>(null);
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile | null>(null);

  const [items, setItems] = useState<PricingItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [showTransparencyDetails, setShowTransparencyDetails] = useState(false);

  const [bootLoading, setBootLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingCalculation, setLoadingCalculation] = useState(false);
  const [creatingItem, setCreatingItem] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  const [calcMaterialCost, setCalcMaterialCost] = useState("");
  const [calcLaborMinutes, setCalcLaborMinutes] = useState("");
  const [calcHourlyRate, setCalcHourlyRate] = useState("");
  const [calcOverheadPercent, setCalcOverheadPercent] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [activePanel, setActivePanel] = useState<"home" | "calculate" | "create">(
    "home"
  );

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
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [activePanel]);

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

      const raw = Array.isArray(data.profiles) ? data.profiles : [];
      const nextItems: PricingItem[] = raw.map((p: Record<string, unknown>) => ({
        id: Number(p.id),
        name: String(p.name ?? ""),
        defaultMaterialCost: Number(p.defaultMaterialCost ?? 0),
        defaultLaborMinutes: Number(p.defaultLaborMinutes ?? 0),
        defaultHourlyRate: Number(p.defaultHourlyRate ?? 0),
        defaultOverheadPercent: Number(p.defaultOverheadPercent ?? 10),
      }));
      setItems(nextItems);
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

  useEffect(() => {
    const item = items.find((i) => i.id === selectedItemId);
    if (!item) {
      setCalcMaterialCost("");
      setCalcLaborMinutes("");
      setCalcHourlyRate("");
      setCalcOverheadPercent("");
      return;
    }
    setCalcMaterialCost(String(item.defaultMaterialCost ?? ""));
    setCalcLaborMinutes(String(item.defaultLaborMinutes ?? ""));
    setCalcHourlyRate(String(item.defaultHourlyRate ?? ""));
    setCalcOverheadPercent(String(item.defaultOverheadPercent ?? ""));
  }, [selectedItemId, items]);

  const handlePricingItemSelect = (nextId: number | null) => {
    setSelectedItemId((prev) => {
      if (prev !== nextId) {
        setResult(null);
        setShowTransparencyDetails(false);
      }
      return nextId;
    });
  };

  const handleSaveProfileDefaults = async () => {
    if (!selectedItemId || !token) return;

    try {
      setSavingProfile(true);
      setError(null);

      const res = await fetch(`/api/pricing/profiles/${selectedItemId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          defaultMaterialCost: Number(calcMaterialCost || 0),
          defaultLaborMinutes: Number(calcLaborMinutes || 0),
          defaultHourlyRate: Number(calcHourlyRate || 0),
          defaultOverheadPercent: Number(calcOverheadPercent || 0),
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
        throw new Error(data?.error || "שגיאה בשמירת הנתונים");
      }

      await loadItems(token);
    } catch (err) {
      console.error("Failed to save pricing profile:", err);
      setError(err instanceof Error ? err.message : "שגיאה בשמירת הנתונים");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleCalculate = async () => {
    if (!selectedItemId || !token) return;

    try {
      setLoadingCalculation(true);
      setError(null);
      setResult(null);
      setShowTransparencyDetails(false);

      const res = await fetch("/api/pricing/calculate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          pricingProfileId: selectedItemId,
          materialCost: Number(calcMaterialCost || 0),
          laborMinutes: Number(calcLaborMinutes || 0),
          hourlyRate: Number(calcHourlyRate || 0),
          overheadPercent: Number(calcOverheadPercent || 0),
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

  const homeHeroLeadText = useMemo(() => {
    if (result) {
      return "יש תוצאת חישוב בסשן הנוכחי — אפשר לפתוח חישוב מחדש או להוסיף פריט למטה.";
    }
    return "מה תרצו לעשות? חישוב מהיר של מחיר מומלץ ורווח — בלי סיבוכים.";
  }, [result]);

  const pricingText = useMemo(() => {
    if (!businessProfile?.businessModel) {
      return {
        createTitle: "מוסיפים משהו חדש לתמחור",
        createDescription: "כמה פרטים קטנים, ותוכל לראות עלות, מחיר ורווח בצורה ברורה.",
      };
    }

    if (businessProfile.businessModel === "service") {
      return {
        createTitle: "מוסיפים שירות לתמחור",
        createDescription:
          "בשירותים, הזמן שלך הוא חלק גדול מהעלות. נכתוב כאן כמה זמן זה לוקח וכמה שעת עבודה שווה לך.",
      };
    }

    if (businessProfile.businessModel === "product") {
      return {
        createTitle: "מוסיפים מוצר לתמחור",
        createDescription:
          "במוצרים, העלות היא בדרך כלל חומר/קנייה. נכתוב כאן כמה זה עולה לך לפני שמוכרים.",
      };
    }

    return {
      createTitle: "מוסיפים מוצר / שירות לתמחור",
      createDescription:
        "נכתוב כאן את העלות והזמן בצורה פשוטה, כדי לראות מחיר ורווח בלי ניחושים.",
    };
  }, [businessProfile]);

  const fieldText = useMemo(() => {
    if (!businessProfile?.businessModel) {
      return {
        material:
          "זה כמה עולה לך החומר/קנייה לכל יחידה. לדוגמה: אם קנית ב־50₪ — זה המספר.",
        labor:
          "זה הזמן שנדרש כדי להכין/לבצע את העבודה. לדוגמה: אם זה שעה — 60 דקות.",
      };
    }

    if (businessProfile.businessModel === "service") {
      return {
        material:
          "זה עלות החומרים שנצרכים במהלך השירות. לדוגמה: חומרים ב־20₪ — זה המספר.",
        labor:
          "זה הזמן שלוקח לבצע את השירות בפועל. לדוגמה: 45 דקות — רשום 45.",
      };
    }

    if (businessProfile.businessModel === "product") {
      return {
        material:
          "זה כמה עולה לך לקנות/לייצר יחידה אחת. לדוגמה: עלות ליחידה 35₪ — זה המספר.",
        labor:
          "אם יש זמן בהכנה/אריזה, זה המקום. לדוגמה: 10 דקות אריזה — רשום 10.",
      };
    }

    return {
      material:
        "זה כמה עולה לך החומר/קנייה לכל יחידה. לדוגמה: אם זה 12₪ — רשום 12.",
      labor:
        "זה הזמן שלוקח לבצע/להכין. לדוגמה: חצי שעה — 30 דקות.",
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

  const decisionTip = useMemo(() => {
    if (!result) return null;

    const roundTo2 = (value: number) => Math.round(value * 100) / 100;
    const fullCost = Number(result.costBreakdown.fullCost || 0);
    const materialCost = Number(result.costBreakdown.materialCost || 0);
    const laborCost = Number(result.costBreakdown.laborCost || 0);
    const overheadCost = Number(result.costBreakdown.overheadCost || 0);

    const recommendedPrice = Number(result.priceOptions.recommended || 0);

    const totalForShare = fullCost > 0 ? fullCost : 1;
    const materialShare = materialCost / totalForShare;
    const laborShare = laborCost / totalForShare;
    const overheadShare = overheadCost / totalForShare;

    const sims = result.transparency?.simulations;
    const minSim = sims?.minimum;
    const recSim = sims?.recommended;
    const premSim = sims?.premium;

    // 1) הגנה ממינימום כשמינימום יוצא הפסד
    if (minSim && minSim.profitValue < 0) {
      const delta = roundTo2(Math.abs(minSim.profitValue));
      return {
        kind: "floor" as const,
        title: "טיפ להגנה על הרווחיות",
        body: `במחיר מינימום אתה עלול להפסיד בערך ₪ ${delta}. שמור על הגבול התחתון (העלות המלאה) כקו אדום.`,
        deltaLabel: `הימנעות מהפסד: ₪ ${delta}`,
      };
    }

    // 2) זמן/עבודה אם העבודה דומיננטית
    if (laborShare >= 0.45 && laborCost > 0) {
      const delta = roundTo2(Math.max(1, laborCost * 0.1));
      return {
        kind: "labor" as const,
        title: "טיפ לשיפור רווחיות דרך זמן",
        body: `אם תקצר את זמן העבודה בכ־10% (שווה ערך ל־₪ ${delta}) — הרווח לעסקה יגדל בערך באותו סכום.`,
        deltaLabel: `רווח נוסף אפשרי: ₪ ${delta}`,
      };
    }

    // 3) חומרים אם החומר דומיננטי
    if (materialShare >= 0.45 && materialCost > 0) {
      const delta = roundTo2(Math.max(1, materialCost * 0.1));
      return {
        kind: "materials" as const,
        title: "טיפ לשיפור רווחיות דרך חומרים",
        body: `אם תצליח להוריד את עלות החומרים בכ־10% (₪ ${delta}) — הרווח לעסקה יגדל בערך באותו סכום.`,
        deltaLabel: `רווח נוסף אפשרי: ₪ ${delta}`,
      };
    }

    // 4) הוצאות כלליות כשזה רכיב משמעותי
    if (overheadShare >= 0.25 && overheadCost > 0) {
      const delta = roundTo2(Math.max(1, overheadCost * 0.1));
      return {
        kind: "overhead" as const,
        title: "טיפ לשיפור רווחיות דרך הוצאות כלליות",
        body: `אם תצליח לצמצם הוצאות כלליות בכ־10% (₪ ${delta}) — הרווח לעסקה יגדל בערך באותו סכום.`,
        deltaLabel: `רווח נוסף אפשרי: ₪ ${delta}`,
      };
    }

    // 5) מחיר — רק אם השדרוג לפרימיום משמעותי יחסית
    if (premSim && recSim) {
      const delta = roundTo2(premSim.profitValue - recSim.profitValue);
      const threshold = roundTo2(
        Math.max(10, Math.abs((result.profit.amount || 0) * 0.15))
      );

      if (delta >= threshold) {
        return {
          kind: "price" as const,
          title: "טיפ לשיפור רווחיות דרך מחיר",
          body: `אם תתקרב למחיר פרימיום (₪ ${premSim.price}) במקום מומלץ (₪ ${recommendedPrice}) — הרווח לעסקה יגדל בערך ב־₪ ${delta}.`,
          deltaLabel: `רווח נוסף אפשרי: ₪ ${delta}`,
        };
      }
    }

    // 6) ברירת מחדל: עלות כללית
    const delta = roundTo2(Math.max(1, fullCost * 0.05));
    return {
      kind: "cost" as const,
      title: "טיפ קטן שעושה הבדל",
      body: `כל ₪ 1 שיורד מהעלות המלאה נכנס כמעט ישירות לרווח. אם תוריד עלות מלאה בכ־₪ ${delta} — הרווח לעסקה יגדל בערך באותו סכום.`,
      deltaLabel: `רווח נוסף אפשרי: ₪ ${delta}`,
    };
  }, [result]);

  const marketStatusLabel = useMemo(() => {
    const status = result?.transparency?.market?.status;
    if (status === "BELOW_MARKET") return "מתחת לטווח שהוזן";
    if (status === "WITHIN_MARKET") return "בתוך הטווח שהוזן";
    if (status === "ABOVE_MARKET") return "מעל הטווח שהוזן";
    return "אין מספיק נתוני שוק";
  }, [result?.transparency?.market?.status]);

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
    minHeight: 48,
    padding: "12px 14px",
    marginBottom: 16,
    border: "1px solid #d1d5db",
    borderRadius: 12,
    outline: "none",
    fontSize: 16,
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

  const successButtonStyle: React.CSSProperties = {
    minHeight: 52,
    padding: "14px 18px",
    borderRadius: 14,
    border: "1px solid #15803d",
    background: "#16a34a",
    color: "#ffffff",
    fontWeight: 700,
    fontSize: 15,
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

  const hubCardStyle: React.CSSProperties = {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 22,
    padding: 22,
    boxShadow: "0 12px 32px rgba(15, 23, 42, 0.08)",
  };

  const hubActionCardStyle: React.CSSProperties = {
    ...hubCardStyle,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    boxSizing: "border-box",
    padding: "clamp(16px, 4vw, 22px)",
  };

  const subPanelNavStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-start",
    alignItems: "center",
    marginBottom: 12,
    paddingInline: "clamp(4px, 2vw, 12px)",
    paddingTop: 2,
  };

  const backChipStyle: React.CSSProperties = {
    ...secondaryButtonStyle,
    minHeight: 48,
    minWidth: 48,
    padding: "12px 20px",
    borderRadius: 999,
    fontSize: 15,
    width: "auto",
    boxSizing: "border-box",
  };

  const goHome = () => {
    setActivePanel("home");
    setShowCreateForm(false);
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
      className="pricing-page-root"
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        direction: "rtl",
        padding:
          "clamp(16px, 4vw, 28px) clamp(14px, 5vw, 22px) clamp(28px, 7vw, 48px)",
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 1120, margin: "0 auto", width: "100%" }}>
        <style
          dangerouslySetInnerHTML={{
            __html: `@keyframes pricingPanelEnter {
              from { opacity: 0; transform: translateY(8px); }
              to { opacity: 1; transform: translateY(0); }
            }
            details.pricing-calc-details > summary::-webkit-details-marker {
              display: none;
            }
            details.pricing-calc-details > summary {
              list-style: none;
              min-height: 48px;
              padding: 10px 8px 10px 0;
              align-items: center;
              display: flex;
              touch-action: manipulation;
              -webkit-tap-highlight-color: transparent;
            }
            .pricing-page-root .pricing-long-text {
              overflow-wrap: anywhere;
              word-break: break-word;
            }`,
          }}
        />
        {(activePanel === "home" ||
          activePanel === "calculate" ||
          activePanel === "create") && (
          <div style={subPanelNavStyle}>
            <Pressable
              onPress={() => {
                if (activePanel === "home") {
                  router.push("/");
                  return;
                }
                goHome();
              }}
              style={backChipStyle}
            >
              חזרה
            </Pressable>
          </div>
        )}
        <div
          key={activePanel}
          style={{
            animation: "pricingPanelEnter 175ms ease-out both",
          }}
        >
        {activePanel === "home" && (
        <div style={{ marginBottom: "clamp(20px, 5vw, 32px)" }}>
          <div
            style={{
              borderRadius: "clamp(18px, 4vw, 24px)",
              padding: "clamp(18px, 4.5vw, 38px)",
              background:
                "linear-gradient(135deg, #0f172a 0%, #1e293b 48%, #0f766e 100%)",
              boxShadow: "0 14px 36px rgba(15, 23, 42, 0.22)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
            }}
          >
            <p
              style={{
                margin: 0,
                color: "rgba(52, 211, 153, 0.95)",
                fontWeight: 700,
                fontSize: 12,
                letterSpacing: "0.06em",
              }}
            >
              תמחור
            </p>
            <h1
              style={{
                margin: "8px 0 10px 0",
                fontSize: "clamp(22px, 5.5vw, 40px)",
                color: "#f8fafc",
                letterSpacing: "-0.03em",
                lineHeight: 1.15,
                fontWeight: 800,
              }}
            >
              תמחור שמבינים בשנייה
            </h1>
            <p
              className="pricing-long-text"
              style={{
                margin: 0,
                maxWidth: 560,
                color: "rgba(248, 250, 252, 0.9)",
                fontSize: "clamp(14px, 3.8vw, 16px)",
                lineHeight: 1.55,
              }}
            >
              {homeHeroLeadText}
            </p>
          </div>

          {result && (
            <div
              style={{
                marginTop: 12,
                padding: "clamp(10px, 3vw, 14px)",
                borderRadius: 14,
                background: "#ffffff",
                border: "1px solid rgba(15, 118, 110, 0.18)",
                boxShadow: "0 8px 22px rgba(15, 23, 42, 0.06)",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: "1 1 140px" }}>
                <div
                  className="pricing-long-text"
                  style={{ fontSize: 11, color: "#64748b", marginBottom: 4, fontWeight: 600, lineHeight: 1.35 }}
                >
                  תוצאה בסשן (לא נשמרת כהיסטוריה)
                </div>
                <div style={{ fontWeight: 700, color: "#0f172a", fontSize: 14 }}>
                  {selectedItemName ? `${selectedItemName}` : "חישוב אחרון"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>מומלץ</div>
                  <div style={{ fontWeight: 800, fontSize: 17, color: "#0f766e" }}>
                    ₪ {result.priceOptions.recommended}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>רווח</div>
                  <div style={{ fontWeight: 800, fontSize: 17, color: "#111827" }}>
                    ₪ {result.profit.amount}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div
            style={{
              marginTop: "clamp(14px, 4vw, 18px)",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
              gap: "clamp(12px, 3vw, 14px)",
            }}
          >
            <div style={hubActionCardStyle}>
              <h2 style={{ margin: "0 0 6px 0", fontSize: "clamp(17px, 4vw, 18px)", color: "#111827" }}>
                חשב מחיר
              </h2>
              <p style={{ ...mutedTextStyle, margin: "0 0 12px 0", flex: 1, fontSize: 14, lineHeight: 1.5 }}>
                בוחרים פריט, מתקנים נתונים במידת הצורך, ומקבלים מחיר ורווח.
              </p>
              <Pressable
                onPress={() => {
                  setActivePanel("calculate");
                  setShowCreateForm(false);
                }}
                style={{
                  ...buttonStyle,
                  marginTop: "auto",
                  width: "100%",
                  minHeight: 48,
                  borderRadius: 14,
                  fontSize: 15,
                }}
              >
                חשב מחיר
              </Pressable>
            </div>

            <div style={hubActionCardStyle}>
              <h2 style={{ margin: "0 0 6px 0", fontSize: "clamp(17px, 4vw, 18px)", color: "#111827" }}>
                הוסף מוצר או שירות
              </h2>
              <p style={{ ...mutedTextStyle, margin: "0 0 12px 0", flex: 1, fontSize: 14, lineHeight: 1.5 }}>
                שם ונתוני עלות בסיסיים — יישמרו לפעם הבאה.
              </p>
              <Pressable
                onPress={() => {
                  setActivePanel("create");
                  setShowCreateForm(true);
                  setCreateError(null);
                  setCreateSuccess(null);
                }}
                style={{
                  ...secondaryButtonStyle,
                  marginTop: "auto",
                  width: "100%",
                  minHeight: 48,
                  borderRadius: 14,
                  fontSize: 15,
                }}
              >
                הוסף לרשימה
              </Pressable>
            </div>
          </div>
        </div>
        )}

        {error && (
          <div
            style={{
              ...cardStyle,
              marginBottom: 24,
              border: "1px solid #fecaca",
              background: "#fef2f2",
              borderRadius: 20,
              padding: 20,
            }}
          >
            <div
              style={{
                fontWeight: 800,
                color: "#991b1b",
                marginBottom: 8,
                fontSize: 16,
              }}
            >
              לא הצלחנו להשלים את הפעולה
            </div>
            <p style={{ margin: 0, color: "#b91c1c", lineHeight: 1.65, fontSize: 15 }}>
              {error}
            </p>
          </div>
        )}

        {activePanel === "calculate" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))",
            gap: "clamp(12px, 3vw, 16px)",
            alignItems: "start",
          }}
        >
            <div
              style={{
                ...cardStyle,
                borderRadius: "clamp(16px, 3vw, 20px)",
                padding: "clamp(14px, 4vw, 18px)",
              }}
            >
              <h2 style={{ ...sectionTitleStyle, fontSize: "clamp(18px, 4.5vw, 20px)" }}>
                חישוב מחיר
              </h2>
              <p
                className="pricing-long-text"
                style={{ ...mutedTextStyle, margin: "0 0 12px 0", fontSize: 14, lineHeight: 1.5 }}
              >
                בוחרים פריט, מתאימים מספרים, ומחשבים — בלי ליצור פריט מחדש.
              </p>

              {loadingItems && (
                <div
                  style={{
                    padding: 14,
                    borderRadius: 14,
                    background: "#f1f5f9",
                    border: "1px solid #e2e8f0",
                  }}
                >
                  <p style={{ margin: 0, color: "#475569", fontSize: 14, lineHeight: 1.6 }}>
                    טוען רשימה…
                  </p>
                </div>
              )}

              {!loadingItems && items.length === 0 && (
                <div
                  style={{
                    padding: 16,
                    borderRadius: 14,
                    background: "#f8fafc",
                    border: "1px dashed #cbd5e1",
                  }}
                >
                  <p style={{ margin: 0, color: "#334155", fontWeight: 800, fontSize: 15 }}>
                    עדיין אין פריטים
                  </p>
                  <p style={{ ...mutedTextStyle, margin: "8px 0 0 0", fontSize: 14 }}>
                    הוסיפו פריט ממסך הבית וחזרו לכאן.
                  </p>
                </div>
              )}

              {items.length > 0 && (
                <>
                  <label style={{ ...labelStyle, marginBottom: 6, fontSize: 13 }}>פריט</label>
                  <select
                    value={selectedItemId ?? ""}
                    onChange={(e) =>
                      handlePricingItemSelect(
                        e.target.value ? Number(e.target.value) : null
                      )
                    }
                    disabled={loadingItems}
                    style={{
                      ...inputStyle,
                      marginBottom: 12,
                      padding: "12px 14px",
                      fontSize: 16,
                    }}
                  >
                    <option value="">בחרו פריט…</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  marginTop: items.length > 0 ? 4 : 0,
                  marginBottom: items.length > 0 && selectedItemId ? 12 : 0,
                }}
              >
                <Pressable
                  onPress={handleCalculate}
                  disabled={!selectedItemId || loadingCalculation}
                  style={{
                    ...buttonStyle,
                    width: "100%",
                    minHeight: 52,
                    borderRadius: 14,
                    fontSize: 16,
                    opacity: !selectedItemId || loadingCalculation ? 0.55 : 1,
                  }}
                >
                  {loadingCalculation
                    ? "מחשב..."
                    : !selectedItemId
                    ? "בחרו פריט כדי לחשב"
                    : "חשב מחיר"}
                </Pressable>
                <Pressable
                  onPress={handleSaveProfileDefaults}
                  disabled={!selectedItemId || savingProfile}
                  style={{
                    ...secondaryButtonStyle,
                    width: "100%",
                    minHeight: 48,
                    borderRadius: 14,
                    fontSize: 15,
                    opacity: !selectedItemId || savingProfile ? 0.55 : 1,
                  }}
                >
                  {savingProfile ? "שומר…" : "שמור נתונים לפריט"}
                </Pressable>
              </div>

              {items.length > 0 && selectedItemId && (
                <details
                  className="pricing-calc-details"
                  style={{
                    marginBottom: 0,
                    border: "1px solid #e5e7eb",
                    borderRadius: 14,
                    padding: "10px 14px 14px",
                    background: "#fafafa",
                  }}
                >
                  <summary
                    style={{
                      cursor: "pointer",
                      fontWeight: 700,
                      color: "#111827",
                      fontSize: 15,
                    }}
                  >
                    התאמת עלות וזמן (אופציונלי)
                  </summary>
                  <p
                    className="pricing-long-text"
                    style={{ ...mutedTextStyle, margin: "10px 0 12px 0", fontSize: 13 }}
                  >
                    השדות משפיעים על החישוב מיד. ״שמירה לפריט״ מעדכנת את ברירת המחדל
                    לפעם הבאה.
                  </p>
                  <div style={{ display: "grid", gap: "clamp(10px, 3vw, 14px)" }}>
                    <div style={{ ...resultBoxStyle, padding: "12px 14px" }}>
                      <label style={{ ...labelStyle, marginBottom: 6, fontSize: 13 }}>
                        חומרים / קנייה (₪)
                      </label>
                      <input
                        type="number"
                        inputMode="decimal"
                        value={calcMaterialCost}
                        onChange={(e) => setCalcMaterialCost(e.target.value)}
                        style={{ ...inputStyle, marginBottom: 6 }}
                        placeholder="0"
                      />
                      <div style={{ ...helperStyle, marginBottom: 0, fontSize: 12 }}>
                        {fieldText.material}
                      </div>
                    </div>
                    <div style={{ ...resultBoxStyle, padding: "12px 14px" }}>
                      <label style={{ ...labelStyle, marginBottom: 6, fontSize: 13 }}>
                        זמן (דקות)
                      </label>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={calcLaborMinutes}
                        onChange={(e) => setCalcLaborMinutes(e.target.value)}
                        style={{ ...inputStyle, marginBottom: 6 }}
                        placeholder="0"
                      />
                      <div style={{ ...helperStyle, marginBottom: 0, fontSize: 12 }}>
                        {fieldText.labor}
                      </div>
                    </div>
                    <div style={{ ...resultBoxStyle, padding: "12px 14px" }}>
                      <label style={{ ...labelStyle, marginBottom: 6, fontSize: 13 }}>
                        שווי שעה (₪)
                      </label>
                      <input
                        type="number"
                        inputMode="decimal"
                        value={calcHourlyRate}
                        onChange={(e) => setCalcHourlyRate(e.target.value)}
                        style={{ ...inputStyle, marginBottom: 6 }}
                        placeholder="0"
                      />
                    </div>
                    <div style={{ ...resultBoxStyle, padding: "12px 14px" }}>
                      <label style={{ ...labelStyle, marginBottom: 6, fontSize: 13 }}>
                        הוצאות כלליות (%)
                      </label>
                      <input
                        type="number"
                        inputMode="decimal"
                        value={calcOverheadPercent}
                        onChange={(e) => setCalcOverheadPercent(e.target.value)}
                        style={{ ...inputStyle, marginBottom: 0 }}
                        placeholder="10"
                      />
                    </div>
                  </div>
                </details>
              )}
            </div>

            <div
              style={{
                ...cardStyle,
                borderRadius: "clamp(16px, 3vw, 20px)",
                padding: "clamp(14px, 4vw, 18px)",
              }}
            >
              <h2 style={{ ...sectionTitleStyle, fontSize: "clamp(18px, 4.5vw, 20px)" }}>
                תוצאה
              </h2>

              {!result && (
                <p
                  className="pricing-long-text"
                  style={{ ...mutedTextStyle, margin: 0, fontSize: 14, lineHeight: 1.5 }}
                >
                  אחרי חישוב תראו כאן כמה לגבות, כמה נשאר לכם, ואיפה קו האדום — בלי כפילויות.
                </p>
              )}

              {result && (
                <>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      marginBottom: 12,
                    }}
                  >
                    <div
                      style={{
                        ...resultBoxStyle,
                        background: "#eff6ff",
                        border: "1px solid #bfdbfe",
                        padding: "clamp(12px, 3.5vw, 14px)",
                      }}
                    >
                      <div style={{ color: "#475569", fontSize: 12, fontWeight: 600 }}>
                        כמה לגבות (מומלץ)
                      </div>
                      <div
                        style={{
                          ...highlightValueStyle,
                          fontSize: "clamp(22px, 6vw, 28px)",
                          marginTop: 4,
                          lineHeight: 1.15,
                        }}
                      >
                        ₪ {result.priceOptions.recommended}
                      </div>
                    </div>
                    <div
                      style={{
                        ...resultBoxStyle,
                        padding: "clamp(12px, 3.5vw, 14px)",
                      }}
                    >
                      <div style={{ color: "#475569", fontSize: 12, fontWeight: 600 }}>
                        כמה מרוויחים (במומלץ)
                      </div>
                      <div
                        style={{
                          fontSize: "clamp(22px, 6vw, 26px)",
                          fontWeight: 800,
                          color: "#111827",
                          marginTop: 4,
                          lineHeight: 1.15,
                        }}
                      >
                        ₪ {result.profit.amount}
                      </div>
                      <div style={{ ...mutedTextStyle, marginTop: 6, fontSize: 12 }}>
                        {result.profit.percent}% מהמחיר למכירה
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      ...resultBoxStyle,
                      border: "1px solid #fecaca",
                      background: "#fffafa",
                      padding: "clamp(12px, 3.5vw, 14px)",
                      marginBottom: 12,
                    }}
                  >
                    <div
                      style={{
                        fontSize: "clamp(12px, 3.5vw, 13px)",
                        fontWeight: 800,
                        color: "#991b1b",
                        marginBottom: 8,
                        lineHeight: 1.35,
                      }}
                    >
                      קו אדום — אל תמכרו מתחת בלי שתדעו למה
                    </div>
                    <p
                      className="pricing-long-text"
                      style={{
                        margin: "0 0 10px 0",
                        color: "#374151",
                        fontSize: 14,
                        lineHeight: 1.55,
                      }}
                    >
                      <strong>עלות מלאה (פריצה):</strong> ₪ {result.costBreakdown.fullCost}
                      <span style={{ color: "#6b7280" }}>
                        {" "}
                        — מתחת לזה מכירה מכסה פחות מהעלות הכוללת שלך.
                      </span>
                    </p>
                    <p
                      className="pricing-long-text"
                      style={{ margin: 0, color: "#374151", fontSize: 14, lineHeight: 1.55 }}
                    >
                      <strong>רצפת מחיר נמוכה (לפי המודל):</strong> ₪{" "}
                      {result.priceOptions.minimum}
                      <span style={{ color: "#6b7280" }}>
                        {" "}
                        — זה המינימום שהחישוב מתחשב בו לפני המומלץ; לא אותו דבר כמו עלות מלאה.
                      </span>
                    </p>
                  </div>

                  {decisionTip && (
                    <div
                      style={{
                        ...resultBoxStyle,
                        marginBottom: 14,
                        background: "#ffffff",
                        border: "1px solid rgba(15, 118, 110, 0.22)",
                      }}
                    >
                      <h4 style={{ marginTop: 0, marginBottom: 8, fontSize: 15 }}>{decisionTip.title}</h4>
                      <p
                        className="pricing-long-text"
                        style={{ margin: "0 0 10px 0", color: "#0f172a", lineHeight: 1.65, fontSize: 14 }}
                      >
                        {decisionTip.body}
                      </p>
                      <p style={{ margin: 0, color: "#0f766e", fontWeight: 800 }}>
                        {decisionTip.deltaLabel}
                      </p>
                    </div>
                  )}

                  <div style={{ marginBottom: 12 }}>
                    <Pressable
                      onPress={() => setShowTransparencyDetails((prev) => !prev)}
                      style={{
                        ...secondaryButtonStyle,
                        width: "100%",
                        minHeight: 48,
                        borderRadius: 14,
                        fontSize: 15,
                      }}
                    >
                      {showTransparencyDetails ? "הסתר פירוט נוסף" : "פירוט נוסף (עלויות והסבר)"}
                    </Pressable>
                  </div>

                  {showTransparencyDetails === true && (
                    <div
                      style={{
                        background: "#ffffff",
                        border: "1px solid #e5e7eb",
                        borderRadius: 14,
                        padding: 14,
                        marginBottom: 18,
                      }}
                    >
                      {calculationInsight && (
                        <div
                          style={{
                            marginBottom: 12,
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

                      <div style={{ ...resultBoxStyle, marginBottom: 12 }}>
                        <h4 style={{ marginTop: 0, marginBottom: 10 }}>פירוט עלויות</h4>
                        <p style={{ margin: "0 0 8px 0" }}>
                          עלות חומרים (מה שנצרך/נקנה): ₪ {result.costBreakdown.materialCost}
                        </p>
                        <p style={{ margin: "0 0 8px 0" }}>
                          עלות עבודה (זמן * שווי שעה): ₪ {result.costBreakdown.laborCost}
                        </p>
                        <p style={{ margin: "0 0 8px 0" }}>
                          עלות ישירה (חומרים + עבודה): ₪ {result.costBreakdown.directCost}
                        </p>
                        <p style={{ margin: 0 }}>
                          הוצאות כלליות (אחוז מהעלות): ₪ {result.costBreakdown.overheadCost}
                        </p>
                      </div>
                      <p style={{ ...mutedTextStyle, margin: "0 0 12px 0", fontSize: 13 }}>
                        שלוש רמות המחיר (מינימום / מומלץ / פרימיום) מופיעות בתקציר למעלה; כאן רק
                        הפירוט החישובי.
                      </p>

                      {result.transparency && (
                        <div style={{ marginBottom: 12 }}>
                          <h4 style={{ marginTop: 0, marginBottom: 12 }}>שקיפות תמחור</h4>

                          {result.transparency.market && (
                            <div style={{ ...resultBoxStyle, marginBottom: 12 }}>
                              <h4 style={{ marginTop: 0, marginBottom: 10 }}>מיקום שוק</h4>
                              <p style={{ margin: "0 0 8px 0" }}>
                                טווח שוק: ₪ {result.transparency.market.low} – ₪{" "}
                                {result.transparency.market.high}
                              </p>
                              <p style={{ margin: "0 0 8px 0" }}>
                                סטטוס: {marketStatusLabel}
                              </p>
                              <p style={{ margin: 0 }}>
                                יחס מיקום:{" "}
                                {result.transparency.market.positionRatio === null
                                  ? "—"
                                  : result.transparency.market.positionRatio}
                              </p>
                            </div>
                          )}

                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns:
                                "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
                              gap: 12,
                              marginBottom: 12,
                            }}
                          >
                            <div style={resultBoxStyle}>
                              <h4 style={{ marginTop: 0, marginBottom: 10 }}>סימולציה: מינימום</h4>
                              <p style={{ margin: "0 0 8px 0" }}>
                                מחיר: ₪ {result.transparency.simulations.minimum.price}
                              </p>
                              <p style={{ margin: "0 0 8px 0" }}>
                                רווח: ₪ {result.transparency.simulations.minimum.profitValue}
                              </p>
                              <p style={{ margin: 0 }}>
                                אחוז רווח: {result.transparency.simulations.minimum.profitPercent}%
                              </p>
                            </div>

                            <div style={resultBoxStyle}>
                              <h4 style={{ marginTop: 0, marginBottom: 10 }}>סימולציה: מומלץ</h4>
                              <p style={{ margin: "0 0 8px 0" }}>
                                מחיר: ₪ {result.transparency.simulations.recommended.price}
                              </p>
                              <p style={{ margin: "0 0 8px 0" }}>
                                רווח: ₪{" "}
                                {result.transparency.simulations.recommended.profitValue}
                              </p>
                              <p style={{ margin: 0 }}>
                                אחוז רווח: {result.transparency.simulations.recommended.profitPercent}%
                              </p>
                            </div>

                            <div style={resultBoxStyle}>
                              <h4 style={{ marginTop: 0, marginBottom: 10 }}>סימולציה: פרימיום</h4>
                              <p style={{ margin: "0 0 8px 0" }}>
                                מחיר: ₪ {result.transparency.simulations.premium.price}
                              </p>
                              <p style={{ margin: "0 0 8px 0" }}>
                                רווח: ₪ {result.transparency.simulations.premium.profitValue}
                              </p>
                              <p style={{ margin: 0 }}>
                                אחוז רווח: {result.transparency.simulations.premium.profitPercent}%
                              </p>
                            </div>
                          </div>

                          {Array.isArray(result.transparency.insights) &&
                            result.transparency.insights.length > 0 && (
                              <div style={resultBoxStyle}>
                                <h4 style={{ marginTop: 0, marginBottom: 10 }}>תובנות</h4>
                                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                                  {result.transparency.insights.map((insight, idx) => (
                                    <li key={idx} style={{ color: "#374151", lineHeight: 1.8 }}>
                                      {insight}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                        </div>
                      )}

                      <div
                        style={{
                          background: "#f8fafc",
                          border: "1px solid #e5e7eb",
                          borderRadius: 14,
                          padding: 14,
                        }}
                      >
                        <h4 style={{ marginTop: 0, marginBottom: 10 }}>הסבר פשוט</h4>
                        <p className="pricing-long-text" style={{ margin: 0, color: "#374151", lineHeight: 1.75, fontSize: 14 }}>
                          {result.explanation}
                        </p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
        </div>
        )}

        {activePanel === "create" && (
        <div style={{ display: "grid", gap: "clamp(14px, 4vw, 20px)" }}>
          <div
            style={{
              ...cardStyle,
              borderRadius: "clamp(16px, 3vw, 22px)",
              padding: "clamp(14px, 4vw, 20px)",
            }}
          >
            <h2 style={{ ...sectionTitleStyle, fontSize: "clamp(18px, 4.5vw, 22px)" }}>
              {pricingText.createTitle}
            </h2>
            <p
              className="pricing-long-text"
              style={{ ...mutedTextStyle, marginTop: 0, marginBottom: "clamp(16px, 4vw, 22px)", lineHeight: 1.55 }}
            >
              {pricingText.createDescription}
            </p>

            {createError && (
              <div
                style={{
                  marginBottom: 18,
                  padding: 18,
                  borderRadius: 18,
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                }}
              >
                <div
                  style={{
                    fontWeight: 800,
                    color: "#991b1b",
                    marginBottom: 8,
                    fontSize: 15,
                  }}
                >
                  לא הצלחנו לשמור
                </div>
                <p style={{ margin: 0, color: "#b91c1c", lineHeight: 1.65, fontSize: 15 }}>
                  {createError}
                </p>
              </div>
            )}

            {createSuccess && (
              <div
                style={{
                  marginBottom: 18,
                  padding: 18,
                  borderRadius: 18,
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                }}
              >
                <div
                  style={{
                    fontWeight: 800,
                    color: "#166534",
                    marginBottom: 6,
                    fontSize: 15,
                  }}
                >
                  נשמר בהצלחה
                </div>
                <p style={{ margin: 0, color: "#15803d", lineHeight: 1.65, fontSize: 15 }}>
                  {createSuccess}
                </p>
              </div>
            )}

            <label style={labelStyle}>איך נקרא הדבר שאתה מוכר?</label>
            <input
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              style={{ ...inputStyle, marginBottom: 8 }}
              placeholder="לדוגמה: טיפול פנים / מארז מתנה / תיקון מזגן"
            />
            <div style={helperStyle}>
              זה השם שתראה ברשימה. לדוגמה: “טיפול פנים”, “מארז מתנה”.
            </div>

            <label style={labelStyle}>מה זה יותר דומה?</label>
            <select
              value={newItemType}
              onChange={(e) => setNewItemType(e.target.value)}
              style={{ ...inputStyle, marginBottom: 8 }}
            >
              <option value="SERVICE">שירות</option>
              <option value="PRODUCT">מוצר</option>
            </select>
            <div style={helperStyle}>
              שירות בדרך כלל “עלות = זמן”. מוצר בדרך כלל “עלות = קנייה/חומר”. לדוגמה: טיפול = שירות, חולצה = מוצר.
            </div>

            <label style={labelStyle}>באיזה תחום זה? (לא חובה)</label>
            <input
              value={newItemCategory}
              onChange={(e) => setNewItemCategory(e.target.value)}
              style={{ ...inputStyle, marginBottom: 8 }}
              placeholder="לדוגמה: טיפוח, אוכל, תיקונים, אופנה"
            />
            <div style={helperStyle}>
              זה עוזר לסדר ולחפש בהמשך. לדוגמה: “טיפוח”, “אוכל”, “תיקונים”.
            </div>

            <div style={{ marginTop: 6, marginBottom: 16 }}>
              <h3 style={{ margin: "0 0 6px 0", fontSize: 18, color: "#111827" }}>
                בוא נבין כמה זה עולה לך באמת
              </h3>
              <p style={{ ...mutedTextStyle, margin: 0 }}>
                נחלק את זה לארבעה חלקים קטנים — כדי שהמספרים יהיו ברורים ולא מרגישים כמו טופס.
              </p>
            </div>

            <div style={{ display: "grid", gap: 14 }}>
              <div style={resultBoxStyle}>
                <h4 style={{ marginTop: 0, marginBottom: 10 }}>חומרים</h4>
                <label style={labelStyle}>
                  {isProduct
                    ? "כמה עולה לך המוצר לפני שמוכרים אותו?"
                    : "כמה עולים החומרים בפועל?"}
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

              <div style={resultBoxStyle}>
                <h4 style={{ marginTop: 0, marginBottom: 10 }}>זמן עבודה</h4>
                <label style={labelStyle}>כמה זמן זה לוקח לך בדרך כלל?</label>
                <input
                  type="number"
                  value={newLaborMinutes}
                  onChange={(e) => setNewLaborMinutes(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 8 }}
                  placeholder="0"
                />
                <div style={helperStyle}>{fieldText.labor}</div>
              </div>

              <div style={resultBoxStyle}>
                <h4 style={{ marginTop: 0, marginBottom: 10 }}>שווי שעה</h4>
                <label style={labelStyle}>כמה שעת עבודה “שווה” לך?</label>
                <input
                  type="number"
                  value={newHourlyRate}
                  onChange={(e) => setNewHourlyRate(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 8 }}
                  placeholder="0"
                />
                <div style={helperStyle}>
                  אפשר לחשוב על זה כשכר/שווי שעה. לדוגמה: אם שעה אצלך שווה 120₪ — זה המספר.
                </div>
              </div>

              <div style={resultBoxStyle}>
                <h4 style={{ marginTop: 0, marginBottom: 10 }}>הוצאות כלליות</h4>
                <label style={labelStyle}>איזה חלק מהעלות הולך להוצאות כלליות?</label>
                <input
                  type="number"
                  value={newOverheadPercent}
                  onChange={(e) => setNewOverheadPercent(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 8 }}
                  placeholder="10"
                />
                <div style={helperStyle}>
                  שכירות, חשמל, ציוד, רכב, משלוחים… לדוגמה: אם בערך 10% “נשפך” על זה — 10.
                </div>
              </div>
            </div>

            <Pressable
              onPress={handleCreateItem}
              disabled={creatingItem}
              style={{
                ...successButtonStyle,
                width: "100%",
                opacity: creatingItem ? 0.75 : 1,
              }}
            >
              {creatingItem ? "שומר..." : "שמור והמשך"}
            </Pressable>
          </div>
        </div>
        )}
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