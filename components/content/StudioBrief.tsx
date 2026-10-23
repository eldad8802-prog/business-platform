"use client";

import { useMemo, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

/**
 * Desktop context column for the content studio (shown from 1200 by
 * `content-desktop.css`).
 *
 * Every studio step reads and writes one `content_flow` object in
 * localStorage. On a phone the owner holds earlier answers in their head; on
 * desktop they are listed beside the step, so the next decision is made with
 * the previous ones in view. It lists only what was actually chosen. It is
 * not a step rail: the studio branches (camera or AI) and a rail would imply
 * one path. Read-only — changing an answer still happens on its own step.
 *
 * The labels mirror the option lists on each step's page (dictionary keys,
 * resolved at render). A page file may
 * only export what Next allows, so they cannot be imported from there.
 */

type ContentFlow = {
  vibe?: string;
  canFilm?: boolean;
  primaryGoal?: string;
  selectedPlatform?: string;
  directionType?: string;
  creatorContext?: string | null;
  selectedFormat?: string;
};

const VIBE: Record<string, MessageKey> = {
  professional_clean: "content.studioFlow.options.vibe.professional_clean",
  warm_personal: "content.studioFlow.options.vibe.warm_personal",
  bold_energetic: "content.studioFlow.options.vibe.bold_energetic",
  premium_luxury: "content.studioFlow.options.vibe.premium_luxury",
};

const GOAL: Record<string, MessageKey> = {
  leads: "content.studioFlow.options.goal.leads",
  exposure: "content.studioFlow.options.goal.exposure",
  trust: "content.studioFlow.options.goal.trust",
  sales: "content.studioFlow.options.goal.sales",
  brand: "content.studioFlow.options.goal.brand",
};

// Brand names are not translated.
const PLATFORM: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
};

const DIRECTION: Record<string, MessageKey> = {
  authentic: "content.studioFlow.options.direction.authentic",
  attention: "content.studioFlow.options.direction.attention",
  proof: "content.studioFlow.options.direction.proof",
  differentiation: "content.studioFlow.options.direction.differentiation",
  direct: "content.studioFlow.options.direction.direct",
};

const FORMAT: Record<string, MessageKey> = {
  reel: "content.studioFlow.options.format.reel",
  video: "content.studioFlow.options.format.video",
  image: "content.studioFlow.options.format.image",
  post: "content.studioFlow.options.format.post",
};

const HOW_IT_WORKS: readonly MessageKey[] = [
  "content.studioFlow.brief.steps.feel",
  "content.studioFlow.brief.steps.direction",
  "content.studioFlow.brief.steps.film",
  "content.studioFlow.brief.steps.ready",
];

function platformLabel(t: Translator, platform: string): string | undefined {
  if (platform === "unknown") return t("content.studioFlow.options.platform.unknown");
  return PLATFORM[platform];
}

function label(t: Translator, map: Record<string, MessageKey>, id: string | undefined): string | undefined {
  const key = id ? map[id] : undefined;
  return key ? t(key) : undefined;
}

// The raw string is the snapshot: equal strings compare equal, so an
// unchanged flow never re-renders. `storage` covers another tab; within this
// tab each step writes before it navigates, and the route change re-renders
// this layout-level component, which reads the snapshot again.
function readRaw(): string | null {
  try {
    return localStorage.getItem("content_flow");
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function parseFlow(raw: string | null): ContentFlow {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ContentFlow;
  } catch {
    return {};
  }
}

function rowsFor(t: Translator, flow: ContentFlow): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string | undefined }> = [
    { label: t("content.studioFlow.brief.rows.vibe"), value: label(t, VIBE, flow.vibe) },
    {
      label: t("content.studioFlow.brief.rows.camera"),
      value:
        typeof flow.canFilm === "boolean"
          ? t(flow.canFilm ? "content.studioFlow.brief.cameraYes" : "content.studioFlow.brief.cameraNo")
          : undefined,
    },
    { label: t("content.studioFlow.brief.rows.goal"), value: label(t, GOAL, flow.primaryGoal) },
    {
      label: t("content.studioFlow.brief.rows.platform"),
      value: flow.selectedPlatform ? platformLabel(t, flow.selectedPlatform) : undefined,
    },
    { label: t("content.studioFlow.brief.rows.direction"), value: label(t, DIRECTION, flow.directionType) },
    { label: t("content.studioFlow.brief.rows.format"), value: label(t, FORMAT, flow.selectedFormat) },
    {
      label: t("content.studioFlow.brief.rows.business"),
      value: typeof flow.creatorContext === "string" && flow.creatorContext.trim()
        ? flow.creatorContext.trim()
        : undefined,
    },
  ];
  return rows.filter((row): row is { label: string; value: string } => Boolean(row.value));
}

/**
 * The legacy chain (flow → mode → context, intent/value/style → mode, summary)
 * is linked from nowhere in the product. Its steps use full-width fixed
 * buttons that would run under this column, so on those routes the brief is
 * not rendered and they behave exactly as they did before it existed.
 */
const LEGACY_STEPS = new Set(["flow", "mode", "intent", "value", "style", "context", "summary"]);

export function StudioBrief() {
  // Subscribing to the pathname makes every route change re-render the brief.
  const pathname = usePathname() ?? "";
  const { t } = useI18n();
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const rows = useMemo(() => rowsFor(t, parseFlow(raw)), [t, raw]);
  if (LEGACY_STEPS.has(pathname.split("/")[2] ?? "")) return null;

  return (
    <aside className="studio-brief" aria-label={t("content.studioFlow.brief.aria")}>
      {rows.length > 0 ? (
        <>
          <h2>{t("content.studioFlow.brief.title")}</h2>
          <p>{t("content.studioFlow.brief.subtitle")}</p>
          <dl>
            {rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <>
          <h2>{t("content.studioFlow.brief.emptyTitle")}</h2>
          <p>{t("content.studioFlow.brief.emptySubtitle")}</p>
          <ol>
            {HOW_IT_WORKS.map((step) => (
              <li key={step}>{t(step)}</li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
