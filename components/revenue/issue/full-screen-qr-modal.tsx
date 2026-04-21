"use client";

import { QRCodeCanvas } from "qrcode.react";

type FullScreenQrModalProps = {
  isOpen: boolean;
  qrValue: string;
  onClose: () => void;
};

export default function FullScreenQrModal({
  isOpen,
  qrValue,
  onClose,
}: FullScreenQrModalProps) {
  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17, 24, 39, 0.92)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 460,
          background: "#ffffff",
          borderRadius: 28,
          padding: 20,
          textAlign: "center",
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.25)",
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "#6b7280",
            marginBottom: 10,
          }}
        >
          QR למסירה / סריקה
        </div>

        <div
          style={{
            width: "100%",
            borderRadius: 24,
            border: "1px solid #e5e7eb",
            padding: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 16,
          }}
        >
          <QRCodeCanvas
  value={qrValue}
  size={300}
  includeMargin
  style={{
    width: "100%",
    height: "auto",
    maxWidth: 300,
    display: "block",
  }}
/>
        </div>

        <div
          style={{
            fontSize: 13,
            color: "#6b7280",
            marginBottom: 18,
            wordBreak: "break-word",
          }}
        >
          {qrValue}
        </div>

        <button
          type="button"
          onClick={onClose}
          style={{
            padding: "14px 16px",
            borderRadius: 16,
            border: "none",
            background: "#111827",
            color: "#ffffff",
            fontWeight: 700,
            cursor: "pointer",
            width: "100%",
          }}
        >
          סגור
        </button>
      </div>
    </div>
  );
}