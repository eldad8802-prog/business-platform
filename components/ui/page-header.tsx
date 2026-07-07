"use client";

import BackButton from "@/components/ui/back-button";

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
        <div
          style={{
            position: "absolute",
            right: 16,
            top: "50%",
            transform: "translateY(-50%)",
          }}
        >
          <BackButton href={backHref} label={backLabel} />
        </div>
      ) : null}
    </div>
  );
}