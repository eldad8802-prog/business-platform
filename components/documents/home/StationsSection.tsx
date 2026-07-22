"use client";

import type { ReactNode } from "react";
import {
  ReviewQueueIcon,
  SearchIcon,
  AccountantPackIcon,
  ChevronIcon,
} from "./home-icons";

type StationsSectionProps = {
  pendingCount: number;
  onQueue: () => void;
  onSearch: () => void;
  onPack: () => void;
};

function StationRow({
  icon,
  title,
  subtitle,
  count,
  attn,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  count?: number;
  attn?: boolean;
  onClick: () => void;
}) {
  const showBadge = typeof count === "number" && count > 0;
  return (
    <button
      type="button"
      className={`dz-station${attn && showBadge ? " dz-station--attn" : ""}`}
      onClick={onClick}
    >
      <span className="dz-station__ico">{icon}</span>
      <span className="dz-station__tx">
        <b>{title}</b>
        <small>{subtitle}</small>
      </span>
      {showBadge ? (
        <span className="dz-badge">{count.toLocaleString("he-IL")}</span>
      ) : (
        <span className="dz-chev">
          <ChevronIcon />
        </span>
      )}
    </button>
  );
}

/** The three Documents stations: review queue, search, accountant pack. */
export default function StationsSection({
  pendingCount,
  onQueue,
  onSearch,
  onPack,
}: StationsSectionProps) {
  return (
    <>
      <div className="dz-sec-title">תחנות</div>
      <div className="dz-stations">
        <StationRow
          icon={<ReviewQueueIcon />}
          title="תור אימות"
          subtitle="ממתינים לאישור שלך"
          count={pendingCount}
          attn
          onClick={onQueue}
        />
        <StationRow
          icon={<SearchIcon />}
          title="חיפוש מסמכים"
          subtitle="לפי ספק, סכום או תאריך"
          onClick={onSearch}
        />
        <StationRow
          icon={<AccountantPackIcon />}
          title="חבילת רו״ח"
          subtitle="ייצוא תקופה מסודר"
          onClick={onPack}
        />
      </div>
    </>
  );
}
