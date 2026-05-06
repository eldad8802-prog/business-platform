"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Scanner } from "@yudiel/react-qr-scanner";

type Props = {
  onDetected: (token: string) => void;
  isActive: boolean;
};

export default function RedeemScanner({ onDetected, isActive }: Props) {
  const hasDetectedRef = useRef(false);
  const lastDetectedRef = useRef<string | null>(null);

  const [status, setStatus] = useState("מוכן לסריקה");
  const [errorMessage, setErrorMessage] = useState("");

  const paused = useMemo(() => !isActive, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    hasDetectedRef.current = false;
    lastDetectedRef.current = null;
    setErrorMessage("");
    setStatus("מוכן לסריקה");
  }, [isActive]);

  const extractTokenFromRawValue = (rawValue: string): string | null => {
    const value = (rawValue || "").trim();
    if (!value) return null;

    // If it's already a token (UUID or similar), use it as-is.
    if (!value.includes("?") && !value.includes("://") && value.length >= 6) {
      return value;
    }

    // Try URL parsing first (works for full links like http://.../redeem?token=...)
    try {
      const url = new URL(value);
      const token = url.searchParams.get("token");
      if (token && token.trim()) return token.trim();
    } catch {
      // ignore
    }

    // Fallback regex for cases like "redeem?token=..." without full origin
    const match = value.match(/[?&]token=([^&]+)/i);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]).trim();
      } catch {
        return match[1].trim();
      }
    }

    return null;
  };

  useEffect(() => {
    if (!isActive) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage("הדפדפן לא תומך בפתיחת מצלמה");
      setStatus("");
    }
  }, [isActive]);

  if (!isActive) return null;

  return (
    <div
      style={{
        width: "100%",
        borderRadius: 20,
        overflow: "hidden",
        border: "1px solid #e5e7eb",
        marginBottom: 12,
        background: "#ffffff",
      }}
    >
      <div
        style={{
          minHeight: 320,
          background: "#000000",
          position: "relative",
        }}
      >
        <Scanner
          paused={paused}
          allowMultiple={false}
          scanDelay={350}
          constraints={{
            facingMode: { ideal: "environment" },
          }}
          styles={{
            container: {
              width: "100%",
              height: 320,
            },
            video: {
              width: "100%",
              height: 320,
              objectFit: "cover",
              display: "block",
            },
          }}
          onScan={(detectedCodes) => {
            if (!isActive) return;
            if (hasDetectedRef.current) return;

            const rawValue = detectedCodes?.[0]?.rawValue || "";
            const token = extractTokenFromRawValue(rawValue);

            if (!token) {
              setStatus("זוהה QR אבל לא נמצא token");
              return;
            }

            if (lastDetectedRef.current === token) {
              return;
            }

            hasDetectedRef.current = true;
            lastDetectedRef.current = token;
            setStatus("זוהה קוד, מאמת...");
            setErrorMessage("");
            onDetected(token);
          }}
          onError={(err) => {
            console.error("QR scanner error:", err);
            setStatus("");
            setErrorMessage(
              "לא הצלחנו להפעיל את הסריקה. ודא שיש הרשאת מצלמה או עבור להזנה ידנית."
            );
          }}
        />
      </div>

      <div
        style={{
          padding: 12,
          textAlign: "right",
          fontSize: 14,
          lineHeight: 1.5,
          color: errorMessage ? "#b91c1c" : "#374151",
          background: errorMessage ? "#fef2f2" : "#ffffff",
          borderTop: "1px solid #e5e7eb",
        }}
      >
        {errorMessage || status}
      </div>
    </div>
  );
}