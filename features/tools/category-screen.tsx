"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import BackButton from "@/components/ui/back-button";
import {
  HOME_ROUTES,
  TOOL_GROUPS,
  toolsInGroup,
  type ToolGroupKey,
} from "@/lib/navigation/home-routes";
import { groupStatus, type GroupStatus } from "@/features/home/lib/home-model";
import type { BusinessStatusItem } from "@/lib/business-status/types";
import { categoryToneCss } from "@/features/tools/category-tones";
import { EntityIcon } from "@/components/ui/entity/entity-icon";

/**
 * A category screen — /tools/money, /tools/customers, /tools/operations.
 *
 * The Home card the owner tapped opens THIS: its own category, and nothing
 * from the other two. The journey is one decision long — the owner already
 * chose the category on Home, so the screen's only job is to show what lives
 * in it and let them pick a tool.
 *
 * Everything comes from `lib/navigation/home-routes.ts` (name, blurb, members,
 * destinations, one-line purposes); nothing here is a second copy of the list.
 * The status chip is the same label Home shows, from the same source, with the
 * same honesty rule: while it loads — or if it fails — the chip holds a
 * wordless skeleton and never a guessed "הכול מטופל".
 */
export function CategoryScreen({ groupKey }: { groupKey: ToolGroupKey }) {
  const group = TOOL_GROUPS.find((g) => g.key === groupKey)!;
  const tools = toolsInGroup(groupKey);
  const [status, setStatus] = useState<GroupStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let token: string | null = null;
    try {
      token = localStorage.getItem("token");
    } catch {
      token = null;
    }
    if (!token) return;

    fetch("/api/business-status", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { items?: BusinessStatusItem[] } | null) => {
        if (!cancelled && json?.items) setStatus(groupStatus(json.items, group.domains));
      })
      .catch(() => {
        /* the chip stays a skeleton */
      });

    return () => {
      cancelled = true;
    };
  }, [group.domains]);

  return (
    <main dir="rtl" data-page-intent="content" className={`dzcat tone-${group.key}`}>
      <style>{categoryToneCss(".dzcat")}</style>
      <style>{CATEGORY_CSS}</style>

      <div className="cwrap">
        <div className="cback">
          <BackButton href={HOME_ROUTES.home} label="לבית" />
        </div>

        <header className="chero">
          <span className="chero-ic" aria-hidden>
            {group.icons.map((entity) => (
              <span key={entity} className="chero-i">
                <EntityIcon entity={entity} size={24} />
              </span>
            ))}
          </span>
          <div className="chero-tx">
            <h1>{group.label}</h1>
            <p>{group.capabilityLine}</p>
            {status ? (
              <span className={`cstat cstat-${status.tone}`}>
                <span className="cdot" aria-hidden />
                {status.label}
              </span>
            ) : (
              <span className="cstat cstat-loading" aria-hidden>
                <span className="csk" />
              </span>
            )}
          </div>
        </header>

        <h2 className="clabel" id="cat-tools">הכלים בתחום</h2>
        <ul className="clist" aria-labelledby="cat-tools">
          {tools.map((tool) => (
            <li key={tool.key}>
              <Link href={tool.href} className="crow" data-tool={tool.key}>
                <span className="crow-ic" aria-hidden>
                  <EntityIcon entity={tool.entity} size={26} />
                </span>
                <span className="crow-tx">
                  <span className="crow-name">{tool.label}</span>
                  <span className="crow-desc">{tool.description}</span>
                </span>
                <span className="crow-chev" aria-hidden>
                  ‹
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

/**
 * Scoped styles. The category tone comes from `category-tones.ts` (the same
 * values the Home card paints); every other colour is a Mist token.
 */
const CATEGORY_CSS = `
.dzcat{
  min-height:100dvh;direction:rtl;color:var(--dz-text-primary);
  font-family:var(--font-heebo),'Heebo','Assistant',system-ui,sans-serif;
  background:var(--dz-background);
  padding:calc(12px + var(--dz-safe-top,0px)) 20px 28px;
  -webkit-font-smoothing:antialiased;
}
.dzcat .cwrap{max-width:560px;margin:0 auto}
.dzcat a{text-decoration:none;color:inherit;-webkit-tap-highlight-color:transparent}
.dzcat .cback{display:flex;justify-content:flex-start;margin-bottom:14px}

/* The category itself: the same quiet tone as the Home card, compact. */
.dzcat .chero{display:flex;align-items:flex-start;gap:14px;padding:20px 18px;border-radius:22px;margin-bottom:20px;
  color:#fff;border:1px solid rgba(255,255,255,.06);
  background:radial-gradient(90% 120% at 0% 0%,rgba(255,255,255,.07),transparent 60%),linear-gradient(135deg,var(--ct-a) 0%,var(--ct-b) 100%);
  box-shadow:0 6px 18px -14px rgba(46,40,30,.45)}
.dzcat .chero-ic{flex:0 0 auto;display:flex;align-items:center}
.dzcat .chero-i{display:flex;margin-inline-start:-9px;padding:5px;border-radius:50%;background:rgba(255,255,255,.1)}
.dzcat .chero-i:first-child{margin-inline-start:0}
.dzcat .chero-tx{min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:4px}
.dzcat .chero-tx h1{margin:0;font-family:var(--font-rubik),'Rubik',sans-serif;font-size:22px;font-weight:700;line-height:1.2;letter-spacing:-.01em;color:#fff}
.dzcat .chero-tx p{margin:0;font-size:13px;font-weight:500;line-height:1.5;color:#EEF2F0;text-wrap:balance}
.dzcat .cstat{display:inline-flex;align-items:center;gap:6px;margin-top:6px;padding:3px 10px;border-radius:999px;
  font-size:11.5px;font-weight:600;line-height:1.35;color:#fff;background:rgba(255,255,255,.07)}
.dzcat .cdot{width:6px;height:6px;border-radius:50%;flex:0 0 auto}
.dzcat .cstat-clear .cdot{background:#A7D9C0}
.dzcat .cstat-review .cdot{background:#E9C987}
.dzcat .cstat-urgent .cdot{background:#F0A594}
.dzcat .cstat-loading{background:none;padding:0}
.dzcat .csk{display:block;width:74px;height:20px;border-radius:999px;background:rgba(255,255,255,.08)}

/* The tools: ONE grouped surface, one row per tool — glyph, name, what it is
   for, and a way in. Grouped rather than separate cards so a short category
   (three tools) still reads as a complete, bounded list, not cards floating
   above empty space. Rows are separated by an inset hairline. */
.dzcat .clabel{margin:0 4px 10px;font-size:13px;font-weight:700;color:var(--dz-text-secondary)}
.dzcat .clist{list-style:none;margin:0;padding:4px 0;border-radius:22px;overflow:hidden;
  background:var(--dz-surface);border:1px solid var(--dz-border);box-shadow:var(--dz-shadow-card)}
.dzcat .clist li+li{position:relative}
.dzcat .clist li+li::before{content:"";position:absolute;top:0;inset-inline-start:78px;inset-inline-end:18px;height:1px;background:var(--dz-border)}
.dzcat .crow{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;column-gap:14px;
  min-height:80px;padding:15px 18px 15px 14px;transition:background .14s ease}
.dzcat .crow:active{background:var(--dz-control-hover)}
.dzcat .crow:focus-visible{outline:3px solid var(--ct-a);outline-offset:-3px;border-radius:18px}
@media (hover:hover){.dzcat .crow:hover{background:var(--dz-control-hover)}}
.dzcat .crow-ic{width:50px;height:50px;border-radius:15px;display:flex;align-items:center;justify-content:center;
  background:var(--ct-tint)}
.dzcat .crow-tx{min-width:0;display:flex;flex-direction:column;gap:3px}
.dzcat .crow-name{font-size:16.5px;font-weight:700;line-height:1.3;color:var(--dz-text-primary)}
.dzcat .crow-desc{font-size:13px;font-weight:500;line-height:1.45;color:var(--dz-text-secondary);text-wrap:balance}
.dzcat .crow-chev{width:28px;height:28px;display:flex;align-items:center;justify-content:center;
  font-size:20px;line-height:1;color:var(--dz-text-muted)}

@media (min-width:768px){
  .dzcat .cwrap{max-width:720px}
  .dzcat .clist{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0;
    background:none;border:0;box-shadow:none;border-radius:0;overflow:visible}
  .dzcat .clist li+li::before{display:none}
  .dzcat .crow{border-radius:20px;background:var(--dz-surface);border:1px solid var(--dz-border);box-shadow:var(--dz-shadow-card)}
}
@media (min-width:1024px){
  .dzcat{padding:calc(12px + var(--dz-safe-top,0px)) 32px 32px}
  .dzcat .cwrap{max-width:960px}
}
`;
