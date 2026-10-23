import styles from "./admin-console.module.css";

const PATHS = {
  home: "M3 11l9-7 9 7M5 10v10h14V10",
  businesses: "M3 7h18v13H3zM8 7V5a2 2 0 012-2h4a2 2 0 012 2v2",
  audit: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4-4",
  tools: "M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-3-3z",
  back: "M9 6l6 6-6 6",
  key: "M15 7a4 4 0 11-4 4M11 11l-8 8M6 16l2 2M9 13l2 2",
  face: "M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2M9 10v1M15 10v1M12 10v3h-1M9 16c1.5 1 4.5 1 6 0",
  refresh: "M20 11a8 8 0 10-2.3 5.7M20 4v7h-7",
} as const;

export type ConsoleIconName = keyof typeof PATHS;

export function ConsoleIcon({ name, size = 18 }: { name: ConsoleIconName; size?: number }) {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
