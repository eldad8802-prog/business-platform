"use client";

import BackButton from "@/components/ui/back-button";
import { useEffect, useRef, useState } from "react";
import { useFlowStep } from "@/hooks/useFlowStep";
import { useSearchParams } from "next/navigation";
import RedeemScanner from "./redeem-scanner";
import { TOKEN } from "@/lib/design/tokens";

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
        background: "var(--dz-surface)",
        padding: 20,
        borderRadius: 20,
        border: "1px solid var(--dz-border)",
      }}
    >
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: "var(--dz-text-primary)",
          marginBottom: 8,
          textAlign: "right",
        }}
      >
        מימוש קופון
      </div>

      <div
        style={{
          fontSize: 14,
          color: "var(--dz-text-muted)",
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
          border: "1px solid var(--dz-border-strong)",
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
          background: TOKEN.action.primary.background,
          color: "var(--dz-text-on-brand)",
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
          border: "1px solid var(--dz-border-strong)",
          background: "var(--dz-surface)",
          color: "var(--dz-text-primary)",
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
        background: "var(--dz-surface)",
        padding: 20,
        borderRadius: 20,
        border: "1px solid var(--dz-border)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "var(--dz-text-primary)",
          marginBottom: 8,
        }}
      >
        מאמת קופון...
      </div>

      <div
        style={{
          fontSize: 14,
          color: "var(--dz-text-muted)",
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
        background: "var(--dz-surface)",
        padding: 20,
        borderRadius: 20,
        border: "1px solid var(--dz-border)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          marginBottom: 10,
          color: "var(--dz-text-primary)",
        }}
      >
        המימוש אושר בהצלחה 🎉
      </div>

      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "var(--dz-text-primary)",
          marginBottom: 8,
        }}
      >
        {title}
      </div>

      {benefit ? (
        <div
          style={{
            fontSize: 14,
            color: "var(--dz-text-muted)",
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
          color: "var(--dz-text-primary)",
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
            color: "var(--dz-text-muted)",
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
          background: TOKEN.action.primary.background,
          color: "var(--dz-text-on-brand)",
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
        background: "var(--dz-surface)",
        padding: 20,
        borderRadius: 20,
        border: "1px solid var(--dz-border)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          marginBottom: 10,
          color: "var(--dz-danger)",
        }}
      >
        לא ניתן לממש את הקופון
      </div>

      <div
        style={{
          marginBottom: 16,
          color: "var(--dz-text-secondary)",
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
          background: TOKEN.action.primary.background,
          color: "var(--dz-text-on-brand)",
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
          border: "1px solid var(--dz-border-strong)",
          background: "var(--dz-surface)",
          color: "var(--dz-text-primary)",
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
  const backendError = data?.error;

  if (backendError === "Coupon was already redeemed") {
    return "הקופון כבר מומש בעבר";
  }

  if (backendError === "Coupon has expired") {
    return "תוקף הקופון פג ולא ניתן לממש אותו";
  }

  if (backendError === "Coupon not found") {
    return "הקופון לא נמצא. נסה לסרוק שוב או להזין ידנית";
  }

  if (backendError === "Unauthorized") {
    return "אין הרשאה לבצע מימוש. התחבר מחדש";
  }

  if (backendError === "Coupon was cancelled") {
    return "הקופון בוטל ולא ניתן לממש אותו";
  }

  if (typeof backendError === "string" && backendError.trim()) {
    return backendError;
  }

  return "שגיאה במימוש קופון";
}

export default function RedeemScreen() {
  const searchParams = useSearchParams();

  const [tokenInput, setTokenInput] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [result, setResult] = useState<RedeemResult | null>(null);
  const [autoTriggered, setAutoTriggered] = useState(false);
  const [validating, setValidating] = useState(false);

  // Steps are real history entries (?step=…): back walks scan → manual →
  // error in the order taken, keeping the typed code. "done" follows a
  // COMPLETED action (the coupon was redeemed) and REPLACES the step that did
  // it, so back cannot return to a screen that would redeem it again.
  const flow = useFlowStep<"scan" | "manual" | "done" | "error">({
    steps: ["scan", "manual", "done", "error"],
    canShow: (st) => (st === "done" ? result !== null : st === "error" ? errorMessage !== "" : true),
  });
  const flowState: FlowState = validating
    ? "validating"
    : flow.step === "manual"
      ? "idle"
      : flow.step === "done"
        ? "success"
        : flow.step === "error"
          ? "error"
          : "scan";
  const redeemInFlightRef = useRef(false);

  const authToken =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const handleRedeem = async (tokenValue?: string) => {
    if (redeemInFlightRef.current) return;

    const finalToken = (tokenValue || tokenInput).trim();

    if (!finalToken) {
      setErrorMessage("יש להזין קוד קופון");
      flow.go("error");
      return;
    }

    if (!authToken) {
      setErrorMessage("אין הרשאה לבצע מימוש. התחבר מחדש");
      flow.go("error");
      return;
    }

    try {
      redeemInFlightRef.current = true;
      setValidating(true);
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
      setValidating(false);
      // COMPLETED (coupon redeemed): "done" replaces the entry step and any
      // earlier entry/error steps are consumed; back returns to the scanner.
      flow.complete("done", ["manual", "error"]);
    } catch (err: any) {
      setErrorMessage(err?.message || "שגיאה לא ידועה");
      setValidating(false);
      flow.go("error");
      redeemInFlightRef.current = false;
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
    redeemInFlightRef.current = false;
    // Next coupon: return to the scan entry (pop), not a stacked new one.
    flow.backTo("scan");
    setTokenInput("");
    setErrorMessage("");
    setResult(null);
    setAutoTriggered(false);
  };

  const handleOpenManual = () => {
    flow.go("manual");
    setErrorMessage("");
  };

  const handleBackToScan = () => {
    flow.backTo("scan");
    setErrorMessage("");
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--dz-surface-muted)",
        padding: "24px 16px",
      }}
    >
      <div
        style={{
          maxWidth: 520,
          margin: "0 auto",
        }}
      >
        {/* The scanner hides the shell chrome on phones/tablets: this is the
            screen's only way out, so it is always present. */}
        <div style={{ marginBottom: 12 }}>
          <BackButton />
        </div>
        {flowState === "scan" && (
          <div
            style={{
              background: "var(--dz-surface)",
              padding: 20,
              borderRadius: 20,
              border: "1px solid var(--dz-border)",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: "var(--dz-text-primary)",
                marginBottom: 8,
                textAlign: "right",
              }}
            >
              מימוש קופון
            </div>

            <div
              style={{
                fontSize: 14,
                color: "var(--dz-text-muted)",
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
                color: "var(--dz-text-muted)",
                marginBottom: 16,
                textAlign: "right",
                lineHeight: 1.5,
              }}
            >
              המערכת תבדוק אם הקופון תקף ותאשר את המימוש באופן מיידי
            </div>

            <RedeemScanner
              // The camera runs exactly while the scan step is shown — also
              // after returning to it with back (button or browser).
              isActive={flowState === "scan"}
              onDetected={(scannedToken) => handleRedeem(scannedToken)}
            />

            <button
              type="button"
              onClick={handleOpenManual}
              style={{
                width: "100%",
                padding: "12px",
                borderRadius: 12,
                border: "1px solid var(--dz-border-strong)",
                background: "var(--dz-surface)",
                color: "var(--dz-text-primary)",
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