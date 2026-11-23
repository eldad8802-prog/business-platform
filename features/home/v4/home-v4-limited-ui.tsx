"use client";

/**
 * HOME v4 — the FREE_LIMITED status line and plan card (owner decisions 3 + 4). Loaded on demand with its texts
 * (limited-copy-loader.ts), only when the subscription says FREE_LIMITED — never today, so no business downloads it.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { IconLayers } from "./home-v4-icons";
import { LIMITED_CSS, type LimitedCopy } from "./home-v4-limited-copy";

export { LIMITED_CSS, limitedCopy, type LimitedCopy } from "./home-v4-limited-copy";

/** The header with ONE status line under it — the first of the only two upgrade mentions on the Home. */
export function LimitedHeader({ header, copy, planHref }: { header: ReactNode; copy: LimitedCopy; planHref: string | null }) {
  return (
    <div className="h4-head">
      <style>{LIMITED_CSS}</style>
      {header}
      <div className="h4-status" role="status">
        <span>{copy.statusLine}</span>
        {planHref ? (
          <Link href={planHref} prefetch={false}>
            {copy.statusLink}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** בשבילך as ONE plan card — the second and last upgrade mention on the Home. */
export function LimitedPlanCard({ copy, planHref, title }: { copy: LimitedCopy; planHref: string | null; title: string }) {
  return (
    <section className="h4-card h4-a-fy" aria-labelledby="h4-fy-title">
      <div className="h4-chead">
        <h2 className="h4-ctitle" id="h4-fy-title">
          <IconLayers size={22} />
          {title}
        </h2>
      </div>
      <div className="h4-fy">
        <div className="h4-fy-text">
          <div className="h4-fy-eyebrow">{copy.eyebrow}</div>
          <p className="h4-fy-title">{copy.title}</p>
          <p className="h4-fy-desc">{copy.body}</p>
          {planHref ? (
            <div className="h4-sec-actions">
              <Link href={planHref} prefetch={false} className="h4-btn">
                {copy.cta}
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
