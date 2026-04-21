"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import RedeemScanner from "./redeem-scanner";

type FlowState = "scan" | "idle" | "validating" | "success" | "error";

type RedeemResult = {
  coupon?: {
    id?: number | string;
    token?: string;
    status?: string;
    offer?: {
      title?: string;
      customerBenefitText?: string;
      description?: string;
    };
  };
  redemptionEvent?: {
    id?: number | string;
    redeemedAt?: string;
  };
};

type InputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onBackToScan: () => void;
};

function InlineRedeemInput({
  value,
  onChange,
  onSubmit,
  onBackToScan,
}: InputProps) {
  return (
    <div
      style={{
        background: "#ffffff",
        padding: 20,
        borderRadius: 20,
        border: "1px solid #e5e7eb",
      }}
    >
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: "#111827",
          marginBottom: 8,
          textAlign: "right",
        }}
      >
        מימוש קופון
      </div>

      <div
        style={{
          fontSize: 14,
          color: "#6b7280",
          marginBottom: 16,
          textAlign: "right",
          lineHeight: 1.5,
        }}
      >
        הדבק או הקלד קוד קופון כדי לאמת מימוש במערכת
      </div>

      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="הדבק או הקלד קוד קופון"
        style={{
          width: "100%",
          padding: "14px",
          borderRadius: 12,
          border: "1px solid #d1d5db",
          marginBottom: 12,
          outline: "none",
          fontSize: 16,
          boxSizing: "border-box",
          textAlign: "left",
          direction: "ltr",
        }}
      />

      <button
        type="button"
        onClick={onSubmit}
        style={{
          width: "100%",
          padding: "14px",
          borderRadius: 12,
          border: "none",
          background: "#111827",
          color: "#ffffff",
          fontWeight: 700,
          fontSize: 16,
          cursor: "pointer",
          marginBottom: 10,
        }}
      >
        אמת קופון
      </button>

      <button
        type="button"
        onClick={onBackToScan}
        style={{
          width: "100%",
          padding: "12px",
          borderRadius: 12,
          border: "1px solid #d1d5db",
          background: "#ffffff",
          color: "#111827",
          fontWeight: 600,
          fontSize: 15,
          cursor: "pointer",
        }}
      >
        סרוק באמצעות מצלמה
      </button>
    </div>
  );
}

function InlineRedeemLoading() {
  return (
    <div
      style={{
        background: "#ffffff",
        padding: 20,
        borderRadius: 20,
        border: "1px solid #e5e7eb",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "#111827",
          marginBottom: 8,
        }}
      >
        מאמת קופון...
      </div>

      <div
        style={{
          fontSize: 14,
          color: "#6b7280",
        }}
      >
        מבצע בדיקת תקינות ואישור מימוש
      </div>
    </div>
  );
}

type SuccessProps = {
  result: RedeemResult | null;
  onReset: () => void;
};

function formatRedeemedAt(value?: string) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("he-IL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function InlineRedeemSuccess({ result, onReset }: SuccessProps) {
  const title = result?.coupon?.offer?.title || "המימוש אושר בהצלחה";
  const benefit =
    result?.coupon?.offer?.customerBenefitText ||
    result?.coupon?.offer?.description ||
    "";
  const redeemedAtText = formatRedeemedAt(result?.redemptionEvent?.redeemedAt);

  return (
    <div
      style={{
        background: "#ffffff",
        padding: 20,
        borderRadius: 20,
        border: "1px solid #e5e7eb",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          marginBottom: 10,
          color: "#111827",
        }}
      >
        המימוש אושר בהצלחה 🎉
      </div>

      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "#111827",
          marginBottom: 8,
        }}
      >
        {title}
      </div>

      {benefit ? (
        <div
          style={{
            fontSize: 14,
            color: "#6b7280",
            lineHeight: 1.5,
            marginBottom: 12,
          }}
        >
          {benefit}
        </div>
      ) : null}

      <div
        style={{
          fontSize: 14,
          color: "#111827",
          fontWeight: 600,
          marginBottom: redeemedAtText ? 8 : 16,
        }}
      >
        המימוש נרשם במערכת
      </div>

      {redeemedAtText ? (
        <div
          style={{
            fontSize: 13,
            color: "#6b7280",
            marginBottom: 16,
          }}
        >
          מועד מימוש: {redeemedAtText}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onReset}
        style={{
          padding: "12px 16px",
          borderRadius: 12,
          border: "none",
          background: "#111827",
          color: "#ffffff",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        מימוש קופון נוסף
      </button>
    </div>
  );
}

type ErrorProps = {
  message: string;
  onRetry: () => void;
  onManual: () => void;
};

function InlineRedeemError({ message, onRetry, onManual }: ErrorProps) {
  return (
    <div
      style={{
        background: "#ffffff",
        padding: 20,
        borderRadius: 20,
        border: "1px solid #e5e7eb",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          marginBottom: 10,
          color: "#dc2626",
        }}
      >
        לא ניתן לממש את הקופון
      </div>

      <div
        style={{
          marginBottom: 16,
          color: "#374151",
          lineHeight: 1.5,
        }}
      >
        {message}
      </div>

      <button
        type="button"
        onClick={onRetry}
        style={{
          width: "100%",
          padding: "12px 16px",
          borderRadius: 12,
          border: "none",
          background: "#111827",
          color: "#ffffff",
          fontWeight: 700,
          cursor: "pointer",
          marginBottom: 10,
        }}
      >
        סרוק שוב
      </button>

      <button
        type="button"
        onClick={onManual}
        style={{
          width: "100%",
          padding: "12px 16px",
          borderRadius: 12,
          border: "1px solid #d1d5db",
          background: "#ffffff",
          color: "#111827",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        עבור להזנה ידנית
      </button>
    </div>
  );
}

function mapRedeemError(data: any) {
  const code = data?.code;
  const backendError = data?.error;

  if (code === "COUPON_ALREADY_REDEEMED") {
    return "הקופון כבר מומש בעבר";
  }

  if (code === "COUPON_EXPIRED") {
    return "תוקף הקופון פג ולא ניתן לממש אותו";
  }

  if (code === "COUPON_NOT_FOUND") {
    return "הקופון לא נמצא. נסה לסרוק שוב או להזין ידנית";
  }

  if (code === "UNAUTHORIZED") {
    return "אין הרשאה לבצע מימוש. התחבר מחדש";
  }

  if (typeof backendError === "string" && backendError.trim()) {
    return backendError;
  }

  return "שגיאה במימוש קופון";
}

export default function RedeemScreen() {
  const searchParams = useSearchParams();

  const [flowState, setFlowState] = useState<FlowState>("scan");
  const [tokenInput, setTokenInput] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [result, setResult] = useState<RedeemResult | null>(null);
  const [isScanning, setIsScanning] = useState(true);
  const [autoTriggered, setAutoTriggered] = useState(false);

  const authToken =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const handleRedeem = async (tokenValue?: string) => {
    const finalToken = (tokenValue || tokenInput).trim();

    if (!finalToken) {
      setErrorMessage("יש להזין קוד קופון");
      setFlowState("error");
      return;
    }

    if (!authToken) {
      setErrorMessage("אין הרשאה לבצע מימוש. התחבר מחדש");
      setFlowState("error");
      return;
    }

    try {
      setIsScanning(false);
      setFlowState("validating");
      setErrorMessage("");

      const res = await fetch(`/api/coupons/${finalToken}/redeem`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(mapRedeemError(data));
      }

      setResult(data);
      setFlowState("success");
    } catch (err: any) {
      setErrorMessage(err?.message || "שגיאה לא ידועה");
      setFlowState("error");
    }
  };

  useEffect(() => {
    const urlToken = searchParams.get("token");

    if (!urlToken || autoTriggered) {
      return;
    }

    setTokenInput(urlToken);
    setAutoTriggered(true);
    handleRedeem(urlToken);
  }, [searchParams, autoTriggered]);

  const handleReset = () => {
    setFlowState("scan");
    setTokenInput("");
    setErrorMessage("");
    setResult(null);
    setIsScanning(true);
    setAutoTriggered(false);
  };

  const handleOpenManual = () => {
    setFlowState("idle");
    setIsScanning(false);
    setErrorMessage("");
  };

  const handleBackToScan = () => {
    setFlowState("scan");
    setErrorMessage("");
    setIsScanning(true);
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f8f5ef",
        padding: "24px 16px",
      }}
    >
      <div
        style={{
          maxWidth: 520,
          margin: "0 auto",
        }}
      >
        {flowState === "scan" && (
          <div
            style={{
              background: "#ffffff",
              padding: 20,
              borderRadius: 20,
              border: "1px solid #e5e7eb",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: "#111827",
                marginBottom: 8,
                textAlign: "right",
              }}
            >
              מימוש קופון
            </div>

            <div
              style={{
                fontSize: 14,
                color: "#6b7280",
                marginBottom: 8,
                textAlign: "right",
                lineHeight: 1.5,
              }}
            >
              סרוק קופון כדי לאמת ולבצע מימוש במערכת
            </div>

            <div
              style={{
                fontSize: 13,
                color: "#6b7280",
                marginBottom: 16,
                textAlign: "right",
                lineHeight: 1.5,
              }}
            >
              המערכת תבדוק אם הקופון תקף ותאשר את המימוש באופן מיידי
            </div>

            <RedeemScanner
              isActive={isScanning}
              onDetected={(scannedToken) => handleRedeem(scannedToken)}
            />

            <button
              type="button"
              onClick={handleOpenManual}
              style={{
                width: "100%",
                padding: "12px",
                borderRadius: 12,
                border: "1px solid #d1d5db",
                background: "#ffffff",
                color: "#111827",
                fontWeight: 600,
                fontSize: 15,
                cursor: "pointer",
              }}
            >
              הקלד קוד במקום סריקה
            </button>
          </div>
        )}

        {flowState === "idle" && (
          <InlineRedeemInput
            value={tokenInput}
            onChange={setTokenInput}
            onSubmit={() => handleRedeem()}
            onBackToScan={handleBackToScan}
          />
        )}

        {flowState === "validating" && <InlineRedeemLoading />}

        {flowState === "success" && (
          <InlineRedeemSuccess result={result} onReset={handleReset} />
        )}

        {flowState === "error" && (
          <InlineRedeemError
            message={errorMessage}
            onRetry={handleReset}
            onManual={handleOpenManual}
          />
        )}
      </div>
    </main>
  );
}