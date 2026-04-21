"use client";

import { useRouter } from "next/navigation";

type HeaderProps = {
  title: string;
  showBack?: boolean;
};

export default function Header({
  title,
  showBack = true,
}: HeaderProps) {
  const router = useRouter();

  return (
    <div style={header}>
      {/* צד ימין - חזרה */}
      <div style={side}>
        {showBack ? (
          <button
            onClick={() => router.back()}
            style={backBtn}
            aria-label="חזרה"
          >
            ←
          </button>
        ) : (
          <div style={placeholder} />
        )}
      </div>

      {/* מרכז */}
      <div style={titleStyle}>{title}</div>

      {/* צד שמאל */}
      <div style={side}>
        <div style={placeholder} />
      </div>
    </div>
  );
}

const header = {
  height: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "#fff",
  borderBottom: "1px solid #e5e7eb",
  padding: "0 12px",
  position: "sticky" as const,
  top: 0,
  zIndex: 10,
};

const side = {
  width: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
};

const placeholder = {
  width: 44,
  height: 44,
};

const backBtn = {
  width: 44,
  height: 44,
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  background: "#fff",
  fontSize: 22,
  cursor: "pointer",
};

const titleStyle = {
  flex: 1,
  textAlign: "center" as const,
  fontSize: 16,
  fontWeight: 700,
};