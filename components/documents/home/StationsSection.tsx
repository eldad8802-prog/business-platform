"use client";

import type { ReactNode } from "react";
import {
  ReviewQueueIcon,
  SearchIcon,
  AccountantPackIcon,
  ChevronIcon,
} from "./home-icons";
import { useI18n } from "@/components/i18n/I18nProvider";
import { formatNumber } from "@/lib/i18n/format";

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
  const { fmt } = useI18n();
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
        <span className="dz-badge">{formatNumber(count, fmt)}</span>
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
  const { t } = useI18n();
  return (
    <>
      <div className="dz-sec-title">{t("documents.home.stations")}</div>
      <div className="dz-stations">
        <StationRow
          icon={<ReviewQueueIcon />}
          title={t("documents.home.stationQueue")}
          subtitle={t("documents.home.stationQueueSub")}
          count={pendingCount}
          attn
          onClick={onQueue}
        />
        <StationRow
          icon={<SearchIcon />}
          title={t("documents.home.stationSearch")}
          subtitle={t("documents.home.stationSearchSub")}
          onClick={onSearch}
        />
        <StationRow
          icon={<AccountantPackIcon />}
          title={t("documents.home.stationPack")}
          subtitle={t("documents.home.stationPackSub")}
          onClick={onPack}
        />
      </div>
    </>
  );
}
