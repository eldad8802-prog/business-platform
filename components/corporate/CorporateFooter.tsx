import Image from "next/image";
import Link from "next/link";
import { CorporateContainer } from "./CorporateContainer";

/**
 * Corporate footer: navigation, legal links, and the mandatory operating
 * entity statement required for the Dubiz / PRO MAX GROUP corporate site.
 */
export function CorporateFooter() {
  return (
    <footer className="mt-16 border-t border-[var(--mkt-border)] bg-[var(--mkt-soft)]">
      <CorporateContainer className="py-10">
        <div className="flex flex-col gap-8 sm:flex-row sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-lg font-extrabold text-[var(--dz-text-primary)]">
              <Image
                src="/dubiz-logo.png"
                alt="Dubiz"
                width={124}
                height={40}
                className="h-9 w-auto"
              />
            </div>
            <p className="mt-3 max-w-xs text-sm leading-6 text-[var(--dz-text-muted)]">
              מרכזת את היום־יום של העסק שלך — לקוחות, כסף ומסמכים — במקום אחד.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:gap-12">
            <div>
              <p className="text-xs font-bold tracking-wide text-[var(--dz-text-muted)]">
                ניווט
              </p>
              <ul className="mt-3 space-y-2 text-sm">
                <li>
                  <Link href="/home" className="text-[var(--dz-text-muted)] hover:text-[var(--mkt-ink)]">
                    בית
                  </Link>
                </li>
                <li>
                  <Link href="/about" className="text-[var(--dz-text-muted)] hover:text-[var(--mkt-ink)]">
                    אודות
                  </Link>
                </li>
                <li>
                  <Link
                    href="/contact"
                    className="text-[var(--dz-text-muted)] hover:text-[var(--mkt-ink)]"
                  >
                    צור קשר
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <p className="text-xs font-bold tracking-wide text-[var(--dz-text-muted)]">
                משפטי
              </p>
              <ul className="mt-3 space-y-2 text-sm">
                <li>
                  <Link
                    href="/privacy"
                    className="text-[var(--dz-text-muted)] hover:text-[var(--mkt-ink)]"
                  >
                    מדיניות פרטיות
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="text-[var(--dz-text-muted)] hover:text-[var(--mkt-ink)]">
                    תנאי שימוש
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-10 border-t border-[var(--dz-border-subtle)] pt-6 text-sm text-[var(--dz-text-muted)]">
          <p>Dubiz is operated by PRO MAX GROUP.</p>
          <p className="mt-1">© 2026 PRO MAX GROUP. כל הזכויות שמורות.</p>
        </div>
      </CorporateContainer>
    </footer>
  );
}
