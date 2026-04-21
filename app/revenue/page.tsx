"use client";

import { useRouter } from "next/navigation";

function RevenueHeader({ onBack }: { onBack: () => void }) {
  return (
    <header className="mb-5 rounded-3xl bg-white px-4 py-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="flex h-11 min-w-[44px] items-center justify-center rounded-2xl border border-gray-200 px-3 text-sm font-medium text-gray-700"
          aria-label="חזרה"
        >
          →
        </button>

        <div className="flex-1 text-center">
          <p className="text-base font-bold text-gray-900">Revenue Activation</p>
          <p className="mt-1 text-xs text-gray-500">מבצעים וקופונים</p>
        </div>

        <div className="h-11 min-w-[44px]" />
      </div>
    </header>
  );
}

function RevenuePrimaryCard({
  title,
  description,
  buttonLabel,
  onClick,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  onClick: () => void;
}) {
  return (
    <section className="mb-4 rounded-[28px] bg-white p-5 shadow-sm">
      <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eef7f2] text-2xl">
        🏷️
      </div>

      <h1 className="mb-2 text-2xl font-bold leading-tight text-gray-900">
        {title}
      </h1>

      <p className="mb-5 text-sm leading-6 text-gray-600">{description}</p>

      <button
        onClick={onClick}
        className="w-full rounded-2xl bg-[#1f7a5a] px-4 py-3.5 text-sm font-semibold text-white transition active:scale-[0.99]"
      >
        {buttonLabel}
      </button>
    </section>
  );
}

function RevenueSecondaryCard({
  title,
  description,
  status,
  onClick,
}: {
  title: string;
  description: string;
  status: "active" | "soon";
  onClick: () => void;
}) {
  const isSoon = status === "soon";

  return (
    <button
      onClick={onClick}
      disabled={isSoon}
      className={`relative w-full rounded-[24px] p-4 text-right shadow-sm transition ${
        isSoon
          ? "cursor-not-allowed bg-white/80 opacity-80"
          : "bg-white active:scale-[0.99]"
      }`}
    >
      <span
        className={`absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-semibold ${
          isSoon
            ? "bg-[#f4ead0] text-[#7a5a1f]"
            : "bg-[#e8f6ee] text-[#1f7a5a]"
        }`}
      >
        {isSoon ? "בקרוב" : "פעיל"}
      </span>

      <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[#f8f6f1] text-2xl">
        🎟️
      </div>

      <h2 className="text-sm font-bold text-gray-900">{title}</h2>
      <p className="mt-2 text-xs leading-5 text-gray-500">{description}</p>
    </button>
  );
}

export default function RevenuePage() {
  const router = useRouter();

  const handleBack = () => {
    router.push("/");
  };

  const handleIssueCoupon = () => {
    router.push("/revenue/issue");
  };

  const handleRedeemCoupon = () => {
    return;
  };

  return (
    <main className="min-h-screen bg-[#f8f6f1] text-[#1f2937]">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-8 pt-4 sm:max-w-2xl sm:px-6 lg:max-w-4xl">
        <RevenueHeader onBack={handleBack} />

        <RevenuePrimaryCard
          title="הוצאת קופון"
          description="כניסה לשכבת הקופונים הפעילה כדי לבחור הצעה ולהנפיק קופון ללקוח."
          buttonLabel="המשך להוצאת קופון"
          onClick={handleIssueCoupon}
        />

        <RevenueSecondaryCard
          title="מימוש קופון"
          description="שכבת מימוש הקופון תתחבר כאן כזרימה פנימית נפרדת."
          status="soon"
          onClick={handleRedeemCoupon}
        />
      </div>
    </main>
  );
}