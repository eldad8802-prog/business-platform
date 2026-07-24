"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_DESTINATIONS, isNavActive } from "./nav-destinations";

/**
 * Side navigation for tablet (compact rail) and desktop (full sidebar).
 *
 * Renders the SAME `NAV_DESTINATIONS` source as the mobile bottom bar — no
 * duplicated nav list. Visual language is DS v1 warm (cream card + teal accent),
 * driven by the `.shell-sidenav*` classes injected once in `ShellChrome` so all
 * shell CSS lives in one place. Fixed to the inline-start edge (right in RTL);
 * `ShellChrome` reserves the matching `padding-inline-start` on the content.
 *
 * `compact` = tablet rail (icons only, labels become tooltips/aria-labels).
 */
export function SideNav({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname() || "/";

  return (
    <nav
      dir="rtl"
      aria-label="ניווט ראשי"
      className={`shell-sidenav ${compact ? "shell-sidenav--rail" : "shell-sidenav--full"}`}
    >
      <div className="shell-brand" aria-hidden={compact ? undefined : false}>
        {compact ? <span className="shell-brand__mark">D</span> : <span className="shell-brand__word">dubiz</span>}
      </div>

      <ul className="shell-navlist">
        {NAV_DESTINATIONS.map((d) => {
          const active = isNavActive(pathname, d.href);
          const Icon = d.icon;
          return (
            <li key={d.key}>
              <Link
                href={d.href}
                prefetch={false}
                className="shell-navitem"
                aria-current={active ? "page" : undefined}
                title={compact ? d.label : undefined}
                aria-label={compact ? d.label : undefined}
              >
                <span className="shell-navitem__icon" aria-hidden>
                  <Icon active={active} />
                </span>
                {compact ? null : <span className="shell-navitem__label">{d.label}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
