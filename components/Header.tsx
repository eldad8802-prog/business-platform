"use client";

import BackButton from "@/components/ui/back-button";

type HeaderProps = {
  title: string;
  showBack?: boolean;
};

export default function Header({
  title,
  showBack = true,
}: HeaderProps) {
  return (
    <div style={header}>
      {/* צד ימין - חזרה */}
      <div style={side}>
        {showBack ? <BackButton /> : <div style={placeholder} />}
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
  minWidth: 88,
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
};

const placeholder = {
  width: 44,
  height: 44,
};

const titleStyle = {
  flex: 1,
  textAlign: "center" as const,
  fontSize: 16,
  fontWeight: 700,
};
