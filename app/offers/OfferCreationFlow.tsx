"use client";

import { useEffect, useMemo, useState } from "react";

type OfferType = "DISCOUNT" | "GIFT" | "BUNDLE" | "REFERRAL" | "";

type BusinessProfileResponse = {
  profile?: {
    businessName?: string;
    name?: string;
    city?: string;
    address?: string;
  };
  business?: {
    name?: string;
    city?: string;
    address?: string;
  };
};

type OfferFormState = {
  offerType: OfferType;
  title: string;
  description: string;
  customerBenefitText: string;
  validUntil: string;
};

const offerTypeOptions: Array<{
  value: Exclude<OfferType, "">;
  title: string;
  description: string;
}> = [
  {
    value: "DISCOUNT",
    title: "הנחה",
    description: "למשל: 10% הנחה על טיפול ראשון",
  },
  {
    value: "GIFT",
    title: "מתנה",
    description: "למשל: מוצר מתנה בקנייה מעל סכום מסוים",
  },
  {
    value: "BUNDLE",
    title: "חבילה",
    description: "למשל: שירות משולב במחיר מיוחד",
  },
  {
    value: "REFERRAL",
    title: "תגמול על הפניה",
    description: "למשל: הטבה שניתנת דרך הפניית לקוח",
  },
];

export default function OfferCreationFlow() {
  const [step, setStep] = useState(1);

  const [form, setForm] = useState<OfferFormState>({
    offerType: "",
    title: "",
    description: "",
    customerBenefitText: "",
    validUntil: "",
  });

  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState("");
  const [businessLocation, setBusinessLocation] = useState("");

  const selectedOfferType = useMemo(() => {
    return offerTypeOptions.find((option) => option.value === form.offerType) || null;
  }, [form.offerType]);

  useEffect(() => {
    const loadBusinessProfile = async () => {
      try {
        setProfileLoading(true);
        setProfileError(null);

        const token = localStorage.getItem("token");

        if (!token) {
          setProfileError("לא נמצא טוקן התחברות. התחבר מחדש.");
          return;
        }

        const res = await fetch("/api/business/profile", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          cache: "no-store",
        });

        const data: BusinessProfileResponse = await res.json();

        if (res.status === 401) {
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          setProfileError("פג תוקף ההתחברות. התחבר מחדש.");
          return;
        }

        if (!res.ok) {
          throw new Error("טעינת פרטי העסק נכשלה");
        }

        const resolvedBusinessName =
          data?.profile?.businessName ||
          data?.profile?.name ||
          data?.business?.name ||
          "";

        const resolvedBusinessLocation =
          data?.profile?.city ||
          data?.profile?.address ||
          data?.business?.city ||
          data?.business?.address ||
          "";

        setBusinessName(resolvedBusinessName);
        setBusinessLocation(resolvedBusinessLocation);
      } catch (error) {
        console.error("Failed to load business profile:", error);
        setProfileError("לא הצלחנו לטעון את פרטי העסק כרגע.");
      } finally {
        setProfileLoading(false);
      }
    };

    loadBusinessProfile();
  }, []);

  const handleSelectOfferType = (offerType: Exclude<OfferType, "">) => {
    setForm((prev) => ({
      ...prev,
      offerType,
    }));
  };

  const canContinue = !!form.offerType;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8f6f1",
        padding: "24px 16px",
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
              יצירת הצעה חדשה
            </div>

            <h1
              style={{
                margin: 0,
                fontSize: 30,
                lineHeight: 1.2,
                color: "#1f2937",
              }}
            >
              איזה סוג הצעה אתה רוצה ליצור?
            </h1>

            <p
              style={{
                marginTop: 12,
                marginBottom: 0,
                fontSize: 16,
                lineHeight: 1.6,
                color: "#4b5563",
              }}
            >
              בחר סוג הצעה ברור ופשוט, כזה שלקוח באמת ירצה להשתמש בו ושיהיה קל להסביר
              ולהפעיל בהמשך.
            </p>
          </div>

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
                  {businessName || "שם העסק לא זמין כרגע"}
                </div>

                <div
                  style={{
                    marginTop: 6,
                    fontSize: 15,
                    color: "#6b7280",
                    fontWeight: 500,
                  }}
                >
                  {businessLocation || "מיקום העסק לא זמין כרגע"}
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 14,
            }}
          >
            {offerTypeOptions.map((option) => {
              const isSelected = form.offerType === option.value;

              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelectOfferType(option.value)}
                  style={{
                    textAlign: "right",
                    background: isSelected ? "#eef8f0" : "#ffffff",
                    border: isSelected ? "2px solid #1f6b3b" : "1px solid #d1d5db",
                    borderRadius: 18,
                    padding: 18,
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                  }}
                >
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 800,
                      color: "#111827",
                      marginBottom: 8,
                    }}
                  >
                    {option.title}
                  </div>

                  <div
                    style={{
                      fontSize: 14,
                      lineHeight: 1.5,
                      color: "#6b7280",
                    }}
                  >
                    {option.description}
                  </div>

                  {isSelected && (
                    <div
                      style={{
                        marginTop: 14,
                        fontSize: 13,
                        fontWeight: 700,
                        color: "#1f6b3b",
                      }}
                    >
                      נבחר
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 24,
              padding: 16,
              borderRadius: 18,
              background: "#fcfbf7",
              border: "1px solid #ece7dc",
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 800,
                color: "#374151",
                marginBottom: 8,
              }}
            >
              טיפ לבחירה נכונה
            </div>

            <div
              style={{
                fontSize: 15,
                lineHeight: 1.7,
                color: "#6b7280",
              }}
            >
              בחר סוג הצעה שקל להסביר במשפט אחד. ככל שההצעה ברורה יותר, כך יהיה קל יותר
              להנפיק אותה, לשלוח אותה ללקוח, ולהפוך אותה לשימוש אמיתי.
            </div>
          </div>

          {selectedOfferType && (
            <div
              style={{
                marginTop: 20,
                padding: 16,
                borderRadius: 18,
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
                נבחר סוג הצעה
              </div>

              <div
                style={{
                  fontSize: 18,
                  fontWeight: 800,
                  color: "#14532d",
                  marginBottom: 6,
                }}
              >
                {selectedOfferType.title}
              </div>

              <div
                style={{
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: "#166534",
                }}
              >
                {selectedOfferType.description}
              </div>
            </div>
          )}

          <div
            style={{
              marginTop: 28,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                fontSize: 14,
                color: "#6b7280",
                fontWeight: 600,
              }}
            >
              שלב 1 מתוך 4
            </div>

            <button
              type="button"
              disabled={!canContinue}
              onClick={() => setStep(2)}
              style={{
                border: "none",
                borderRadius: 14,
                padding: "14px 22px",
                fontSize: 15,
                fontWeight: 800,
                cursor: canContinue ? "pointer" : "not-allowed",
                background: canContinue ? "#1f6b3b" : "#cbd5e1",
                color: "#ffffff",
                minWidth: 140,
              }}
            >
              המשך
            </button>
          </div>

          {step === 2 && (
            <div
              style={{
                marginTop: 20,
                padding: 16,
                borderRadius: 18,
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                fontSize: 15,
                fontWeight: 700,
                color: "#1d4ed8",
              }}
            >
              שלב 1 הושלם. בשלב הבא נבנה את אזור הזנת הערך ללקוח.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}