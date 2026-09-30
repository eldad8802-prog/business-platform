import type { ReactNode } from "react";
import styles from "../settings-desk.module.css";

/**
 * Import and export are check-before-write flows: pick a domain, check a file,
 * confirm. On desktop they keep a reading measure beside the settings rail
 * rather than stretching a checklist across the canvas. Below 1200 `focused`
 * sets nothing.
 */
export default function ImportExportLayout({ children }: { children: ReactNode }) {
  return <div className={styles.focused}>{children}</div>;
}
