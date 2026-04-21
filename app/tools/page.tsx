"use client";

import { useRouter } from "next/navigation";

type ToolItem = {
  key: string;
  title: string;
  description: string;
  href: string;
  status: "active" | "soon";
  icon: string;
};

const TOOLS: ToolItem[] = [
  {
    key: "conversations",
    title: "שיחות עם לקוחות",
    description: "ניהול שיחות, מעקב ותשובות חכמות ללקוחות",
    href: "/inbox",
    status: "active",
    icon: "💬",
  },
  {
    key: "content",
    title: "יצירת תוכן",
    description: "יצירת תוכן שיווקי מותאם לעסק שלך",
    href: "/content",
    status: "active",
    icon: "🎥",
  },
  {
    key: "pricing",
    title: "תמחור",
    description: "בדיקת מחירים, עלויות ורווחיות",
    href: "/pricing",
    status: "active",
    icon: "💰",
  },
  {
    key: "documents",
    title: "מסמכים",
    description: "ריכוז וניהול מסמכים עסקיים במקום אחד",
    href: "/documents",
    status: "active",
    icon: "📄",
  },
  {
    key: "offers",
    title: "מבצעים וקופונים",
    description: "כניסה לפיצ׳ר Revenue דרך שכבת הכניסה הראשית",
    href: "/revenue",
    status: "active",
    icon: "🏷️",
  },
  {
    key: "bot",
    title: "בוטים לעסק",
    description: "יצירה והגדרה של בוטים עסקיים",
    href: "/bots",
    status: "soon",
    icon: "🤖",
  },
  {
    key: "collaborations",
    title: "שיתופי פעולה",
    description: "איתור וניהול שיתופי פעולה עסקיים",
    href: "/collaborations",
    status: "soon",
    icon: "🤝",
  },
  {
    key: "growth",
    title: "הזדמנויות צמיחה",
    description: "מנועים עתידיים לשיפור ביצועים עסקיים",
    href: "/growth",
    status: "soon",
    icon: "📈",
  },
];

function ToolsHeader({ onBack }: { onBack: () => void }) {
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
          <p className="text-base font-bold text-gray-900">כל הכלים</p>
          <p className="mt-1 text-xs text-gray-500">
            כל היכולות של המערכת במקום אחד
          </p>
        </div>

        <div className="h-11 min-w-[44px]" />
      </div>
    </header>
  );
}

function ToolCard({
  item,
  onClick,
}: {
  item: ToolItem;
  onClick: () => void;
}) {
  const isSoon = item.status === "soon";

  return (
    <button
      onClick={onClick}
      disabled={isSoon}
      className={`relative min-h-[150px] rounded-[24px] p-4 text-right shadow-sm transition ${
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

      <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#f8f6f1] text-2xl">
        {item.icon}
      </div>

      <h2 className="text-sm font-bold text-gray-900">{item.title}</h2>
      <p className="mt-2 text-xs leading-5 text-gray-500">{item.description}</p>
    </button>
  );
}

export default function ToolsPage() {
  const router = useRouter();

  const handleBack = () => {
    router.push("/");
  };

  const handleToolClick = (item: ToolItem) => {
    if (item.status !== "active") {
      return;
    }

    if (!item.href) {
      return;
    }

    router.push(item.href);
  };

  return (
    <main className="min-h-screen bg-[#f8f6f1] text-[#1f2937]">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-8 pt-4 sm:max-w-2xl sm:px-6 lg:max-w-4xl">
        <ToolsHeader onBack={handleBack} />

        <section className="mb-4 rounded-[24px] bg-white p-4 shadow-sm">
          <h1 className="text-lg font-bold text-gray-900">מרכז הכלים של העסק</h1>
          <p className="mt-2 text-sm leading-6 text-gray-600">
            כאן תוכל לעבור בין כל היכולות של המערכת בצורה מסודרת, ברורה ונוחה.
          </p>
        </section>

        <section className="grid grid-cols-2 gap-3">
          {TOOLS.map((item) => (
            <ToolCard
              key={item.key}
              item={item}
              onClick={() => handleToolClick(item)}
            />
          ))}
        </section>
      </div>
    </main>
  );
}