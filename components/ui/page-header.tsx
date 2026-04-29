"use client";

import { useRouter } from "next/navigation";

type Props = {
  title: string;
};

export default function PageHeader({ title }: Props) {
  const router = useRouter();

  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "#ffffff",
        borderBottom: "1px solid #e5e7eb",
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      {/* שמאל - ריק */}
      <div style={{ width: 40 }} />

      {/* כותרת באמצע */}
      <div
        style={{
          flex: 1,
          textAlign: "center",
          fontWeight: 700,
          fontSize: "16px",
        }}
      >
        {title}
      </div>

      {/* ימין - חזרה */}
      <button
        onClick={() => router.back()}
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          border: "none",
          background: "#f3f4f6",
          cursor: "pointer",
          fontSize: 18,
        }}
      >
        ←
      </button>
    </div>
  );
}