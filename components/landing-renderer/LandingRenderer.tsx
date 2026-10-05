"use client";

import { assertRenderable, RendererError, type RenderModel } from "@/lib/services/landing/renderer/render-model";
import { ActionBlock, HeroSection, SectionRenderer, type ImageLoader } from "./sections";
import styles from "./landing-renderer.module.css";

/**
 * P3-D · The deterministic landing renderer (p3d.renderer.v1). It draws a server-built RenderModel with
 * owned components only: every value is React text; no HTML, Markdown, styles or class names come from
 * data; no model is called. The visual profile (data-* attributes) chooses presentation only.
 *
 * It re-checks the model it receives (versions, closed section set, SURFACE_ONLY invariants) and
 * renders a fail-closed notice instead of anything it does not recognise.
 *
 * Responsive by CONTAINER width (CSS container queries), so the same component is correct in the
 * owner's device frames (mobile / tablet / desktop) and in a full browser window.
 */
export function LandingRenderer({ model, loadImage }: { model: unknown; loadImage?: ImageLoader }) {
  let m: RenderModel;
  try {
    assertRenderable(model);
    m = model;
  } catch (error) {
    const code = error instanceof RendererError ? error.code : "INVALID_RENDER_MODEL";
    return (
      <div className={styles.refused} role="alert" data-renderer-refused={code}>
        לא ניתן להציג את הדף הזה בתצוגה מקדימה. ({code})
      </div>
    );
  }
  const p = m.profile;
  return (
    <div
      className={styles.canvas}
      dir="rtl"
      lang="he"
      data-renderer={m.rendererVersion}
      data-strategy={m.strategyType}
      data-mode={m.mode}
      data-surface-only={m.surfaceOnly ? "true" : "false"}
      data-composition={p.composition}
      data-hero={p.heroTreatment}
      data-density={p.density}
      data-cards={p.cardTreatment}
      data-images={p.imageEmphasis}
      data-width={p.contentWidth}
      data-cta={p.ctaEmphasis}
      data-trust={p.trustTreatment}
      data-rhythm={p.rhythm}
      data-palette={p.palette}
    >
      <main className={styles.page} aria-label={m.businessName ?? m.meta.title}>
        <HeroSection model={m} loadImage={loadImage} />
        {m.sections.map((s, i) => (
          <SectionRenderer key={s.key} section={s} index={i} model={m} loadImage={loadImage} />
        ))}
        {!m.surfaceOnly && m.primaryAction && !m.sections.some((s) => s.type === "PRIMARY_ACTION" || s.type === "CONTACT_PANEL") && (
          <section className={styles.closing} aria-label={m.primaryAction.label}>
            <ActionBlock action={m.primaryAction} secondary={m.secondaryAction} emphasis={p.ctaEmphasis} />
          </section>
        )}
        <footer className={styles.footer}>
          <span>{m.businessName ?? m.meta.title}</span>
        </footer>
      </main>
    </div>
  );
}
