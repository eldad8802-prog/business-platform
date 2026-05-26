"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type PricingItem = {
  id: number;
  name: string;
  type: "PRODUCT" | "SERVICE";
  category: string | null;
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
  marketCheck?: {
    status: string;
    low: number | null;
    high: number | null;
  };
  transparency?: {
    cost: {
      total: number;
      breakdown: { materials: number; labor: number; overhead: number };
    };
    simulations: {
      minimum: { price: number; profitValue: number; profitPercent: number };
      recommended: { price: number; profitValue: number; profitPercent: number };
      premium: { price: number; profitValue: number; profitPercent: number };
    };
    market: {
      low: number;
      high: number;
      status: string;
    } | null;
    insights: string[];
  };
};

type ActivePanel = "catalog" | "calculate" | "create";
type CalculateView = "form" | "loading" | "result" | "save_success";
type CreateView = "wizard" | "success";

const formatNis = (value: number) =>
  value.toLocaleString("he-IL", { maximumFractionDigits: 0 });

const typeLabel = (type: string) => (type === "PRODUCT" ? "מוצר" : "שירות");

const profitBadgeClass = (indicator: string) => {
  if (indicator === "LOW") return "pr-badge pr-badge--low";
  if (indicator === "HIGH") return "pr-badge pr-badge--high";
  return "pr-badge pr-badge--ok";
};

const profitBadgeLabel = (indicator: string, label: string) => {
  if (indicator === "OK") return "OK";
  return label;
};

const marketStatusText = (status: string | undefined) => {
  if (status === "BELOW_MARKET") return "המחיר המומלץ מתחת לטווח השוק שהזנתם.";
  if (status === "WITHIN_MARKET") return "המחיר המומלץ בתוך טווח השוק שהזנתם.";
  if (status === "ABOVE_MARKET") return "המחיר המומלץ מעל טווח השוק שהזנתם.";
  return null;
};

function BackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M15 6l-6 6 6 6"
        stroke="#94A3B8"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="#DCFCE7" />
      <path
        d="M8 12.5l2.5 2.5L16 9"
        stroke="#16A34A"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Spinner() {
  return <div className="pr-spinner" role="status" aria-label="טוען" />;
}

const CREATE_CATEGORIES = [
  "ייעוץ",
  "דיגיטל",
  "טיפוח",
  "אוכל",
  "תיקונים",
  "אופנה",
  "אחר",
];

const STYLES = `
.pr-root{min-height:100vh;background:#e8ecf2;direction:rtl;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a}
.pr-shell{max-width:402px;margin:0 auto;min-height:100vh;background:#fff;box-sizing:border-box;padding:14px 20px 24px;box-shadow:0 0 0 1px rgba(15,23,42,.04)}
.pr-header{margin-bottom:18px}
.pr-title{margin:0;font-size:28px;font-weight:800;letter-spacing:-.03em;line-height:1.2}
.pr-subtitle{margin:8px 0 0;font-size:14px;color:#94a3b8;line-height:1.5}
.pr-screen-head{display:flex;align-items:center;gap:8px;margin-bottom:18px;min-height:44px}
.pr-screen-head h1{flex:1;margin:0;font-size:17px;font-weight:700;text-align:center;line-height:1.3}
.pr-back{border:none;background:transparent;padding:8px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;color:#0f172a;cursor:pointer;border-radius:10px}
.pr-back:hover{background:#f8fafc}
.pr-spacer{width:44px;flex-shrink:0}
.pr-btn{width:100%;min-height:52px;border:none;border-radius:14px;font-size:16px;font-weight:600;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:opacity .15s,transform .1s}
.pr-btn:active:not(:disabled){transform:scale(.99)}
.pr-btn:disabled{opacity:.5;cursor:not-allowed}
.pr-btn--primary{background:#5b4fe8;color:#fff;box-shadow:0 4px 14px rgba(91,79,232,.28)}
.pr-btn--outline{background:#fff;color:#5b4fe8;border:2px solid #5b4fe8;box-shadow:none}
.pr-btn--ghost{background:transparent;color:#64748b;border:none;min-height:44px;font-weight:600}
.pr-btn--add{background:#fff;color:#0f172a;border:1px solid #eef2f6;margin-bottom:18px;box-shadow:0 2px 10px rgba(15,23,42,.05);justify-content:space-between;padding:0 18px;font-weight:600}
.pr-plus{width:28px;height:28px;border-radius:8px;background:#f5f3ff;color:#5b4fe8;font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center;font-weight:400}
.pr-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.pr-item{display:flex;align-items:center;gap:12px;width:100%;padding:14px 14px;background:#fff;border:1px solid #eef2f6;border-radius:14px;text-align:right;cursor:pointer;font-family:inherit;box-shadow:0 2px 10px rgba(15,23,42,.05)}
.pr-item:hover{border-color:#e2e8f0}
.pr-item-body{flex:1;min-width:0;text-align:right}
.pr-item-name{margin:0 0 4px;font-size:15px;font-weight:700;color:#0f172a;line-height:1.35}
.pr-item-meta{margin:0;font-size:13px;color:#64748b}
.pr-item-chevron{flex-shrink:0;display:flex;align-items:center}
.pr-info{margin-top:22px;padding:14px 16px;background:#f8fafc;border:1px solid #eef2f6;border-radius:14px;font-size:13px;line-height:1.55;color:#64748b}
.pr-empty{text-align:center;padding:36px 12px}
.pr-empty p{margin:0 0 20px;font-size:15px;color:#64748b;line-height:1.6}
.pr-section-title{margin:0 0 16px;font-size:15px;font-weight:700;color:#0f172a}
.pr-field{margin-bottom:12px}
.pr-label{display:block;margin-bottom:6px;font-size:13px;font-weight:600;color:#64748b}
.pr-input{width:100%;min-height:48px;padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;font-size:16px;color:#0f172a;background:#fff;outline:none;font-family:inherit;box-sizing:border-box}
.pr-input:focus{border-color:#5b4fe8;box-shadow:0 0 0 3px rgba(91,79,232,.12)}
.pr-hint{margin:-4px 0 12px;font-size:12px;color:#94a3b8;line-height:1.4}
.pr-accordion{border:1px solid #eef2f6;border-radius:14px;margin-bottom:12px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.03)}
.pr-accordion-trigger{width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border:none;background:#f8fafc;font-size:14px;font-weight:600;color:#475569;cursor:pointer;font-family:inherit;text-align:right}
.pr-accordion-body{padding:0 16px 16px;border-top:1px solid #eef2f6;background:#fff}
.pr-sticky{position:fixed;bottom:0;left:0;right:0;z-index:30;background:#fff;border-top:1px solid #eef2f6;padding:12px 20px max(12px,env(safe-area-inset-bottom));box-shadow:0 -4px 20px rgba(15,23,42,.08)}
.pr-sticky-inner{max-width:402px;margin:0 auto}
.pr-footnote{margin:8px 0 88px;font-size:12px;color:#94a3b8;text-align:center;line-height:1.5}
.pr-content-pad{padding-bottom:108px}
.pr-result-hero{text-align:center;padding:4px 0 20px}
.pr-result-label{margin:0 0 10px;font-size:14px;font-weight:600;color:#64748b}
.pr-result-price{margin:0;font-size:52px;font-weight:800;letter-spacing:-.04em;color:#0f172a;line-height:1}
.pr-result-range{margin:12px 0 0;font-size:15px;color:#94a3b8;font-weight:500}
.pr-breakdown{background:#fff;border:1px solid #eef2f6;border-radius:14px;padding:4px 16px;margin-bottom:16px;box-shadow:0 2px 10px rgba(15,23,42,.05)}
.pr-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #f1f5f9}
.pr-row:last-child{border-bottom:none}
.pr-row-label{font-size:14px;color:#64748b}
.pr-row-value{font-size:15px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.pr-row-value--red{color:#dc2626}
.pr-badge{padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.02em}
.pr-badge--ok{background:#dcfce7;color:#15803d}
.pr-badge--low{background:#fef3c7;color:#b45309}
.pr-badge--high{background:#e0e7ff;color:#4338ca}
.pr-explain-box{margin:0 0 16px;padding:14px 16px;background:#f8fafc;border:1px solid #eef2f6;border-radius:14px;font-size:14px;line-height:1.6;color:#475569}
.pr-details-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;margin-bottom:16px;border:1px solid #eef2f6;border-radius:14px;background:#fff;font-size:14px;font-weight:600;color:#475569;cursor:pointer;font-family:inherit;box-shadow:0 1px 3px rgba(15,23,42,.03)}
.pr-details-panel{margin:-8px 0 16px;padding:14px 16px;background:#f8fafc;border:1px solid #eef2f6;border-radius:14px;font-size:13px;color:#64748b;line-height:1.6}
.pr-details-panel p{margin:0 0 8px}
.pr-actions{display:flex;flex-direction:column;gap:12px;margin-top:4px;align-items:stretch}
.pr-link{border:none;background:transparent;padding:12px;font-size:15px;font-weight:600;color:#64748b;cursor:pointer;font-family:inherit;text-align:center}
.pr-center{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:62vh;text-align:center;padding:24px 8px}
.pr-center h2{margin:16px 0 8px;font-size:20px;font-weight:700;color:#0f172a}
.pr-center p{margin:0 0 28px;font-size:14px;color:#64748b;line-height:1.55;max-width:300px}
.pr-center .pr-btn{max-width:100%}
.pr-spinner{width:44px;height:44px;border:3px solid #e2e8f0;border-top-color:#5b4fe8;border-radius:50%;animation:pr-spin .7s linear infinite}
@keyframes pr-spin{to{transform:rotate(360deg)}}
.pr-stepper{display:flex;align-items:center;justify-content:center;margin-bottom:8px;gap:0}
.pr-step-caption{margin:0 0 20px;font-size:13px;color:#94a3b8;text-align:center}
.pr-step-dot{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0}
.pr-step-line{flex:1;height:2px;background:#e2e8f0;margin:0 4px;max-width:72px}
.pr-toggle{display:flex;gap:8px;margin-bottom:16px}
.pr-toggle-btn{flex:1;min-height:48px;border:1.5px solid #e2e8f0;border-radius:12px;background:#fff;font-size:15px;font-weight:600;color:#64748b;cursor:pointer;font-family:inherit}
.pr-toggle-btn--active{border-color:#5b4fe8;background:#f5f3ff;color:#5b4fe8}
.pr-error{margin:0 0 16px;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:12px;color:#b91c1c;font-size:14px;line-height:1.5}
.pr-create-q{margin:0 0 18px;font-size:22px;font-weight:700;line-height:1.35;color:#0f172a}
.pr-create-sub{margin:-12px 0 18px;font-size:14px;color:#64748b;line-height:1.5}
`;

export default function PricingPage() {
  const router = useRouter();

  const [token, setToken] = useState<string | null>(null);
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile | null>(
    null
  );

  const [items, setItems] = useState<PricingItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const [activePanel, setActivePanel] = useState<ActivePanel>("catalog");
  const [calculateView, setCalculateView] = useState<CalculateView>("form");
  const [createView, setCreateView] = useState<CreateView>("wizard");
  const [createStep, setCreateStep] = useState(1);

  const [bootLoading, setBootLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingCalculation, setLoadingCalculation] = useState(false);
  const [creatingItem, setCreatingItem] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  const [calcMaterialCost, setCalcMaterialCost] = useState("");
  const [calcLaborMinutes, setCalcLaborMinutes] = useState("");
  const [calcHourlyRate, setCalcHourlyRate] = useState("");
  const [calcOverheadPercent, setCalcOverheadPercent] = useState("");
  const [calcMarketLow, setCalcMarketLow] = useState("");
  const [calcMarketHigh, setCalcMarketHigh] = useState("");
  const [marketOpen, setMarketOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const [newItemName, setNewItemName] = useState("");
  const [newItemType, setNewItemType] = useState<"PRODUCT" | "SERVICE">("SERVICE");
  const [newItemCategory, setNewItemCategory] = useState("");
  const [newMaterialCost, setNewMaterialCost] = useState("");
  const [newLaborMinutes, setNewLaborMinutes] = useState("");
  const [newHourlyRate, setNewHourlyRate] = useState("");
  const [newOverheadPercent, setNewOverheadPercent] = useState("10");

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
          headers: { Authorization: `Bearer ${savedToken}` },
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
      } catch {
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
  }, [activePanel, calculateView, createView, createStep]);

  useEffect(() => {
    if (calculateView !== "result" || !result) return;
    requestAnimationFrame(() => {
      document.getElementById("pricing-recommendation-hero")?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    });
  }, [calculateView, result]);

  useEffect(() => {
    if (!businessProfile?.businessModel) return;
    setNewItemType(
      businessProfile.businessModel === "product" ? "PRODUCT" : "SERVICE"
    );
  }, [businessProfile]);

  const loadItems = async (currentToken: string) => {
    try {
      setLoadingItems(true);
      setError(null);

      const res = await fetch("/api/pricing/profiles", {
        method: "GET",
        headers: { Authorization: `Bearer ${currentToken}` },
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
        throw new Error(data?.error || "שגיאה בטעינת הפריטים");
      }

      const raw = Array.isArray(data.profiles) ? data.profiles : [];
      setItems(
        raw.map((p: Record<string, unknown>) => ({
          id: Number(p.id),
          name: String(p.name ?? ""),
          type: (p.type === "PRODUCT" ? "PRODUCT" : "SERVICE") as
            | "PRODUCT"
            | "SERVICE",
          category: p.category ? String(p.category) : null,
          defaultMaterialCost: Number(p.defaultMaterialCost ?? 0),
          defaultLaborMinutes: Number(p.defaultLaborMinutes ?? 0),
          defaultHourlyRate: Number(p.defaultHourlyRate ?? 0),
          defaultOverheadPercent: Number(p.defaultOverheadPercent ?? 10),
        }))
      );
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "שגיאה בטעינת הפריטים");
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
    if (!item) return;
    setCalcMaterialCost(String(item.defaultMaterialCost ?? ""));
    setCalcLaborMinutes(String(item.defaultLaborMinutes ?? ""));
    setCalcHourlyRate(String(item.defaultHourlyRate ?? ""));
    setCalcOverheadPercent(String(item.defaultOverheadPercent ?? 10));
  }, [selectedItemId, items]);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );

  const fieldHints = useMemo(() => {
    const model = businessProfile?.businessModel;
    if (model === "service") {
      return {
        material: "עלות חומרים לשירות (₪ ליחידה)",
        labor: "זמן ביצוע (דקות)",
      };
    }
    if (model === "product") {
      return {
        material: "עלות קנייה/ייצור ליחידה (₪)",
        labor: "זמן הכנה/אריזה (דקות), אם רלוונטי",
      };
    }
    return {
      material: "עלות חומר/קנייה ליחידה (₪)",
      labor: "זמן עבודה (דקות)",
    };
  }, [businessProfile]);

  const shortExplanation = useMemo(() => {
    if (!result?.explanation) return null;
    const parts = result.explanation.split(/(?<=[.!?])\s+/).slice(0, 2);
    return parts.join(" ");
  }, [result]);

  const hasMarketInput =
    calcMarketLow.trim() !== "" && calcMarketHigh.trim() !== "";

  const openCatalog = () => {
    setActivePanel("catalog");
    setCalculateView("form");
    setError(null);
  };

  const openCalculate = (itemId: number) => {
    setSelectedItemId(itemId);
    setResult(null);
    setCalculateView("form");
    setDetailsOpen(false);
    setMarketOpen(false);
    setError(null);
    setActivePanel("calculate");
  };

  const openCreate = () => {
    setCreateView("wizard");
    setCreateStep(1);
    setCreateError(null);
    setActivePanel("create");
  };

  const resetCreateForm = () => {
    setNewItemName("");
    setNewItemCategory("");
    setNewMaterialCost("");
    setNewLaborMinutes("");
    setNewHourlyRate("");
    setNewOverheadPercent("10");
    setNewItemType(
      businessProfile?.businessModel === "product" ? "PRODUCT" : "SERVICE"
    );
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
          defaultOverheadPercent: Number(calcOverheadPercent || 10),
        }),
      });

      const data = await res.json();

      if (res.status === 401) {
        localStorage.removeItem("token");
        router.replace("/login");
        return;
      }

      if (!res.ok) {
        throw new Error(data?.error || "שגיאה בשמירת הנתונים");
      }

      await loadItems(token);
      setCalculateView("save_success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה בשמירת הנתונים");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleCalculate = async () => {
    if (!selectedItemId || !token) return;

    try {
      setLoadingCalculation(true);
      setCalculateView("loading");
      setError(null);
      setResult(null);
      setDetailsOpen(false);

      const body: Record<string, number> = {
        pricingProfileId: selectedItemId,
        materialCost: Number(calcMaterialCost || 0),
        laborMinutes: Number(calcLaborMinutes || 0),
        hourlyRate: Number(calcHourlyRate || 0),
        overheadPercent: Number(calcOverheadPercent || 10),
      };

      if (hasMarketInput) {
        body.marketLow = Number(calcMarketLow);
        body.marketHigh = Number(calcMarketHigh);
      }

      const res = await fetch("/api/pricing/calculate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (res.status === 401) {
        localStorage.removeItem("token");
        router.replace("/login");
        return;
      }

      if (!res.ok) {
        throw new Error(data?.error || "שגיאה בחישוב המחיר");
      }

      setResult(data);
      setCalculateView("result");
    } catch (err) {
      setCalculateView("form");
      setError(err instanceof Error ? err.message : "שגיאה בחישוב המחיר");
    } finally {
      setLoadingCalculation(false);
    }
  };

  const handleCreateItem = async () => {
    if (!token) return;

    try {
      setCreatingItem(true);
      setCreateError(null);

      const res = await fetch("/api/pricing/profiles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: newItemName.trim(),
          type: newItemType,
          category: newItemCategory || null,
          defaultMaterialCost: Number(newMaterialCost || 0),
          defaultLaborMinutes: Number(newLaborMinutes || 0),
          defaultHourlyRate: Number(newHourlyRate || 0),
          defaultOverheadPercent: Number(newOverheadPercent || 10),
          isActive: true,
        }),
      });

      const data = await res.json();

      if (res.status === 401) {
        localStorage.removeItem("token");
        router.replace("/login");
        return;
      }

      if (!res.ok) {
        throw new Error(data?.error || "שגיאה ביצירת הפריט");
      }

      await loadItems(token);

      if (data?.profile?.id) {
        setSelectedItemId(data.profile.id);
      }

      setCreateView("success");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "שגיאה ביצירת הפריט");
    } finally {
      setCreatingItem(false);
    }
  };

  const renderCostFields = (
    prefix: string,
    material: string,
    setMaterial: (v: string) => void,
    labor: string,
    setLabor: (v: string) => void,
    hourly: string,
    setHourly: (v: string) => void,
    overhead: string,
    setOverhead: (v: string) => void,
    showHints = false
  ) => (
    <>
      <div className="pr-field">
        <label className="pr-label" htmlFor={`${prefix}-material`}>
          חומרים (₪)
        </label>
        <input
          id={`${prefix}-material`}
          className="pr-input"
          type="number"
          inputMode="decimal"
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
          placeholder="0"
        />
        {showHints ? <p className="pr-hint">{fieldHints.material}</p> : null}
      </div>
      <div className="pr-field">
        <label className="pr-label" htmlFor={`${prefix}-labor`}>
          זמן (דקות)
        </label>
        <input
          id={`${prefix}-labor`}
          className="pr-input"
          type="number"
          inputMode="numeric"
          value={labor}
          onChange={(e) => setLabor(e.target.value)}
          placeholder="0"
        />
        {showHints ? <p className="pr-hint">{fieldHints.labor}</p> : null}
      </div>
      <div className="pr-field">
        <label className="pr-label" htmlFor={`${prefix}-hourly`}>
          שווי שעה (₪)
        </label>
        <input
          id={`${prefix}-hourly`}
          className="pr-input"
          type="number"
          inputMode="decimal"
          value={hourly}
          onChange={(e) => setHourly(e.target.value)}
          placeholder="0"
        />
      </div>
      <div className="pr-field">
        <label className="pr-label" htmlFor={`${prefix}-overhead`}>
          הוצאות כלליות (%)
        </label>
        <input
          id={`${prefix}-overhead`}
          className="pr-input"
          type="number"
          inputMode="decimal"
          value={overhead}
          onChange={(e) => setOverhead(e.target.value)}
          placeholder="10"
        />
      </div>
    </>
  );

  if (bootLoading) {
    return (
      <div className="pr-root">
        <div className="pr-shell pr-center">
          <Spinner />
          <p style={{ marginTop: 16 }}>טוען…</p>
        </div>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </div>
    );
  }

  return (
    <div className="pr-root">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="pr-shell">
        {error && activePanel !== "calculate" ? (
          <p className="pr-error" role="alert">
            {error}
          </p>
        ) : null}

        {/* ——— קטלוג ——— */}
        {activePanel === "catalog" && (
          <>
            <header className="pr-header">
              <h1 className="pr-title">תמחור</h1>
              <p className="pr-subtitle">בחרו פריט לחישוב מחיר</p>
            </header>

            <button type="button" className="pr-btn pr-btn--add" onClick={openCreate}>
              <span>הוספת שירות או מוצר</span>
              <span className="pr-plus" aria-hidden>
                +
              </span>
            </button>

            {loadingItems && items.length === 0 ? (
              <p style={{ color: "#94a3b8", fontSize: 15 }}>טוען פריטים…</p>
            ) : null}

            {!loadingItems && items.length === 0 ? (
              <div className="pr-empty">
                <p>עדיין אין פריטים לתמחור. הוסיפו שירות או מוצר עם עלויות בסיס.</p>
                <button type="button" className="pr-btn pr-btn--primary" onClick={openCreate}>
                  הוספת פריט ראשון
                </button>
              </div>
            ) : null}

            {items.length > 0 ? (
              <ul className="pr-list">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="pr-item"
                      onClick={() => openCalculate(item.id)}
                    >
                      <div className="pr-item-body">
                        <p className="pr-item-name">{item.name}</p>
                        <p className="pr-item-meta">
                          {typeLabel(item.type)}
                          {item.category ? ` · ${item.category}` : ""}
                        </p>
                      </div>
                      <span className="pr-item-chevron" aria-hidden>
                        <ChevronIcon />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {items.length > 0 ? (
              <div className="pr-info">
                אם אינכם בטוחים במחיר — הזינו עלויות וקבלו המלצה מבוססת עלות.
              </div>
            ) : null}
          </>
        )}

        {/* ——— חישוב ——— */}
        {activePanel === "calculate" && selectedItem && (
          <>
            {calculateView !== "loading" && calculateView !== "save_success" ? (
              <div className="pr-screen-head">
                <button
                  type="button"
                  className="pr-back"
                  aria-label="חזרה"
                  onClick={() => {
                    if (calculateView === "result") {
                      setCalculateView("form");
                      return;
                    }
                    openCatalog();
                  }}
                >
                  <BackIcon />
                </button>
                <h1>{selectedItem.name}</h1>
                <div className="pr-spacer" />
              </div>
            ) : null}

            {error && calculateView === "form" ? (
              <p className="pr-error" role="alert">
                {error}
              </p>
            ) : null}

            {calculateView === "form" && (
              <div className="pr-content-pad">
                <h2 className="pr-section-title">העלויות שלכם</h2>
                {renderCostFields(
                  "calc",
                  calcMaterialCost,
                  setCalcMaterialCost,
                  calcLaborMinutes,
                  setCalcLaborMinutes,
                  calcHourlyRate,
                  setCalcHourlyRate,
                  calcOverheadPercent,
                  setCalcOverheadPercent
                )}

                <div className="pr-accordion">
                  <button
                    type="button"
                    className="pr-accordion-trigger"
                    onClick={() => setMarketOpen((o) => !o)}
                    aria-expanded={marketOpen}
                  >
                    <span>השוואה לשוק (לא חובה)</span>
                    <span aria-hidden>{marketOpen ? "▴" : "▾"}</span>
                  </button>
                  {marketOpen ? (
                    <div className="pr-accordion-body">
                      <p className="pr-hint" style={{ marginTop: 12 }}>
                        רק אם אתם יודעים טווח מחירים בשוק
                      </p>
                      <div className="pr-field">
                        <label className="pr-label" htmlFor="market-low">
                          מחיר נמוך בשוק (₪)
                        </label>
                        <input
                          id="market-low"
                          className="pr-input"
                          type="number"
                          value={calcMarketLow}
                          onChange={(e) => setCalcMarketLow(e.target.value)}
                          placeholder="0"
                        />
                      </div>
                      <div className="pr-field">
                        <label className="pr-label" htmlFor="market-high">
                          מחיר גבוה בשוק (₪)
                        </label>
                        <input
                          id="market-high"
                          className="pr-input"
                          type="number"
                          value={calcMarketHigh}
                          onChange={(e) => setCalcMarketHigh(e.target.value)}
                          placeholder="0"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>

                <p className="pr-footnote">הנתונים נשמרים לפריט</p>

                <div className="pr-sticky">
                  <div className="pr-sticky-inner">
                    <button
                      type="button"
                      className="pr-btn pr-btn--primary"
                      disabled={loadingCalculation}
                      onClick={() => void handleCalculate()}
                    >
                      חשב מחיר
                    </button>
                  </div>
                </div>
              </div>
            )}

            {calculateView === "loading" && (
              <div className="pr-center">
                <Spinner />
                <h2>מחשב מחיר מומלץ…</h2>
                <p>זה לוקח כמה שניות</p>
              </div>
            )}

            {calculateView === "result" && result && (
              <div className="pr-content-pad">
                <div className="pr-result-hero" id="pricing-recommendation-hero">
                  <p className="pr-result-label">מחיר מומלץ</p>
                  <p className="pr-result-price">₪ {formatNis(result.priceOptions.recommended)}</p>
                  <p className="pr-result-range">
                    טווח מומלץ: ₪ {formatNis(result.priceOptions.minimum)} –{" "}
                    {formatNis(result.priceOptions.premium)}
                  </p>
                </div>

                <div className="pr-breakdown">
                  <div className="pr-row">
                    <span className="pr-row-label">עלות מלאה</span>
                    <span className="pr-row-value">
                      ₪ {formatNis(result.costBreakdown.fullCost)}
                    </span>
                  </div>
                  <div className="pr-row">
                    <span className="pr-row-label">רווח משוער</span>
                    <span className="pr-row-value">
                      {result.profit.percent}% (₪ {formatNis(result.profit.amount)})
                      <span className={profitBadgeClass(result.profit.indicator)}>
                        {profitBadgeLabel(result.profit.indicator, result.profit.label)}
                      </span>
                    </span>
                  </div>
                  <div className="pr-row">
                    <span className="pr-row-label">קו אדום (מינימום)</span>
                    <span className="pr-row-value pr-row-value--red">
                      ₪ {formatNis(result.priceOptions.minimum)}
                    </span>
                  </div>
                </div>

                {shortExplanation ||
                (hasMarketInput && result.marketCheck?.status !== "UNKNOWN") ? (
                  <div className="pr-explain-box">
                    {shortExplanation ? <p style={{ margin: 0 }}>{shortExplanation}</p> : null}
                    {hasMarketInput && result.marketCheck?.status !== "UNKNOWN" ? (
                      <p style={{ margin: shortExplanation ? "8px 0 0" : 0 }}>
                        {marketStatusText(result.marketCheck?.status) ?? ""}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <button
                  type="button"
                  className="pr-details-toggle"
                  onClick={() => setDetailsOpen((o) => !o)}
                  aria-expanded={detailsOpen}
                >
                  <span>פירוט חישוב מלא</span>
                  <span aria-hidden>{detailsOpen ? "▴" : "▾"}</span>
                </button>
                {detailsOpen && result.transparency ? (
                  <div className="pr-details-panel">
                    <p>
                      <strong>חומרים:</strong> ₪{" "}
                      {formatNis(result.transparency.cost.breakdown.materials)}
                    </p>
                    <p>
                      <strong>עבודה:</strong> ₪{" "}
                      {formatNis(result.transparency.cost.breakdown.labor)}
                    </p>
                    <p>
                      <strong>הוצאות כלליות:</strong> ₪{" "}
                      {formatNis(result.transparency.cost.breakdown.overhead)}
                    </p>
                    <p style={{ marginTop: 12 }}>
                      <strong>מינימום:</strong> ₪{" "}
                      {formatNis(result.transparency.simulations.minimum.price)} — רווח{" "}
                      {result.transparency.simulations.minimum.profitPercent}%
                    </p>
                    <p>
                      <strong>מומלץ:</strong> ₪{" "}
                      {formatNis(result.transparency.simulations.recommended.price)} — רווח{" "}
                      {result.transparency.simulations.recommended.profitPercent}%
                    </p>
                    <p>
                      <strong>פרימיום:</strong> ₪{" "}
                      {formatNis(result.transparency.simulations.premium.price)} — רווח{" "}
                      {result.transparency.simulations.premium.profitPercent}%
                    </p>
                    {result.explanation ? (
                      <p style={{ marginTop: 12 }}>{result.explanation}</p>
                    ) : null}
                  </div>
                ) : null}

                <div className="pr-actions">
                  <button
                    type="button"
                    className="pr-btn pr-btn--outline"
                    disabled={savingProfile}
                    onClick={() => void handleSaveProfileDefaults()}
                  >
                    {savingProfile ? "שומר…" : "שמור נתוני עלות לפריט"}
                  </button>
                  <button type="button" className="pr-link" onClick={openCatalog}>
                    חזרה לרשימה
                  </button>
                </div>
              </div>
            )}

            {calculateView === "save_success" && (
              <div className="pr-center">
                <CheckIcon />
                <h2>העלויות נשמרו לפריט</h2>
                <button
                  type="button"
                  className="pr-btn pr-btn--primary"
                  style={{ width: "100%", maxWidth: 320 }}
                  onClick={openCatalog}
                >
                  חזרה לרשימה
                </button>
              </div>
            )}
          </>
        )}

        {/* ——— הוספת פריט ——— */}
        {activePanel === "create" && createView === "wizard" && (
          <>
            <div className="pr-screen-head">
              <button
                type="button"
                className="pr-back"
                aria-label="חזרה"
                onClick={() => {
                  if (createStep > 1) {
                    setCreateStep(1);
                    return;
                  }
                  openCatalog();
                }}
              >
                <BackIcon />
              </button>
              <h1>פריט חדש</h1>
              <div className="pr-spacer" />
            </div>

            <div className="pr-stepper" aria-label={`שלב ${createStep} מתוך 2`}>
              {[1, 2].map((step) => (
                <div
                  key={step}
                  style={{ display: "flex", alignItems: "center", flex: step < 2 ? 1 : undefined }}
                >
                  <div
                    className="pr-step-dot"
                    style={{
                      background: createStep >= step ? "#5b4fe8" : "#f1f5f9",
                      color: createStep >= step ? "#fff" : "#94a3b8",
                      border:
                        createStep === step ? "2px solid #5b4fe8" : "2px solid transparent",
                    }}
                  >
                    {step}
                  </div>
                  {step < 2 ? (
                    <div
                      className="pr-step-line"
                      style={{ background: createStep > step ? "#5b4fe8" : "#e2e8f0" }}
                    />
                  ) : null}
                </div>
              ))}
            </div>
            <p className="pr-step-caption">שלב {createStep} מתוך 2</p>

            {createError ? (
              <p className="pr-error" role="alert">
                {createError}
              </p>
            ) : null}

            {createStep === 1 ? (
              <>
                <h2 className="pr-create-q">מהו השירות או המוצר?</h2>
                <div className="pr-field">
                  <label className="pr-label" htmlFor="new-name">
                    שם הפריט
                  </label>
                  <input
                    id="new-name"
                    className="pr-input"
                    value={newItemName}
                    onChange={(e) => setNewItemName(e.target.value)}
                    placeholder="לדוגמה: ייעוץ אסטרטגי"
                  />
                </div>
                <p className="pr-label">סוג</p>
                <div className="pr-toggle">
                  <button
                    type="button"
                    className={`pr-toggle-btn${newItemType === "SERVICE" ? " pr-toggle-btn--active" : ""}`}
                    onClick={() => setNewItemType("SERVICE")}
                  >
                    שירות
                  </button>
                  <button
                    type="button"
                    className={`pr-toggle-btn${newItemType === "PRODUCT" ? " pr-toggle-btn--active" : ""}`}
                    onClick={() => setNewItemType("PRODUCT")}
                  >
                    מוצר
                  </button>
                </div>
                <div className="pr-field">
                  <label className="pr-label" htmlFor="new-cat">
                    קטגוריה (לא חובה)
                  </label>
                  <select
                    id="new-cat"
                    className="pr-input"
                    value={newItemCategory}
                    onChange={(e) => setNewItemCategory(e.target.value)}
                  >
                    <option value="">בחרו קטגוריה</option>
                    {CREATE_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}

            {createStep === 2 ? (
              <>
                <h2 className="pr-create-q">עלויות</h2>
                <p className="pr-create-sub">ארבעה מספרים — הבסיס לחישוב המחיר</p>
                {renderCostFields(
                  "new",
                  newMaterialCost,
                  setNewMaterialCost,
                  newLaborMinutes,
                  setNewLaborMinutes,
                  newHourlyRate,
                  setNewHourlyRate,
                  newOverheadPercent,
                  setNewOverheadPercent
                )}
              </>
            ) : null}

            <div className="pr-sticky">
              <div className="pr-sticky-inner">
                <button
                  type="button"
                  className="pr-btn pr-btn--primary"
                  disabled={creatingItem}
                  onClick={() => {
                    if (createStep === 1) {
                      if (!newItemName.trim()) {
                        setCreateError("נא למלא שם לפריט");
                        return;
                      }
                      setCreateError(null);
                      setCreateStep(2);
                      return;
                    }
                    void handleCreateItem();
                  }}
                >
                  {creatingItem
                    ? "שומר…"
                    : createStep < 2
                      ? "המשך"
                      : "צור פריט"}
                </button>
                <button type="button" className="pr-btn pr-btn--ghost" onClick={openCatalog}>
                  ביטול
                </button>
              </div>
            </div>
          </>
        )}

        {activePanel === "create" && createView === "success" && (
          <div className="pr-center">
            <CheckIcon />
            <h2>הפריט נוסף בהצלחה</h2>
            <div className="pr-actions" style={{ width: "100%", maxWidth: 320 }}>
              <button
                type="button"
                className="pr-btn pr-btn--primary"
                onClick={() => {
                  if (selectedItemId) {
                    openCalculate(selectedItemId);
                  }
                }}
              >
                תמחור עכשיו
              </button>
              <button type="button" className="pr-btn pr-btn--outline" onClick={openCatalog}>
                חזרה לרשימה
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
