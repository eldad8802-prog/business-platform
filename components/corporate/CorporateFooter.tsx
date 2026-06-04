import Link from "next/link";
import { CorporateContainer } from "./CorporateContainer";

/**
 * Corporate footer: navigation, legal links, and the mandatory operating
 * entity statement required for the Dubiz / PRO MAX GROUP corporate site.
 */
export function CorporateFooter() {
  return (
    <footer className="mt-16 border-t border-gray-200 bg-white">
      <CorporateContainer className="py-10">
        <div className="flex flex-col gap-8 sm:flex-row sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-lg font-extrabold text-gray-900">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-2xl bg-[#eef7f2] text-[#1f7a5a]">
                D
              </span>
              Dubiz
            </div>
            <p className="mt-3 max-w-xs text-sm leading-6 text-gray-500">
              מערכת ההפעלה לעסק שלך — שיחות, מסמכים, חשבוניות, מלאי ותובנות במקום
              אחד.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:gap-12">
            <div>
              <p className="text-xs font-bold tracking-wide text-gray-400">
                ניווט
              </p>
              <ul className="mt-3 space-y-2 text-sm">
                <li>
                  <Link href="/home" className="text-gray-600 hover:text-gray-900">
                    בית
                  </Link>
                </li>
                <li>
                  <Link href="/about" className="text-gray-600 hover:text-gray-900">
                    אודות
                  </Link>
                </li>
                <li>
                  <Link
                    href="/contact"
                    className="text-gray-600 hover:text-gray-900"
                  >
                    צור קשר
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <p className="text-xs font-bold tracking-wide text-gray-400">
                משפטי
              </p>
              <ul className="mt-3 space-y-2 text-sm">
                <li>
                  <Link
                    href="/privacy"
                    className="text-gray-600 hover:text-gray-900"
                  >
                    מדיניות פרטיות
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="text-gray-600 hover:text-gray-900">
                    תנאי שימוש
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-10 border-t border-gray-100 pt-6 text-sm text-gray-500">
          <p>Dubiz is operated by PRO MAX GROUP.</p>
          <p className="mt-1">© 2026 PRO MAX GROUP. כל הזכויות שמורות.</p>
        </div>
      </CorporateContainer>
    </footer>
  );
}
