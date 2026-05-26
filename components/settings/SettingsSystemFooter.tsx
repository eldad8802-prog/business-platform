"use client";

import { useRouter } from "next/navigation";

type Props = {
  appVersion: string;
};

export function SettingsSystemFooter({ appVersion }: Props) {
  const router = useRouter();

  function handleLogout() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("token");
    }
    router.push("/login");
  }

  return (
    <footer className="mt-8 border-t border-gray-200/80 pt-5">
      <p className="text-center text-xs text-gray-500">
        גרסת מערכת: <span className="font-mono font-medium text-gray-700">{appVersion}</span>
      </p>

      <ul className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs text-gray-500">
        <li>
          <button
            type="button"
            disabled
            className="cursor-not-allowed border-0 bg-transparent p-0 text-inherit"
            title="בקרוב"
          >
            תמיכה <span className="text-gray-400">(בקרוב)</span>
          </button>
        </li>
        <li className="text-gray-300" aria-hidden>
          ·
        </li>
        <li>
          <button
            type="button"
            disabled
            className="cursor-not-allowed border-0 bg-transparent p-0 text-inherit"
            title="בקרוב"
          >
            מדיניות פרטיות <span className="text-gray-400">(בקרוב)</span>
          </button>
        </li>
        <li className="text-gray-300" aria-hidden>
          ·
        </li>
        <li>
          <button
            type="button"
            disabled
            className="cursor-not-allowed border-0 bg-transparent p-0 text-inherit"
            title="בקרוב"
          >
            תנאי שימוש <span className="text-gray-400">(בקרוב)</span>
          </button>
        </li>
      </ul>

      <div className="mt-4">
        <button
          type="button"
          onClick={handleLogout}
          className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-800 transition active:scale-[0.99]"
        >
          התנתקות
        </button>
      </div>
    </footer>
  );
}
