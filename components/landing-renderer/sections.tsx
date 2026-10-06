"use client";

import { useEffect, useState } from "react";
import type { RenderAction, RenderImage, RenderModel, RenderOffering, RenderSection } from "@/lib/services/landing/renderer/render-model";
import styles from "./landing-renderer.module.css";

/**
 * P3-D · Closed section component system. One owned component per section type; the renderer — not the
 * data — owns heading levels (h1 hero, h2 section, h3 item). Every string is React text.
 *
 * OWNER_PREVIEW: actions are DRAWN, never performed — no href, no tel:/wa.me/mailto:, no form element,
 * no submit. The approved destination is shown as text so the owner can check it.
 */

/** Loads an owner-only preview image (Bearer-authenticated fetch → object URL). Optional: without it the
 *  renderer draws a neutral placeholder that still carries the asset ref (static renders, tests). */
export type ImageLoader = (src: string) => Promise<string | null>;

const CHANNEL_HE: Record<string, string> = {
  PHONE: "שיחת טלפון",
  WHATSAPP_LINK: "וואטסאפ",
  WHATSAPP_CLOUD: "וואטסאפ העסקי",
  EMAIL: "אימייל",
  IN_PERSON: "הגעה לעסק",
  DUBIZ_FORM: "טופס פנייה",
};

function PreviewImage({ image, loadImage, className }: { image: RenderImage; loadImage?: ImageLoader; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!loadImage) return;
    let cancelled = false;
    let created: string | null = null;
    void loadImage(image.src).then((u) => {
      created = u;
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [image.src, loadImage]);
  return (
    <figure className={`${styles.figure} ${className ?? ""}`} data-asset-ref={image.ref} data-illustrative={image.illustrative ? "true" : "false"}>
      {url ? (
        // A short-lived object URL from a Bearer-authenticated fetch: next/image cannot optimise it.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={image.alt} className={styles.img} />
      ) : (
        <div className={styles.imgPlaceholder} role="img" aria-label={image.alt} />
      )}
      {/* A generated image is an illustration, never a real person / place / job. */}
      {image.illustrative && <figcaption className={styles.illustrativeTag}>איור להמחשה</figcaption>}
    </figure>
  );
}

/** Presentation only: a secondary action that leads to the very same channel and destination as the
 *  primary (e.g. "visit" and "buy in store") is drawn once. The actions themselves are unchanged. */
function sameDestination(a: RenderAction, b: RenderAction | null): boolean {
  return !!b && a.channel === b.channel && a.destinationDisplay === b.destinationDisplay;
}

export function ActionBlock({ action, secondary, emphasis }: { action: RenderAction; secondary: RenderAction | null; emphasis: string }) {
  const showSecondary = secondary && !sameDestination(action, secondary);
  return (
    <div className={styles.actionBlock} data-cta-emphasis={emphasis}>
      <ActionButton action={action} primary />
      {showSecondary && <ActionButton action={secondary} primary={false} />}
    </div>
  );
}

function ActionButton({ action, primary }: { action: RenderAction; primary: boolean }) {
  if (action.behaviour === "FORM") return <PreviewLeadForm action={action} />;
  return (
    <div className={styles.actionWrap}>
      <button
        type="button"
        className={primary ? styles.cta : styles.ctaSecondary}
        aria-disabled="true"
        data-preview-action={action.channel}
        data-available={action.available ? "true" : "false"}
        title="תצוגה מקדימה — הפעולה לא מבוצעת"
      >
        {action.label}
      </button>
      <p className={styles.actionNote}>
        {CHANNEL_HE[action.channel] ?? action.channel}
        {action.destinationDisplay ? ` · ${action.destinationDisplay}` : ""}
        {!action.available && " · חסרים פרטים מאושרים להפעלה"}
        {action.platformUnproven && " · ערוץ שעדיין לא הוכח במלואו"}
      </p>
    </div>
  );
}

/** DUBIZ_FORM in preview: a visual of the form. No <form>, no action, no endpoint, inputs disabled. */
function PreviewLeadForm({ action }: { action: RenderAction }) {
  return (
    <div className={styles.leadForm} role="group" aria-label={action.label} data-preview-action="DUBIZ_FORM" data-inert="true">
      <div className={styles.field}><span>שם</span><input disabled aria-disabled="true" tabIndex={-1} /></div>
      <div className={styles.field}><span>טלפון</span><input disabled aria-disabled="true" tabIndex={-1} /></div>
      <div className={styles.field}><span>במה נוכל לעזור?</span><textarea disabled aria-disabled="true" tabIndex={-1} rows={2} /></div>
      <button type="button" className={styles.cta} aria-disabled="true" disabled>{action.label}</button>
      <p className={styles.actionNote}>טופס לדוגמה בתצוגה מקדימה — שום פנייה לא נשלחת.</p>
    </div>
  );
}

export function HeroSection({ model, loadImage }: { model: RenderModel; loadImage?: ImageLoader }) {
  const h = model.hero;
  const initial = (model.businessName ?? model.meta.title ?? "").trim().charAt(0);
  const placeFacts = model.sections.find((s) => s.type === "LOCATION_AND_HOURS");
  // Banded proof / catalog-strip heroes go straight to the content: no aside is rendered at all.
  const showAside = model.profile.heroTreatment !== "PROOF_BAND" && model.profile.heroTreatment !== "CATALOG_STRIP";
  return (
    <header className={styles.hero} data-section="HERO" data-fallback={h.fallback ?? "IMAGE"}>
      <div className={styles.heroInner}>
        <div className={styles.heroText}>
          {model.businessName && <p className={styles.eyebrow}>{model.businessName}</p>}
          <h1 className={styles.h1}>{h.headline}</h1>
          <p className={styles.lead}>{h.subheadline}</p>
          {!model.surfaceOnly && model.primaryAction && model.profile.ctaEmphasis === "PROMINENT" && (
            <ActionBlock action={model.primaryAction} secondary={null} emphasis="PROMINENT" />
          )}
        </div>
        {showAside && (
        <div className={styles.heroAside}>
          {h.image ? (
            <PreviewImage image={h.image} loadImage={loadImage} className={styles.heroImage} />
          ) : model.profile.heroTreatment === "PLACE_CARD" && placeFacts && placeFacts.type === "LOCATION_AND_HOURS" ? (
            <div className={styles.placeCard} aria-hidden="true">
              {placeFacts.facts.map((f) => (
                <p key={f.key}><span>{f.label}</span>{f.value}</p>
              ))}
            </div>
          ) : (
            // Intentional typographic fallback — never a fabricated photo.
            <div className={styles.monogram} aria-hidden="true">{initial}</div>
          )}
        </div>
        )}
      </div>
    </header>
  );
}

function OfferingCard({ o, loadImage }: { o: RenderOffering; loadImage?: ImageLoader }) {
  return (
    <li className={styles.card} data-offering-ref={o.ref}>
      {o.image && <PreviewImage image={o.image} loadImage={loadImage} className={styles.cardImage} />}
      <div className={styles.cardBody}>
        <h3 className={styles.h3}>{o.name}</h3>
        {o.priceText && <p className={styles.price} data-price>{o.priceText}</p>}
        {o.description && <p className={styles.text}>{o.description}</p>}
        <p className={styles.muted}>{o.blurb}</p>
      </div>
    </li>
  );
}

function SectionFrame({ section, index, children, label }: { section: RenderSection; index: number; children: React.ReactNode; label: string }) {
  return (
    <section className={styles.section} data-section={section.type} data-index={index} aria-labelledby={`${section.key}-h`}>
      <div className={styles.sectionInner}>
        <h2 id={`${section.key}-h`} className={styles.h2}>{label}</h2>
        {children}
      </div>
    </section>
  );
}

export function SectionRenderer({ section, index, model, loadImage }: { section: RenderSection; index: number; model: RenderModel; loadImage?: ImageLoader }) {
  switch (section.type) {
    case "PRIMARY_ACTION":
    case "CONTACT_PANEL":
      return (
        <SectionFrame section={section} index={index} label={section.heading}>
          <p className={styles.text}>{section.body}</p>
          {section.action && !model.surfaceOnly && <ActionBlock action={section.action} secondary={model.secondaryAction} emphasis={model.profile.ctaEmphasis} />}
        </SectionFrame>
      );
    case "ABOUT":
      return (
        <SectionFrame section={section} index={index} label={section.heading}>
          <p className={styles.text}>{section.body}</p>
          {section.statements.map((t, i) => <p key={i} className={styles.statement}>{t}</p>)}
        </SectionFrame>
      );
    case "SERVICE_AREA":
      return (
        <SectionFrame section={section} index={index} label={section.heading}>
          <ul className={styles.chips}>{section.statements.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </SectionFrame>
      );
    case "SERVICES_OVERVIEW":
    case "PRODUCTS_SHOWCASE":
    case "FEATURED_OFFERINGS":
      return (
        <SectionFrame section={section} index={index} label={section.heading}>
          {section.intro && <p className={styles.text}>{section.intro}</p>}
          <ul className={styles.cards} data-kind={section.type}>{section.offerings.map((o) => <OfferingCard key={o.ref} o={o} loadImage={loadImage} />)}</ul>
        </SectionFrame>
      );
    case "TRUST_PROOF":
      return (
        <SectionFrame section={section} index={index} label={section.heading}>
          {section.intro && <p className={styles.text}>{section.intro}</p>}
          {/* Canonical wording only, as approved; no "verified" badge — Dubiz verifies nothing here. */}
          <ul className={styles.trustList}>
            {section.claims.map((c) => (
              <li key={c.ref} className={styles.trustItem} data-trust-ref={c.ref} data-provided-by-business={c.providedByBusiness ? "true" : "false"}>
                <span className={styles.trustMark} aria-hidden="true" />
                <span>{c.wording}</span>
              </li>
            ))}
          </ul>
        </SectionFrame>
      );
    case "QUOTE_PROCESS":
    case "BOOKING_INFO":
      return (
        <SectionFrame section={section} index={index} label={section.heading}>
          <ol className={styles.steps}>{section.steps.map((t, i) => <li key={i}><span className={styles.stepNo}>{i + 1}</span><span>{t}</span></li>)}</ol>
        </SectionFrame>
      );
    case "LOCATION_AND_HOURS":
      return (
        <SectionFrame section={section} index={index} label={section.heading}>
          <dl className={styles.facts}>
            {section.facts.map((f) => (
              <div key={f.key}><dt>{f.label}</dt><dd>{f.value}</dd></div>
            ))}
          </dl>
        </SectionFrame>
      );
    default: {
      // Exhaustive: a section type outside the closed set never renders.
      const never: never = section;
      void never;
      return <div className={styles.refused} role="alert" data-renderer-refused="UNKNOWN_SECTION_TYPE">UNKNOWN_SECTION_TYPE</div>;
    }
  }
}
