"use client";

import type { ReactNode } from "react";
import styles from "./review-adaptive.module.css";

export type ReviewWorkspaceLayoutProps = {
  /** Editor content above the preview in single-column order (panel header + impact). */
  editorTop: ReactNode;
  /** The source-document preview surface. */
  preview: ReactNode;
  /** Editor content below the preview in single-column order (trust + fields). */
  editorBottom: ReactNode;
  /** Decision actions (approve / save-as-document). */
  actions: ReactNode;
};

/**
 * Documents Review Preview–Editor workspace — STRUCTURE ONLY.
 *
 * Deliberately NOT MasterDetailLayout: there is no master list, no separately
 * selected entity and no child route — both regions belong to the same document
 * and the same route, and the split is not route-driven. This is a single-entity
 * two-pane arrangement.
 *
 * One DOM, CSS-driven (see review-adaptive.module.css):
 *   < 1280px  → single column, natural order editorTop → preview → editorBottom
 *               → actions (the historical layout; mobile stays pixel-identical).
 *   >= 1280px → two columns; editor (top/bottom/actions) on the inline-start
 *               (right in RTL), preview pinned on the inline-end (left).
 *
 * Carries no document data, fetching, validation, trust or approval logic and no
 * palette beyond the structural grid. Region landmarks are provided so the two
 * panes are distinguishable to assistive tech.
 */
export default function ReviewWorkspaceLayout({
  editorTop,
  preview,
  editorBottom,
  actions,
}: ReviewWorkspaceLayoutProps) {
  return (
    <div className={styles.workspace}>
      <div className={styles.editorTop}>{editorTop}</div>
      <div className={styles.preview}>{preview}</div>
      <div className={styles.editorBottom}>{editorBottom}</div>
      <div className={styles.actions}>{actions}</div>
    </div>
  );
}
