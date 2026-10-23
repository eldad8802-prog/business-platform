"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Scanner } from "@yudiel/react-qr-scanner";
import { useI18n } from "@/components/i18n/I18nProvider";

type Props = {
  onDetected: (token: string) => void;
  isActive: boolean;
};

export default function RedeemScanner({ onDetected, isActive }: Props) {
  const { t } = useI18n();
  const hasDetectedRef = useRef(false);
  const lastDetectedRef = useRef<string | null>(null);

  const [status, setStatus] = useState(t("billing.redeem.readyToScan"));
  const [errorMessage, setErrorMessage] = useState("");

  const paused = useMemo(() => !isActive, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    hasDetectedRef.current = false;
    lastDetectedRef.current = null;
    setErrorMessage("");
    setStatus(t("billing.redeem.readyToScan"));
  }, [isActive, t]);

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
      setErrorMessage(t("billing.redeem.cameraUnsupported"));
      setStatus("");
    }
  }, [isActive, t]);

  if (!isActive) return null;

  return (
    <div
      style={{
        width: "100%",
        borderRadius: 20,
        overflow: "hidden",
        border: "1px solid var(--dz-border)",
        marginBottom: 12,
        background: "var(--dz-surface)",
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
              setStatus(t("billing.redeem.qrWithoutToken"));
              return;
            }

            if (lastDetectedRef.current === token) {
              return;
            }

            hasDetectedRef.current = true;
            lastDetectedRef.current = token;
            setStatus(t("billing.redeem.codeDetected"));
            setErrorMessage("");
            onDetected(token);
          }}
          onError={(err) => {
            console.error("QR scanner error:", err);
            setStatus("");
            setErrorMessage(t("billing.redeem.scanFailed"));
          }}
        />
      </div>

      <div
        style={{
          padding: 12,
          textAlign: "start",
          fontSize: 14,
          lineHeight: 1.5,
          color: errorMessage ? "var(--dz-danger)" : "var(--dz-text-secondary)",
          background: errorMessage ? "var(--dz-danger-bg-soft)" : "var(--dz-surface)",
          borderTop: "1px solid var(--dz-border)",
        }}
      >
        {errorMessage || status}
      </div>
    </div>
  );
}