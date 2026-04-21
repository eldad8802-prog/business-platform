"use client";

import { useRouter } from "next/navigation";

export default function ContentTestPage() {
  const router = useRouter();

  function goToCreate() {
    const query = new URLSearchParams({
      type: "post",
      goal: "leads",
      valueType: "offer",
      style: "direct",
      mode: "ai",
      customerType: "urgent",
      serviceLevel: "premium",
      tone: "direct",
    });

    router.push(`/content/create?${query.toString()}`);
  }

  return (
    <div style={{ padding: 40 }}>
      <h1>TEST FLOW</h1>

      <button onClick={goToCreate}>
        כניסה ישירה ל־CREATE
      </button>
    </div>
  );
}