"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function UploadRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/documents");
  }, [router]);

  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100vh",
        background: "#f3f7ff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #dfe7f3",
          borderRadius: 18,
          padding: 18,
          color: "#0f172a",
          fontSize: 15,
          fontWeight: 900,
          boxShadow: "0 10px 28px rgba(15, 23, 42, 0.06)",
        }}
      >
        מחזירים אותך למרכז המסמכים...
      </div>
    </div>
  );
}
