"use client";

import Link from "next/link";

import { IconChevronLeft, IconFileLines, IconWallet } from "@/components/navigation/nav-icons";

import type { RecommendationView } from "./recommendations-client";
import styles from "./recommendations.module.css";

export function RecommendationIcon({ type, large }: { type: RecommendationView["type"]; large?: boolean }) {
  const Icon = type === "SETTLE_OVERDUE_INSTALLMENT" ? IconWallet : IconFileLines;
  const tone = type === "SETTLE_OVERDUE_INSTALLMENT" ? styles.iconPayables : styles.iconDocuments;
  return (
    <span className={`${styles.icon} ${tone} ${large ? styles.iconLarge : ""}`} aria-hidden="true">
      <Icon size={large ? 28 : 24} strokeWidth={2} />
    </span>
  );
}

export function StageBadge({ view }: { view: RecommendationView }) {
  const cls = view.stage === "waiting" ? styles.stageWaiting : view.stage === "in_progress" ? styles.stageProgress : styles.stageClosed;
  return <span className={`${styles.stage} ${cls}`}>{view.status}</span>;
}

export function RecommendationRow({ view }: { view: RecommendationView }) {
  return (
    <li>
      <Link href={`/recommendations/${view.id}`} prefetch={false} className={styles.row}>
        <RecommendationIcon type={view.type} />
        <span className={styles.rowText}>
          <span className={styles.rowWhat}>{view.what}</span>
          <span className={styles.rowMeta}>{view.summary}</span>
          <StageBadge view={view} />
        </span>
        <span className={styles.chevron} aria-hidden="true">
          <IconChevronLeft size={18} strokeWidth={2} />
        </span>
      </Link>
    </li>
  );
}
