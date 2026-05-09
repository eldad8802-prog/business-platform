"use client";

import { useRouter } from "next/navigation";

type Props = {
  title: string;
  showBack?: boolean;
  backHref?: string;
  backLabel?: string;
};

export default function PageHeader({
  title,
  showBack = true,
  backHref,
  backLabel = "חזרה",
}: Props) {
  const router = useRouter();

  function handleBack() {
    if (!showBack) return;
    if (typeof backHref === "string" && backHref.trim()) {
      router.push(backHref);
      return;
    }
    router.back();
  }

  return (
    <div
      style={{
        direction: "rtl",
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "#ffffff",
        borderBottom: "1px solid #e5e7eb",
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 56,
      }}
    >
      <div
        style={{
          fontWeight: 700,
          fontSize: "16px",
          textAlign: "center",
          width: "100%",
          paddingLeft: 88,
          paddingRight: 88,
          boxSizing: "border-box",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {title}
      </div>

      {showBack ? (
        <button
          type="button"
          onClick={handleBack}
          style={{
            position: "absolute",
            right: 16,
            top: "50%",
            transform: "translateY(-50%)",
            height: 40,
            borderRadius: 12,
            border: "1px solid #e5e7eb",
            background: "#ffffff",
            cursor: "pointer",
            padding: "0 12px",
            fontSize: 14,
            fontWeight: 900,
            color: "#111827",
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
        >
          {backLabel}
        </button>
      ) : null}
    </div>
  );
}