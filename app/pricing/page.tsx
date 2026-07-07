"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";
import { chipActionStyle, glassActionStyle, iconActionStyle, primaryActionStyle } from "@/lib/design/action-styles";
import BackButton from "@/components/ui/back-button";

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
      positionRatio?: number | null;
    } | null;
    insights: string[];
  };
};

type ActivePanel = "catalog" | "calculate" | "create";
type CalculateView = "form" | "loading" | "result" | "save_success";
type CreateView = "wizard" | "success";

const CREATE_CATEGORIES = [
  "ייעוץ",
  "דיגיטל",
  "טיפוח",
  "אוכל",
  "תיקונים",
  "אופנה",
  "אחר",
];

const formatNis = (value: number) =>
  value.toLocaleString("he-IL", { maximumFractionDigits: 0 });

const formatNis2 = (value: number) =>
  value.toLocaleString("he-IL", { maximumFractionDigits: 2 });

const typeLabel = (type: string) => (type === "PRODUCT" ? "מוצר" : "שירות");

function profitBadgeStyle(indicator: string): CSSProperties {
  if (indicator === "LOW") {
    return {
      ...badgeBase,
      background: TOKEN.semantic.attention.bg,
      color: TOKEN.semantic.attention.ink,
    };
  }
  // OK / HIGH — both express a healthy margin.
  return {
    ...badgeBase,
    background: TOKEN.semantic.success.bg,
    color: TOKEN.semantic.success.ink,
  };
}

const marketStatusText = (status: string | undefined) => {
  if (status === "BELOW_MARKET") return "המחיר המומלץ מתחת לטווח השוק שהזנתם.";
  if (status === "WITHIN_MARKET") return "המחיר המומלץ בתוך טווח השוק שהזנתם.";
  if (status === "ABOVE_MARKET") return "המחיר המומלץ מעל טווח השוק שהזנתם.";
  return null;
};


function ChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m15 6-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function TrendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 17l6-6 4 4 8-8"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon({ size = 18, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 13l4 4L19 7"
        stroke={color}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Spinner() {
  return <div className="pricing-spin" role="status" aria-label="טוען" />;
}

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
    const timer = window.setTimeout(() => {
      setNewItemType(
        businessProfile.businessModel === "product" ? "PRODUCT" : "SERVICE"
      );
    }, 0);
    return () => window.clearTimeout(timer);
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
    const timer = window.setTimeout(() => {
      loadItems(token);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    const item = items.find((i) => i.id === selectedItemId);
    if (!item) return;
    const timer = window.setTimeout(() => {
      setCalcMaterialCost(String(item.defaultMaterialCost ?? ""));
      setCalcLaborMinutes(String(item.defaultLaborMinutes ?? ""));
      setCalcHourlyRate(String(item.defaultHourlyRate ?? ""));
      setCalcOverheadPercent(String(item.defaultOverheadPercent ?? 10));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedItemId, items]);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );

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
    setOverhead: (v: string) => void
  ) => (
    <>
      <Field
        id={`${prefix}-material`}
        label="עלות חומרים"
        unit="₪"
        value={material}
        onChange={setMaterial}
      />
      <Field
        id={`${prefix}-labor`}
        label="זמן עבודה"
        unit="דקות"
        value={labor}
        onChange={setLabor}
      />
      <Field
        id={`${prefix}-hourly`}
        label="שווי שעת עבודה"
        unit="₪"
        value={hourly}
        onChange={setHourly}
      />
      <Field
        id={`${prefix}-overhead`}
        label="הוצאות כלליות"
        unit="%"
        value={overhead}
        onChange={setOverhead}
        placeholder="10"
        hint="עלויות עקיפות (שכירות, חשמל, תוכנות) כאחוז מהעלות הישירה"
      />
    </>
  );

  if (bootLoading) {
    return (
      <div dir="rtl" style={rootStyle}>
        <PricingGlobalStyles />
        <div style={{ ...shellStyle, ...centerStyle }} className="pricing-shell">
          <Spinner />
          <p style={{ ...centerTitleStyle, marginTop: TOKEN.space.lg }}>טוען…</p>
        </div>
      </div>
    );
  }

  return (
    <div dir="rtl" style={rootStyle}>
      <PricingGlobalStyles />
      <div style={shellStyle} className="pricing-shell">
        {error && activePanel !== "calculate" ? (
          <p style={errorStyle} role="alert">
            {error}
          </p>
        ) : null}

        {/* ——— קטלוג ——— */}
        {activePanel === "catalog" && (
          <div style={scrollPadStyle}>
            <header style={catalogHeadStyle}>
              <div style={{ flex: 1 }}>
                <h1 style={pageTitleStyle}>תמחור</h1>
                <p style={pageSubtitleStyle}>תמחור עלות-פלוס לשירותים ומוצרים</p>
              </div>
              <button
                type="button"
                aria-label="הוספת פריט"
                style={addRoundBtnStyle}
                className="pricing-pressable"
                onClick={openCreate}
              >
                <PlusIcon />
              </button>
            </header>

            {loadingItems && items.length === 0 ? (
              <p style={mutedNoteStyle}>טוען פריטים…</p>
            ) : null}

            {!loadingItems && items.length === 0 ? (
              <div style={emptyStateStyle}>
                <p style={emptyTextStyle}>
                  עדיין אין פריטים לתמחור. הוסיפו שירות או מוצר עם עלויות בסיס.
                </p>
                <button
                  type="button"
                  style={primaryBtnStyle(false)}
                  className="pricing-pressable"
                  onClick={openCreate}
                >
                  הוספת פריט ראשון
                </button>
              </div>
            ) : null}

            {items.length > 0 ? (
              <ul style={listStyle}>
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      style={itemStyle}
                      className="pricing-pressable"
                      onClick={() => openCalculate(item.id)}
                    >
                      <span style={itemAvatarStyle} aria-hidden>
                        {item.name.trim().charAt(0) || "₪"}
                      </span>
                      <span style={itemBodyStyle}>
                        <span style={itemNameStyle}>{item.name}</span>
                        <span style={itemMetaStyle}>
                          {item.category ? `${item.category} · ` : ""}עלות בסיס שמורה
                        </span>
                      </span>
                      <span style={itemTrailStyle}>
                        <span style={pillStyle(item.type)}>{typeLabel(item.type)}</span>
                        <span style={chevStyle} aria-hidden>
                          <ChevronIcon />
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {items.length > 0 ? (
              <div style={infoBoxStyle}>
                אם אינכם בטוחים במחיר — הזינו עלויות וקבלו המלצה מבוססת עלות.
              </div>
            ) : null}
          </div>
        )}

        {/* ——— חישוב ——— */}
        {activePanel === "calculate" && selectedItem && (
          <>
            {calculateView !== "loading" && calculateView !== "save_success" ? (
              <div style={detailHeadStyle}>
                <BackButton
                  onClick={() => {
                    if (calculateView === "result") {
                      setCalculateView("form");
                      return;
                    }
                    openCatalog();
                  }}
                />
                <div style={detailTitleStyle}>
                  {calculateView === "result" ? "תוצאת תמחור" : "חישוב מחיר"}
                  <small style={detailSubStyle}>{selectedItem.name}</small>
                </div>
                <div style={iconBtnSpacerStyle} />
              </div>
            ) : null}

            {error && calculateView === "form" ? (
              <p style={errorStyle} role="alert">
                {error}
              </p>
            ) : null}

            {calculateView === "form" && (
              <>
                <div style={scrollPadStyle}>
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

                  <div style={accordionStyle}>
                    <button
                      type="button"
                      style={accordionHeadStyle}
                      onClick={() => setMarketOpen((o) => !o)}
                      aria-expanded={marketOpen}
                    >
                      <span>
                        השוואה לשוק{" "}
                        <span style={labelUnitStyle}>אופציונלי</span>
                      </span>
                      <span aria-hidden style={{ color: TOKEN.ink.muted }}>
                        {marketOpen ? "▴" : "▾"}
                      </span>
                    </button>
                    {marketOpen ? (
                      <div style={accordionBodyStyle}>
                        <Field
                          id="market-low"
                          label="מינ' בשוק"
                          value={calcMarketLow}
                          onChange={setCalcMarketLow}
                          placeholder="300"
                        />
                        <Field
                          id="market-high"
                          label="מקס' בשוק"
                          value={calcMarketHigh}
                          onChange={setCalcMarketHigh}
                          placeholder="600"
                        />
                      </div>
                    ) : null}
                  </div>

                  <p style={footnoteStyle}>הנתונים נשמרים לפריט</p>
                </div>

                <div style={bottomBarStyle}>
                  <button
                    type="button"
                    style={primaryBtnStyle(loadingCalculation)}
                    className="pricing-pressable"
                    disabled={loadingCalculation}
                    onClick={() => void handleCalculate()}
                  >
                    חשב מחיר
                  </button>
                </div>
              </>
            )}

            {calculateView === "loading" && (
              <div style={centerStyle}>
                <Spinner />
                <div style={centerTitleStyle}>מחשב מחיר מומלץ…</div>
                <div style={centerSubStyle}>מנתח עלויות, רווח והשוואה לשוק</div>
              </div>
            )}

            {calculateView === "result" && result && (
              <>
                <div style={scrollPadStyle}>
                  <div style={heroStyle} id="pricing-recommendation-hero">
                    <div style={heroLabelStyle}>המחיר המומלץ</div>
                    <div style={heroPriceStyle}>₪{formatNis(result.priceOptions.recommended)}</div>
                    <div style={heroBadgeStyle}>
                      <TrendIcon />
                      רווח {result.profit.percent}% · {result.profit.label}
                    </div>
                  </div>

                  <div style={tiersRowStyle}>
                    <div style={tierStyle("min")}>
                      <div style={tierLabelStyle("min")}>מינימום</div>
                      <div style={tierPriceStyle}>₪{formatNis(result.priceOptions.minimum)}</div>
                    </div>
                    <div style={tierStyle("rec")}>
                      <div style={tierLabelStyle("rec")}>מומלץ</div>
                      <div style={tierPriceStyle}>₪{formatNis(result.priceOptions.recommended)}</div>
                    </div>
                    <div style={tierStyle("prem")}>
                      <div style={tierLabelStyle("prem")}>פרימיום</div>
                      <div style={tierPriceStyle}>₪{formatNis(result.priceOptions.premium)}</div>
                    </div>
                  </div>

                  <div style={breakdownStyle}>
                    <div style={breakdownRowStyle}>
                      <span style={breakdownKeyStyle}>עלות מלאה (נקודת איזון)</span>
                      <span style={breakdownValStyle}>₪{formatNis2(result.costBreakdown.fullCost)}</span>
                    </div>
                    <div style={breakdownRowStyle}>
                      <span style={breakdownKeyStyle}>רווח במחיר המומלץ</span>
                      <span style={breakdownValStyle}>
                        ₪{formatNis2(result.profit.amount)}
                        <span style={profitBadgeStyle(result.profit.indicator)}>
                          {result.profit.label}
                        </span>
                      </span>
                    </div>
                    <div style={{ ...breakdownRowStyle, ...breakdownTotalStyle, borderBottom: "none" }}>
                      <span style={breakdownKeyStyle}>מחיר מינימום — אל תרד מתחת</span>
                      <span style={{ ...breakdownValStyle, color: TOKEN.semantic.urgent.ink }}>
                        ₪{formatNis2(result.priceOptions.minimum)}
                      </span>
                    </div>
                  </div>

                  {hasMarketInput && result.marketCheck?.status !== "UNKNOWN" ? (
                    <div style={marketNoteStyle}>
                      <CheckIcon />
                      {marketStatusText(result.marketCheck?.status) ?? ""}
                    </div>
                  ) : null}

                  {shortExplanation ? (
                    <div style={explainStyle}>{shortExplanation}</div>
                  ) : null}

                  <button
                    type="button"
                    style={moreLinkStyle}
                    className="pricing-pressable"
                    onClick={() => setDetailsOpen((o) => !o)}
                    aria-expanded={detailsOpen}
                  >
                    <span>פירוט חישוב מלא</span>
                    <span aria-hidden>{detailsOpen ? "▴" : "▾"}</span>
                  </button>

                  {detailsOpen && result.transparency ? (
                    <div style={{ marginTop: TOKEN.space.lg }}>
                      <div style={sectionLabelStyle}>פירוק עלות</div>
                      <div style={breakdownStyle}>
                        <div style={breakdownRowStyle}>
                          <span style={breakdownKeyStyle}>חומרים</span>
                          <span style={breakdownValStyle}>
                            ₪{formatNis2(result.transparency.cost.breakdown.materials)}
                          </span>
                        </div>
                        <div style={breakdownRowStyle}>
                          <span style={breakdownKeyStyle}>
                            עבודה
                            {calcLaborMinutes && calcHourlyRate
                              ? ` (${calcLaborMinutes} דק׳ × ₪${calcHourlyRate}/ש׳)`
                              : ""}
                          </span>
                          <span style={breakdownValStyle}>
                            ₪{formatNis2(result.transparency.cost.breakdown.labor)}
                          </span>
                        </div>
                        <div style={breakdownRowStyle}>
                          <span style={breakdownKeyStyle}>
                            הוצאות כלליות ({calcOverheadPercent || 10}%)
                          </span>
                          <span style={breakdownValStyle}>
                            ₪{formatNis2(result.transparency.cost.breakdown.overhead)}
                          </span>
                        </div>
                        <div style={{ ...breakdownRowStyle, ...breakdownTotalStyle, borderBottom: "none" }}>
                          <span style={breakdownKeyStyle}>עלות מלאה</span>
                          <span style={breakdownValStyle}>
                            ₪{formatNis2(result.transparency.cost.total)}
                          </span>
                        </div>
                      </div>

                      <div style={sectionLabelStyle}>סימולציית רווח</div>
                      <div style={breakdownStyle}>
                        {(["minimum", "recommended", "premium"] as const).map((key, idx, arr) => {
                          const sim = result.transparency!.simulations[key];
                          const name =
                            key === "minimum" ? "מינימום" : key === "recommended" ? "מומלץ" : "פרימיום";
                          return (
                            <div
                              key={key}
                              style={{
                                ...simRowStyle,
                                borderBottom:
                                  idx === arr.length - 1 ? "none" : `1px solid ${TOKEN.border.DEFAULT}`,
                              }}
                            >
                              <span style={{ flex: 1 }}>
                                <span style={simNameStyle}>{name}</span>
                                <span style={simSubStyle}>
                                  רווח ₪{formatNis2(sim.profitValue)} · {sim.profitPercent}%
                                </span>
                              </span>
                              <span style={simPriceStyle}>₪{formatNis2(sim.price)}</span>
                            </div>
                          );
                        })}
                      </div>

                      {result.transparency.market ? (
                        <>
                          <div style={sectionLabelStyle}>מיקום בשוק</div>
                          <MarketBar market={result.transparency.market} price={result.priceOptions.recommended} />
                        </>
                      ) : null}

                      {result.transparency.insights.length > 0 ? (
                        <div style={insightsStyle}>
                          {result.transparency.insights.map((line, i) => (
                            <div key={i} style={insightRowStyle}>
                              <span style={insightDotStyle} />
                              {line}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div style={bottomBarStyle}>
                  <button
                    type="button"
                    style={primaryBtnStyle(savingProfile)}
                    className="pricing-pressable"
                    disabled={savingProfile}
                    onClick={() => void handleSaveProfileDefaults()}
                  >
                    {savingProfile ? "שומר…" : "שמור עלויות לפריט"}
                  </button>
                  <button
                    type="button"
                    style={ghostBtnStyle}
                    className="pricing-pressable"
                    onClick={openCatalog}
                  >
                    חזרה לקטלוג
                  </button>
                </div>
              </>
            )}

            {calculateView === "save_success" && (
              <div style={centerStyle}>
                <div style={successCircleStyle}>
                  <CheckIcon size={44} color={TOKEN.semantic.success.ink} />
                </div>
                <div style={{ ...centerTitleStyle, fontSize: TOKEN.font.display }}>
                  העלויות נשמרו לפריט
                </div>
                <div style={centerSubStyle}>בפעם הבאה החישוב ייטען עם העלויות האלה</div>
                <div style={successActionsStyle}>
                  <button
                    type="button"
                    style={primaryBtnStyle(false)}
                    className="pricing-pressable"
                    onClick={() => {
                      if (selectedItemId) openCalculate(selectedItemId);
                    }}
                  >
                    תמחר שוב
                  </button>
                  <button
                    type="button"
                    style={ghostBtnStyle}
                    className="pricing-pressable"
                    onClick={openCatalog}
                  >
                    חזרה לקטלוג
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ——— הוספת פריט ——— */}
        {activePanel === "create" && createView === "wizard" && (
          <>
            <div style={detailHeadStyle}>
              <BackButton
                onClick={() => {
                  if (createStep > 1) {
                    setCreateStep(1);
                    return;
                  }
                  openCatalog();
                }}
              />
              <div style={detailTitleStyle}>פריט חדש</div>
              <div style={iconBtnSpacerStyle} />
            </div>

            <div style={stepsRowStyle} aria-label={`שלב ${createStep} מתוך 2`}>
              <span style={stepPillStyle(createStep >= 1)}>פרטים</span>
              <span style={stepArrowStyle}>›</span>
              <span style={stepPillStyle(createStep >= 2)}>עלויות</span>
            </div>

            {createError ? (
              <p style={errorStyle} role="alert">
                {createError}
              </p>
            ) : null}

            <div style={{ ...scrollPadStyle, paddingBottom: 120 }}>
              {createStep === 1 ? (
                <>
                  <Field
                    id="new-name"
                    label="שם הפריט"
                    value={newItemName}
                    onChange={setNewItemName}
                    placeholder="לדוגמה: ייעוץ אסטרטגי"
                    numeric={false}
                  />
                  <div style={fieldStyle}>
                    <span style={labelStyle}>סוג</span>
                    <div style={segStyle}>
                      <button
                        type="button"
                        style={segBtnStyle(newItemType === "SERVICE")}
                        onClick={() => setNewItemType("SERVICE")}
                      >
                        שירות
                      </button>
                      <button
                        type="button"
                        style={segBtnStyle(newItemType === "PRODUCT")}
                        onClick={() => setNewItemType("PRODUCT")}
                      >
                        מוצר
                      </button>
                    </div>
                  </div>
                  <div style={fieldStyle}>
                    <label style={labelStyle} htmlFor="new-cat">
                      קטגוריה <span style={labelUnitStyle}>(אופציונלי)</span>
                    </label>
                    <select
                      id="new-cat"
                      style={inputStyle}
                      className="pricing-input"
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
                  <p style={{ ...sectionLabelStyle, paddingTop: TOKEN.space.lg }}>עלויות</p>
                  <p style={{ ...hintStyle, padding: `0 ${TOKEN.space.xl}px`, marginTop: 0 }}>
                    ארבעה מספרים — הבסיס לחישוב המחיר
                  </p>
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
            </div>

            <div style={bottomBarStyle}>
              <button
                type="button"
                style={primaryBtnStyle(creatingItem)}
                className="pricing-pressable"
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
                {creatingItem ? "שומר…" : createStep < 2 ? "המשך לעלויות" : "צור פריט"}
              </button>
              <button
                type="button"
                style={ghostBtnStyle}
                className="pricing-pressable"
                onClick={openCatalog}
              >
                ביטול
              </button>
            </div>
          </>
        )}

        {activePanel === "create" && createView === "success" && (
          <div style={centerStyle}>
            <div style={successCircleStyle}>
              <CheckIcon size={44} color={TOKEN.semantic.success.ink} />
            </div>
            <div style={{ ...centerTitleStyle, fontSize: TOKEN.font.display }}>
              הפריט נוסף בהצלחה
            </div>
            <div style={successActionsStyle}>
              <button
                type="button"
                style={primaryBtnStyle(false)}
                className="pricing-pressable"
                onClick={() => {
                  if (selectedItemId) openCalculate(selectedItemId);
                }}
              >
                תמחור עכשיו
              </button>
              <button
                type="button"
                style={ghostBtnStyle}
                className="pricing-pressable"
                onClick={openCatalog}
              >
                חזרה לקטלוג
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  unit,
  value,
  onChange,
  placeholder,
  hint,
  numeric = true,
}: {
  id: string;
  label: string;
  unit?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  numeric?: boolean;
}) {
  return (
    <div style={fieldStyle}>
      <label style={labelStyle} htmlFor={id}>
        {label}
        {unit ? <span style={labelUnitStyle}> {unit}</span> : null}
      </label>
      <input
        id={id}
        className="pricing-input"
        style={inputStyle}
        type={numeric ? "number" : "text"}
        inputMode={numeric ? "decimal" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "0"}
      />
      {hint ? <p style={hintStyle}>{hint}</p> : null}
    </div>
  );
}

function MarketBar({
  market,
  price,
}: {
  market: { low: number; high: number; positionRatio?: number | null };
  price: number;
}) {
  const span = market.high - market.low;
  const rawRatio =
    typeof market.positionRatio === "number"
      ? market.positionRatio
      : span > 0
        ? (price - market.low) / span
        : 0;
  const ratio = Math.min(1, Math.max(0, rawRatio));
  const pct = `${Math.round(ratio * 100)}%`;

  return (
    <div style={{ margin: `0 ${TOKEN.space.xl}px` }}>
      <div style={marketLabelsStyle}>
        <span>₪{formatNis(market.low)}</span>
        <span style={{ color: TOKEN.semantic.success.ink }}>המחיר שלך ₪{formatNis(price)}</span>
        <span>₪{formatNis(market.high)}</span>
      </div>
      <div style={marketTrackStyle}>
        <div style={{ ...marketFillStyle, right: 0, width: pct }} />
        <div style={{ ...marketDotStyle, right: pct }} />
      </div>
    </div>
  );
}

function PricingGlobalStyles() {
  return (
    <style jsx global>{`
      @keyframes pricing-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .pricing-spin {
        width: 46px;
        height: 46px;
        border-radius: 50%;
        border: 4px solid ${TOKEN.surface.inset};
        border-top-color: ${TOKEN.brand.mid};
        animation: pricing-spin 0.8s linear infinite;
      }
      .pricing-input:focus {
        border-color: ${TOKEN.brand.mid};
        background: ${TOKEN.surface.card};
        box-shadow: 0 0 0 3px ${TOKEN.brand.focus};
      }
      .pricing-pressable {
        transition: opacity ${TOKEN.transition.fast}, transform ${TOKEN.transition.fast};
      }
      .pricing-pressable:active:not(:disabled) {
        transform: scale(0.99);
      }
      @media (prefers-reduced-motion: reduce) {
        .pricing-spin {
          animation: none;
        }
      }
      @media (max-width: 480px) {
        .pricing-shell {
          border-radius: 0 !important;
          box-shadow: none !important;
        }
      }
    `}</style>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Styles — derived entirely from lib/design/tokens.ts (TOKEN). No hardcoded
   action color, no embedded CSS string. Action surfaces use the brand gradient;
   interactive text uses brand.mid; the navy-tinted CTA shadow is TOKEN.brand.navy.
   ──────────────────────────────────────────────────────────────────────────── */

const rootStyle: CSSProperties = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  display: "flex",
  justifyContent: "center",
  color: TOKEN.ink.primary,
  fontFamily: "Heebo, -apple-system, system-ui, sans-serif",
};

const shellStyle: CSSProperties = {
  width: "100%",
  maxWidth: 460,
  minHeight: "100vh",
  background: TOKEN.surface.card,
  position: "relative",
  display: "flex",
  flexDirection: "column",
  boxShadow: TOKEN.shadow.floating,
  boxSizing: "border-box",
};

const scrollPadStyle: CSSProperties = {
  flex: 1,
  paddingBottom: TOKEN.space["3xl"],
};

const catalogHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: TOKEN.space.md,
  padding: `${TOKEN.space.xl}px ${TOKEN.space.xl}px ${TOKEN.space.sm}px`,
};

const pageTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 26,
  fontWeight: TOKEN.weight.bold,
  letterSpacing: "-0.4px",
  color: TOKEN.ink.primary,
};

const pageSubtitleStyle: CSSProperties = {
  margin: `${TOKEN.space.sm}px 0 0`,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.medium,
  color: TOKEN.ink.muted,
};

const addRoundBtnStyle: CSSProperties = {
  ...iconActionStyle(true),
  width: 44,
  height: 44,
};

const mutedNoteStyle: CSSProperties = {
  padding: `0 ${TOKEN.space.xl}px`,
  color: TOKEN.ink.meta,
  fontSize: TOKEN.font.body,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: `${TOKEN.space.md}px ${TOKEN.space.xl}px 0`,
  display: "flex",
  flexDirection: "column",
  gap: TOKEN.space.md,
};

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: TOKEN.space.md,
  width: "100%",
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  padding: TOKEN.space.lg,
  background: TOKEN.surface.card,
  textAlign: "right",
  cursor: "pointer",
  fontFamily: "inherit",
  boxShadow: TOKEN.shadow.elevated,
};

const itemAvatarStyle: CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: TOKEN.radius.input,
  background: TOKEN.surface.inset,
  color: TOKEN.brand.mid,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: TOKEN.font.display,
  fontWeight: TOKEN.weight.bold,
  flexShrink: 0,
};

const itemBodyStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const itemNameStyle: CSSProperties = {
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
};

const itemMetaStyle: CSSProperties = {
  fontSize: TOKEN.font.meta,
  color: TOKEN.ink.muted,
  fontWeight: TOKEN.weight.medium,
};

const itemTrailStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: TOKEN.space.sm,
  flexShrink: 0,
};

const chevStyle: CSSProperties = {
  color: TOKEN.ink.disabled,
  display: "flex",
};

function pillStyle(type: string): CSSProperties {
  const isService = type !== "PRODUCT";
  return {
    fontSize: TOKEN.font.caption,
    fontWeight: TOKEN.weight.bold,
    padding: "4px 10px",
    borderRadius: TOKEN.radius.pill,
    whiteSpace: "nowrap",
    background: isService ? TOKEN.semantic.info.bgSoft : TOKEN.surface.inset,
    color: isService ? TOKEN.semantic.info.ink : TOKEN.ink.secondary,
  };
}

const infoBoxStyle: CSSProperties = {
  margin: `${TOKEN.space.xl}px ${TOKEN.space.xl}px 0`,
  padding: `${TOKEN.space.md}px ${TOKEN.space.lg}px`,
  background: TOKEN.surface.inset,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  fontSize: TOKEN.font.meta,
  lineHeight: 1.55,
  color: TOKEN.ink.muted,
};

const emptyStateStyle: CSSProperties = {
  textAlign: "center",
  padding: `${TOKEN.space["3xl"]}px ${TOKEN.space.md}px`,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: TOKEN.space.xl,
};

const emptyTextStyle: CSSProperties = {
  margin: 0,
  fontSize: TOKEN.font.body,
  color: TOKEN.ink.muted,
  lineHeight: 1.6,
  maxWidth: 300,
};

const detailHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: TOKEN.space.sm,
  padding: `${TOKEN.space.md}px ${TOKEN.space.lg}px ${TOKEN.space.xs}px`,
};

const iconBtnSpacerStyle: CSSProperties = {
  width: 42,
  height: 42,
  flexShrink: 0,
};

const detailTitleStyle: CSSProperties = {
  flex: 1,
  textAlign: "center",
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
};

const detailSubStyle: CSSProperties = {
  display: "block",
  fontSize: TOKEN.font.meta,
  color: TOKEN.ink.muted,
  fontWeight: TOKEN.weight.medium,
  marginTop: 1,
};

const fieldStyle: CSSProperties = {
  padding: `0 ${TOKEN.space.xl}px`,
  marginTop: TOKEN.space.lg,
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  marginBottom: TOKEN.space.sm,
  color: TOKEN.ink.primary,
};

const labelUnitStyle: CSSProperties = {
  color: TOKEN.ink.muted,
  fontWeight: TOKEN.weight.medium,
};

const inputStyle: CSSProperties = {
  width: "100%",
  height: 50,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.input,
  background: TOKEN.surface.inset,
  padding: `0 ${TOKEN.space.lg}px`,
  fontFamily: "inherit",
  fontSize: TOKEN.font.title,
  color: TOKEN.ink.primary,
  outline: "none",
  boxSizing: "border-box",
};

const hintStyle: CSSProperties = {
  fontSize: TOKEN.font.meta,
  color: TOKEN.ink.muted,
  fontWeight: TOKEN.weight.regular,
  marginTop: TOKEN.space.xs + 2,
  lineHeight: 1.4,
};

const segStyle: CSSProperties = {
  display: "flex",
  gap: TOKEN.space.sm,
};

function segBtnStyle(active: boolean): CSSProperties {
  return {
    ...chipActionStyle(active),
    flex: 1,
    fontSize: TOKEN.font.body,
    minHeight: 42,
  };
}

const accordionStyle: CSSProperties = {
  margin: `${TOKEN.space.lg}px ${TOKEN.space.xl}px 0`,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  overflow: "hidden",
};

const accordionHeadStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: TOKEN.space.lg,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
  background: TOKEN.surface.card,
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  textAlign: "right",
};

const accordionBodyStyle: CSSProperties = {
  padding: `0 ${TOKEN.space.lg}px ${TOKEN.space.lg}px`,
  display: "flex",
  gap: TOKEN.space.md,
};

const footnoteStyle: CSSProperties = {
  margin: `${TOKEN.space.sm}px ${TOKEN.space.xl}px 0`,
  fontSize: TOKEN.font.meta,
  color: TOKEN.ink.meta,
  textAlign: "center",
};

const bottomBarStyle: CSSProperties = {
  position: "sticky",
  bottom: 0,
  display: "flex",
  flexDirection: "column",
  gap: TOKEN.space.sm,
  padding: `${TOKEN.space.md}px ${TOKEN.space.xl}px ${TOKEN.space["2xl"]}px`,
  background: TOKEN.surface.card,
  borderTop: `1px solid ${TOKEN.border.DEFAULT}`,
  zIndex: 4,
};

function primaryBtnStyle(disabled: boolean): CSSProperties {
  return {
    ...primaryActionStyle({ disabled, fullWidth: true, height: 54 }),
    width: "100%",
    height: 54,
    fontSize: TOKEN.font.title,
  };
}

const ghostBtnStyle: CSSProperties = {
  ...glassActionStyle({ fullWidth: true, height: 50 }),
  width: "100%",
  height: 50,
};

const errorStyle: CSSProperties = {
  margin: `${TOKEN.space.lg}px ${TOKEN.space.xl}px 0`,
  padding: `${TOKEN.space.md}px ${TOKEN.space.lg}px`,
  background: TOKEN.semantic.urgent.bgSoft,
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  borderRadius: TOKEN.radius.input,
  color: TOKEN.semantic.urgent.ink,
  fontSize: TOKEN.font.body,
  lineHeight: 1.5,
};

const heroStyle: CSSProperties = {
  margin: `${TOKEN.space.md}px ${TOKEN.space.xl}px 0`,
  borderRadius: TOKEN.radius.modal,
  padding: TOKEN.space["2xl"],
  background: TOKEN.brand.gradient,
  color: TOKEN.ink.inverse,
  textAlign: "center",
  boxShadow: "0 16px 34px rgba(36, 59, 87, 0.30)",
};

const heroLabelStyle: CSSProperties = {
  fontSize: TOKEN.font.body,
  opacity: 0.9,
  fontWeight: TOKEN.weight.medium,
};

const heroPriceStyle: CSSProperties = {
  fontSize: 46,
  fontWeight: TOKEN.weight.bold,
  letterSpacing: "-1px",
  margin: `${TOKEN.space.xs}px 0 ${TOKEN.space.md}px`,
};

const heroBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: TOKEN.space.xs + 2,
  background: "rgba(255, 255, 255, 0.18)",
  padding: `${TOKEN.space.xs + 2}px ${TOKEN.space.lg}px`,
  borderRadius: TOKEN.radius.pill,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
};

const tiersRowStyle: CSSProperties = {
  display: "flex",
  gap: TOKEN.space.sm,
  padding: `${TOKEN.space.lg}px ${TOKEN.space.xl}px 0`,
};

function tierStyle(kind: "min" | "rec" | "prem"): CSSProperties {
  const base: CSSProperties = {
    flex: 1,
    border: `1px solid ${TOKEN.border.DEFAULT}`,
    borderRadius: TOKEN.radius.card,
    padding: `${TOKEN.space.md}px ${TOKEN.space.sm}px`,
    textAlign: "center",
  };
  if (kind === "min") {
    return { ...base, background: TOKEN.semantic.urgent.bgSoft, borderColor: TOKEN.semantic.urgent.border };
  }
  if (kind === "rec") {
    return { ...base, background: TOKEN.semantic.info.bgSoft, borderColor: TOKEN.semantic.info.border };
  }
  return { ...base, background: TOKEN.surface.inset };
}

function tierLabelStyle(kind: "min" | "rec" | "prem"): CSSProperties {
  const color =
    kind === "min" ? TOKEN.semantic.urgent.ink : kind === "rec" ? TOKEN.semantic.info.ink : TOKEN.ink.muted;
  return {
    fontSize: TOKEN.font.meta,
    color,
    fontWeight: TOKEN.weight.bold,
  };
}

const tierPriceStyle: CSSProperties = {
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  marginTop: TOKEN.space.xs,
  letterSpacing: "-0.4px",
  color: TOKEN.ink.primary,
};

const breakdownStyle: CSSProperties = {
  margin: `${TOKEN.space.lg}px ${TOKEN.space.xl}px 0`,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  overflow: "hidden",
};

const breakdownRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: TOKEN.space.md,
  padding: `13px ${TOKEN.space.lg}px`,
  borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
  fontSize: TOKEN.font.body,
};

const breakdownTotalStyle: CSSProperties = {
  background: TOKEN.surface.inset,
};

const breakdownKeyStyle: CSSProperties = {
  color: TOKEN.ink.muted,
  fontWeight: TOKEN.weight.medium,
};

const breakdownValStyle: CSSProperties = {
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
  display: "flex",
  alignItems: "center",
  gap: TOKEN.space.sm,
};

const badgeBase: CSSProperties = {
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  padding: "3px 9px",
  borderRadius: TOKEN.radius.pill,
};

const marketNoteStyle: CSSProperties = {
  margin: `${TOKEN.space.lg}px ${TOKEN.space.xl}px 0`,
  background: TOKEN.semantic.success.bgSoft,
  color: TOKEN.semantic.success.ink,
  borderRadius: TOKEN.radius.input,
  padding: `${TOKEN.space.md}px ${TOKEN.space.lg}px`,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  display: "flex",
  alignItems: "center",
  gap: TOKEN.space.sm,
};

const explainStyle: CSSProperties = {
  margin: `${TOKEN.space.lg}px ${TOKEN.space.xl}px 0`,
  background: TOKEN.surface.inset,
  borderRadius: TOKEN.radius.card,
  padding: TOKEN.space.lg,
  fontSize: TOKEN.font.body,
  lineHeight: 1.6,
  color: TOKEN.ink.secondary,
};

const moreLinkStyle: CSSProperties = {
  ...glassActionStyle({ height: 50 }),
  width: `calc(100% - ${TOKEN.space.xl * 2}px)`,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  margin: `${TOKEN.space.lg}px ${TOKEN.space.xl}px 0`,
  fontSize: TOKEN.font.body,
};

const sectionLabelStyle: CSSProperties = {
  padding: `${TOKEN.space.xl}px ${TOKEN.space.xl}px ${TOKEN.space.sm}px`,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
};

const simRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: TOKEN.space.md,
  padding: `13px ${TOKEN.space.lg}px`,
};

const simNameStyle: CSSProperties = {
  display: "block",
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
};

const simSubStyle: CSSProperties = {
  display: "block",
  fontSize: TOKEN.font.meta,
  color: TOKEN.ink.muted,
  fontWeight: TOKEN.weight.medium,
  marginTop: 1,
};

const simPriceStyle: CSSProperties = {
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
};

const marketLabelsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: TOKEN.font.meta,
  color: TOKEN.ink.muted,
  fontWeight: TOKEN.weight.bold,
  marginBottom: TOKEN.space.sm,
};

const marketTrackStyle: CSSProperties = {
  height: 10,
  background: TOKEN.surface.inset,
  borderRadius: TOKEN.radius.chip,
  position: "relative",
};

const marketFillStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  background: TOKEN.semantic.success.accent,
  borderRadius: TOKEN.radius.chip,
};

const marketDotStyle: CSSProperties = {
  position: "absolute",
  top: -3,
  width: 16,
  height: 16,
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.surface.card,
  border: `3px solid ${TOKEN.brand.mid}`,
  transform: "translateX(50%)",
};

const insightsStyle: CSSProperties = {
  margin: `${TOKEN.space.xs + 2}px ${TOKEN.space.xl}px 0`,
};

const insightRowStyle: CSSProperties = {
  display: "flex",
  gap: TOKEN.space.sm,
  padding: `9px 0`,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.regular,
  color: TOKEN.ink.secondary,
};

const insightDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.brand.mid,
  marginTop: 7,
  flexShrink: 0,
};

const stepsRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: TOKEN.space.sm,
  padding: `${TOKEN.space.md}px ${TOKEN.space.xl}px ${TOKEN.space.xs}px`,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
};

function stepPillStyle(active: boolean): CSSProperties {
  return {
    ...chipActionStyle(active),
    cursor: "default",
    boxShadow: active ? TOKEN.action.primary.shadowSoft : TOKEN.shadow.none,
  };
}

const stepArrowStyle: CSSProperties = {
  color: TOKEN.ink.disabled,
};

const centerStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  padding: TOKEN.space["3xl"],
  minHeight: "60vh",
};

const centerTitleStyle: CSSProperties = {
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  marginTop: TOKEN.space.lg,
  color: TOKEN.ink.primary,
};

const centerSubStyle: CSSProperties = {
  fontSize: TOKEN.font.body,
  color: TOKEN.ink.muted,
  fontWeight: TOKEN.weight.regular,
  marginTop: TOKEN.space.xs + 2,
};

const successCircleStyle: CSSProperties = {
  width: 88,
  height: 88,
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.semantic.success.bg,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  marginBottom: TOKEN.space.lg,
};

const successActionsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: TOKEN.space.sm,
  width: "100%",
  maxWidth: 320,
  marginTop: TOKEN.space["2xl"],
};
