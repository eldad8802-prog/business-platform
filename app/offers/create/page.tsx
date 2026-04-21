"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getOfferGuidance } from "@/lib/offers/offer-guidance";
import OfferGuidanceCard from "@/components/offers/offer-guidance-card";

type OfferType = "DISCOUNT" | "GIFT" | "BUNDLE" | "REFERRAL" | "";
type DurationType = "day" | "week" | "month" | "custom";

type BusinessProfileResponse = {
  success?: boolean;
  hasProfile?: boolean;
  profile?: {
    businessName?: string;
    name?: string;
    city?: string;
    address?: string;
    category?: string;
    subCategory?: string;
    businessModel?: string;
  } | null;
  business?: {
    name?: string;
    city?: string;
    address?: string;
  } | null;
};

type CreatedOffer = {
  id: number;
  issuingBusinessId: number;
  title: string;
  description: string | null;
  customerBenefitText: string;
  validUntil: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export default function OfferCreatePage() {
  const router = useRouter();
  const [guidance, setGuidance] = useState<{
    tip: string;
    example: string;
    insight: string;
  } | null>(null);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  const [businessName, setBusinessName] = useState("");
  const [businessLocation, setBusinessLocation] = useState("");

  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [offerType, setOfferType] = useState<OfferType>("");

  const [title, setTitle] = useState("");
  const [customerBenefitText, setCustomerBenefitText] = useState("");
  const [description, setDescription] = useState("");

  const [durationType, setDurationType] = useState<DurationType>("day");
  const [validUntil, setValidUntil] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdOffer, setCreatedOffer] = useState<CreatedOffer | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        setProfileLoading(true);
        setProfileError(null);

        const token = localStorage.getItem("token");

        const res = await fetch("/api/business/profile", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        const data: BusinessProfileResponse = await res.json();

        if (!res.ok) {
          throw new Error("שגיאה בטעינת פרופיל העסק");
        }

        if (data?.profile) {
          const resolvedBusinessName =
            data.profile.businessName ||
            data.profile.name ||
            data.business?.name ||
            "";

          const resolvedBusinessLocation =
            data.profile.city ||
            data.profile.address ||
            data.business?.city ||
            data.business?.address ||
            "";

          setBusinessName(resolvedBusinessName);
          setBusinessLocation(resolvedBusinessLocation);

          setGuidance(
            getOfferGuidance({
              category: data.profile.category,
              subCategory: data.profile.subCategory,
              businessModel: data.profile.businessModel,
            })
          );
        }
      } catch (error) {
        console.error("Failed to load business profile:", error);
        setProfileError("לא הצלחנו לטעון את פרטי העסק");
      } finally {
        setProfileLoading(false);
      }
    };

    run();
  }, []);

  const optionCardStyle = (
    selected: boolean
  ): React.CSSProperties => ({
    textAlign: "right",
    padding: "16px 18px",
    borderRadius: 16,
    border: selected ? "2px solid #111827" : "1px solid #d1d5db",
    background: selected ? "#eef2ff" : "#ffffff",
    cursor: "pointer",
    transition: "all 0.15s ease",
    boxShadow: selected
      ? "0 10px 24px rgba(17,24,39,0.08)"
      : "0 2px 8px rgba(0,0,0,0.04)",
    fontSize: 15,
    lineHeight: 1.6,
  });

  const actionButtonStyle = (
    enabled: boolean
  ): React.CSSProperties => ({
    padding: "12px 18px",
    borderRadius: 12,
    border: "none",
    background: enabled ? "#111827" : "#d1d5db",
    color: "#ffffff",
    cursor: enabled ? "pointer" : "not-allowed",
    fontWeight: 700,
    minWidth: 140,
  });

  const secondaryButtonStyle: React.CSSProperties = {
    padding: "12px 18px",
    borderRadius: 12,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#111827",
    cursor: "pointer",
    fontWeight: 700,
    minWidth: 120,
  };

  const fieldStyle: React.CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid #d1d5db",
    fontSize: 16,
    outline: "none",
    background: "#ffffff",
    boxSizing: "border-box",
  };

  const selectedOfferTypeLabel = useMemo(() => {
    switch (offerType) {
      case "DISCOUNT":
        return "הנחה";
      case "GIFT":
        return "מתנה";
      case "BUNDLE":
        return "חבילה";
      case "REFERRAL":
        return "תגמול על הפניה";
      default:
        return "";
    }
  }, [offerType]);

  const getExamples = () => {
    switch (offerType) {
      case "DISCOUNT":
        return ["10% הנחה על טיפול ראשון", "50₪ הנחה בקנייה מעל 200₪"];
      case "GIFT":
        return ["מוצר מתנה בקנייה מעל סכום מסוים", "טיפול קצר מתנה ללקוח חדש"];
      case "BUNDLE":
        return ["שני שירותים במחיר מיוחד", "חבילת טיפול מלאה בהנחה"];
      case "REFERRAL":
        return ["הבא חבר וקבל 50₪", "המלצה לחבר = הטבה מיוחדת"];
      default:
        return [];
    }
  };

  const calculateValidUntil = (type: Exclude<DurationType, "custom">) => {
    const date = new Date();

    if (type === "day") {
      date.setDate(date.getDate() + 1);
    }

    if (type === "week") {
      date.setDate(date.getDate() + 7);
    }

    if (type === "month") {
      date.setMonth(date.getMonth() + 1);
    }

    date.setHours(23, 59, 59, 999);

    return date.toISOString();
  };

  const handleDurationSelect = (type: DurationType) => {
    setDurationType(type);

    if (type === "custom") {
      setValidUntil("");
      return;
    }

    setValidUntil(calculateValidUntil(type));
  };

  const formatDurationLabel = () => {
    switch (durationType) {
      case "day":
        return "יום אחד";
      case "week":
        return "שבוע";
      case "month":
        return "חודש";
      case "custom":
        return "מותאם אישית";
      default:
        return "";
    }
  };

  const resetForm = () => {
    setStep(1);
    setOfferType("");
    setTitle("");
    setCustomerBenefitText("");
    setDescription("");
    setDurationType("day");
    setValidUntil("");
    setIsSubmitting(false);
    setSubmitError(null);
    setCreatedOffer(null);
  };

  const createOffer = async () => {
    try {
      setIsSubmitting(true);
      setSubmitError(null);

      const token = localStorage.getItem("token");

      if (!token) {
        throw new Error("לא נמצא טוקן התחברות");
      }

      const res = await fetch("/api/offers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() ? description.trim() : undefined,
          customerBenefitText: customerBenefitText.trim(),
          validUntil,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "שגיאה ביצירת ההצעה");
      }

      if (!data?.offer) {
        throw new Error("ההצעה נוצרה אבל לא חזר אובייקט offer");
      }

      setCreatedOffer(data.offer);
      setStep(4);
    } catch (error) {
      console.error("createOffer error:", error);
      setSubmitError(
        error instanceof Error ? error.message : "שגיאה ביצירת ההצעה"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const canContinueStep1 = offerType !== "";
  const canContinueStep2 =
    title.trim().length > 0 && customerBenefitText.trim().length > 0;
  const canContinueStep3 = validUntil.trim().length > 0;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8f6f1",
        padding: "24px 16px",
        direction: "rtl",
      }}
    >
      <div
        style={{
          maxWidth: 760,
          margin: "0 auto",
        }}
      >
        <div
          style={{
            background: "#ffffff",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
            border: "1px solid #ece7dc",
          }}
        >
          {guidance && <OfferGuidanceCard guidance={guidance} />}

          <div style={{ marginBottom: 24 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "6px 12px",
                borderRadius: 999,
                background: "#edf7ee",
                color: "#1f6b3b",
                fontSize: 13,
                fontWeight: 700,
                marginBottom: 12,
              }}
            >
              שכבת קופונים / יצירת הצעה
            </div>

            <h1
              style={{
                margin: 0,
                fontSize: 30,
                lineHeight: 1.2,
                color: "#1f2937",
              }}
            >
              בונים הצעה שתהיה ברורה, פשוטה ושימושית באמת
            </h1>

            <p
              style={{
                marginTop: 12,
                marginBottom: 0,
                fontSize: 16,
                lineHeight: 1.7,
                color: "#4b5563",
              }}
            >
              זהו השלב הראשון בזרימת הקופונים. כאן יוצרים הצעה שאפשר יהיה להנפיק
              ממנה קופון בשלב הבא.
            </p>
          </div>

          {step !== 4 && (
            <>
              <div
                style={{
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  borderRadius: 18,
                  padding: 16,
                  marginBottom: 24,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#6b7280",
                    marginBottom: 8,
                  }}
                >
                  ההצעה נוצרת עבור העסק:
                </div>

                {profileLoading ? (
                  <div
                    style={{
                      fontSize: 16,
                      color: "#374151",
                      fontWeight: 600,
                    }}
                  >
                    טוען פרטי עסק...
                  </div>
                ) : profileError ? (
                  <div
                    style={{
                      fontSize: 15,
                      color: "#b91c1c",
                      fontWeight: 600,
                    }}
                  >
                    {profileError}
                  </div>
                ) : (
                  <div>
                    <div
                      style={{
                        fontSize: 20,
                        fontWeight: 800,
                        color: "#111827",
                      }}
                    >
                      {businessName}
                    </div>

                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 15,
                        color: "#6b7280",
                        fontWeight: 500,
                      }}
                    >
                      {businessLocation}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h2
                style={{
                  marginTop: 0,
                  marginBottom: 10,
                  fontSize: 24,
                  color: "#111827",
                }}
              >
                איזה סוג הצעה אתה רוצה ליצור?
              </h2>

              <p
                style={{
                  marginTop: 0,
                  marginBottom: 20,
                  fontSize: 15,
                  lineHeight: 1.7,
                  color: "#6b7280",
                }}
              >
                בחר סוג הצעה פשוט וברור. ככל שההצעה ברורה יותר, כך יהיה קל יותר
                להסביר אותה, לשלוח אותה ללקוח, ולהפוך אותה לשימוש אמיתי.
              </p>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 14,
                }}
              >
                <button
                  type="button"
                  onClick={() => setOfferType("DISCOUNT")}
                  style={optionCardStyle(offerType === "DISCOUNT")}
                >
                  <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8 }}>
                    הנחה
                  </div>
                  <div style={{ color: "#6b7280" }}>
                    למשל 10% על טיפול ראשון או 50₪ הנחה בקנייה מעל סכום מסוים
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setOfferType("GIFT")}
                  style={optionCardStyle(offerType === "GIFT")}
                >
                  <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8 }}>
                    מתנה
                  </div>
                  <div style={{ color: "#6b7280" }}>
                    למשל מוצר מתנה, טיפול קצר מתנה, או תוספת ערך בקנייה
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setOfferType("BUNDLE")}
                  style={optionCardStyle(offerType === "BUNDLE")}
                >
                  <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8 }}>
                    חבילה
                  </div>
                  <div style={{ color: "#6b7280" }}>
                    למשל שני שירותים ביחד במחיר טוב יותר או חבילת טיפול מלאה
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setOfferType("REFERRAL")}
                  style={optionCardStyle(offerType === "REFERRAL")}
                >
                  <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8 }}>
                    תגמול על הפניה
                  </div>
                  <div style={{ color: "#6b7280" }}>
                    למשל הבא חבר וקבל הטבה או הטבה שמבוססת על המלצה
                  </div>
                </button>
              </div>

              <div
                style={{
                  marginTop: 16,
                  minHeight: 24,
                  color: offerType ? "#111827" : "#6b7280",
                  fontWeight: 600,
                }}
              >
                {offerType
                  ? `נבחר סוג הצעה: ${selectedOfferTypeLabel}`
                  : "עדיין לא נבחר סוג הצעה"}
              </div>

              <div
                style={{
                  marginTop: 28,
                  display: "flex",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  disabled={!canContinueStep1}
                  onClick={() => setStep(2)}
                  style={actionButtonStyle(canContinueStep1)}
                >
                  המשך
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2
                style={{
                  marginTop: 0,
                  marginBottom: 10,
                  fontSize: 24,
                  color: "#111827",
                }}
              >
                מה הלקוח יקבל בפועל?
              </h2>

              <p
                style={{
                  marginTop: 0,
                  marginBottom: 16,
                  fontSize: 15,
                  lineHeight: 1.7,
                  color: "#6b7280",
                }}
              >
                כאן מנסחים את ליבת ההצעה. הצעה טובה היא הצעה שקל להבין במשפט אחד,
                ושלקוח באמת ירצה להשתמש בה.
              </p>

              <div
                style={{
                  marginBottom: 20,
                  padding: 16,
                  borderRadius: 16,
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                }}
              >
                <div
                  style={{
                    fontWeight: 800,
                    marginBottom: 10,
                    color: "#111827",
                  }}
                >
                  דוגמאות לפי סוג ההצעה שנבחר:
                </div>

                <ul
                  style={{
                    margin: 0,
                    paddingRight: 18,
                    lineHeight: 1.9,
                    color: "#4b5563",
                  }}
                >
                  {getExamples().map((example, index) => (
                    <li key={index}>{example}</li>
                  ))}
                </ul>
              </div>

              <div style={{ display: "grid", gap: 14 }}>
                <div>
                  <label
                    style={{
                      display: "block",
                      marginBottom: 8,
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    איך תקרא להצעה?
                  </label>
                  <input
                    type="text"
                    placeholder="למשל: הנחה ללקוחות חדשים"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    style={fieldStyle}
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      marginBottom: 8,
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    מה הלקוח מקבל?
                  </label>
                  <input
                    type="text"
                    placeholder="למשל: 10% הנחה על טיפול ראשון"
                    value={customerBenefitText}
                    onChange={(e) => setCustomerBenefitText(e.target.value)}
                    style={fieldStyle}
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      marginBottom: 8,
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    יש משהו חשוב שהלקוח צריך לדעת? (אופציונלי)
                  </label>
                  <textarea
                    placeholder="למשל: בתיאום מראש בלבד, ללקוחות חדשים בלבד"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={5}
                    style={{
                      ...fieldStyle,
                      resize: "vertical",
                    }}
                  />
                </div>
              </div>

              <div
                style={{
                  marginTop: 24,
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  style={secondaryButtonStyle}
                >
                  חזור
                </button>

                <button
                  type="button"
                  disabled={!canContinueStep2}
                  onClick={() => setStep(3)}
                  style={actionButtonStyle(canContinueStep2)}
                >
                  המשך
                </button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h2
                style={{
                  marginTop: 0,
                  marginBottom: 10,
                  fontSize: 24,
                  color: "#111827",
                }}
              >
                כמה זמן ההצעה תהיה תקפה?
              </h2>

              <p
                style={{
                  marginTop: 0,
                  marginBottom: 16,
                  fontSize: 15,
                  lineHeight: 1.7,
                  color: "#6b7280",
                }}
              >
                בחר תוקף ברור להצעה. תוקף מוגדר היטב נותן אמינות, מונע בלבול,
                ומכין את ההצעה להנפקה אמיתית.
              </p>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: 12,
                }}
              >
                <button
                  type="button"
                  onClick={() => handleDurationSelect("day")}
                  style={optionCardStyle(durationType === "day")}
                >
                  יום אחד
                </button>

                <button
                  type="button"
                  onClick={() => handleDurationSelect("week")}
                  style={optionCardStyle(durationType === "week")}
                >
                  שבוע
                </button>

                <button
                  type="button"
                  onClick={() => handleDurationSelect("month")}
                  style={optionCardStyle(durationType === "month")}
                >
                  חודש
                </button>

                <button
                  type="button"
                  onClick={() => handleDurationSelect("custom")}
                  style={optionCardStyle(durationType === "custom")}
                >
                  מותאם אישית
                </button>
              </div>

              {durationType === "custom" && (
                <div style={{ marginTop: 18 }}>
                  <label
                    style={{
                      display: "block",
                      marginBottom: 8,
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    בחר תאריך סיום
                  </label>

                  <input
                    type="date"
                    value={
                      validUntil
                        ? new Date(validUntil).toISOString().split("T")[0]
                        : ""
                    }
                    onChange={(e) => {
                      if (!e.target.value) {
                        setValidUntil("");
                        return;
                      }

                      const customDate = new Date(e.target.value);
                      customDate.setHours(23, 59, 59, 999);
                      setValidUntil(customDate.toISOString());
                    }}
                    style={fieldStyle}
                  />
                </div>
              )}

              {validUntil && (
                <div
                  style={{
                    marginTop: 18,
                    padding: 16,
                    borderRadius: 16,
                    background: "#f0fdf4",
                    border: "1px solid #bbf7d0",
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#166534",
                      marginBottom: 6,
                    }}
                  >
                    נבחר תוקף להצעה
                  </div>

                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 800,
                      color: "#14532d",
                      marginBottom: 6,
                    }}
                  >
                    {formatDurationLabel()}
                  </div>

                  <div
                    style={{
                      fontSize: 14,
                      lineHeight: 1.6,
                      color: "#166534",
                    }}
                  >
                    תוקף עד: {new Date(validUntil).toLocaleDateString("he-IL")}
                  </div>
                </div>
              )}

              {submitError && (
                <div
                  style={{
                    marginTop: 18,
                    padding: 14,
                    borderRadius: 14,
                    background: "#fff5f5",
                    border: "1px solid #fecaca",
                    color: "#b91c1c",
                    fontWeight: 600,
                  }}
                >
                  {submitError}
                </div>
              )}

              <div
                style={{
                  marginTop: 24,
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  style={secondaryButtonStyle}
                  disabled={isSubmitting}
                >
                  חזור
                </button>

                <button
                  type="button"
                  disabled={!canContinueStep3 || isSubmitting}
                  onClick={createOffer}
                  style={actionButtonStyle(canContinueStep3 && !isSubmitting)}
                >
                  {isSubmitting ? "יוצר הצעה..." : "צור הצעה"}
                </button>
              </div>
            </>
          )}

          {step === 4 && createdOffer && (
            <>
              <div
                style={{
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: 18,
                  padding: 18,
                  marginBottom: 24,
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 800,
                    color: "#166534",
                    marginBottom: 8,
                  }}
                >
                  ההצעה נוצרה בהצלחה
                </div>

                <div
                  style={{
                    fontSize: 28,
                    fontWeight: 900,
                    color: "#14532d",
                    lineHeight: 1.2,
                  }}
                >
                  ההצעה שלך מוכנה לשלב הבא 🎉
                </div>

                <p
                  style={{
                    marginTop: 10,
                    marginBottom: 0,
                    color: "#166534",
                    lineHeight: 1.7,
                    fontSize: 15,
                  }}
                >
                  זהו השלב הראשון בזרימת הקופונים. עכשיו אפשר להמשיך ישירות
                  להנפקת קופון מתוך ההצעה שיצרת.
                </p>
              </div>

              <div
                style={{
                  background: "#ffffff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 18,
                  padding: 18,
                  marginBottom: 24,
                  boxShadow: "0 8px 20px rgba(0,0,0,0.04)",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#6b7280",
                    marginBottom: 8,
                  }}
                >
                  סיכום ההצעה שנוצרה
                </div>

                <div
                  style={{
                    display: "inline-flex",
                    padding: "6px 10px",
                    borderRadius: 999,
                    background: "#f3f4f6",
                    color: "#111827",
                    fontSize: 13,
                    fontWeight: 700,
                    marginBottom: 14,
                  }}
                >
                  {selectedOfferTypeLabel}
                </div>

                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 900,
                    color: "#111827",
                    marginBottom: 12,
                  }}
                >
                  {createdOffer.title}
                </div>

                <div
                  style={{
                    fontSize: 15,
                    lineHeight: 1.8,
                    color: "#374151",
                    marginBottom: 12,
                  }}
                >
                  <strong>מה הלקוח מקבל:</strong>{" "}
                  {createdOffer.customerBenefitText}
                </div>

                {createdOffer.description && (
                  <div
                    style={{
                      fontSize: 15,
                      lineHeight: 1.8,
                      color: "#374151",
                      marginBottom: 12,
                    }}
                  >
                    <strong>פירוט נוסף:</strong> {createdOffer.description}
                  </div>
                )}

                <div
                  style={{
                    fontSize: 15,
                    lineHeight: 1.8,
                    color: "#374151",
                    marginBottom: 12,
                  }}
                >
                  <strong>תוקף עד:</strong>{" "}
                  {new Date(createdOffer.validUntil).toLocaleDateString("he-IL")}
                </div>

                <div
                  style={{
                    fontSize: 14,
                    color: "#6b7280",
                  }}
                >
                  מזהה הצעה: #{createdOffer.id}
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  onClick={() =>
                    router.push(`/revenue/issue?offerId=${createdOffer.id}`)
                  }
                  style={actionButtonStyle(true)}
                >
                  המשך להנפקת קופון
                </button>

                <button
                  type="button"
                  onClick={() => router.push("/promotions/coupons")}
                  style={secondaryButtonStyle}
                >
                  חזרה לשכבת הקופונים
                </button>

                <button
                  type="button"
                  onClick={resetForm}
                  style={secondaryButtonStyle}
                >
                  צור הצעה נוספת
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}