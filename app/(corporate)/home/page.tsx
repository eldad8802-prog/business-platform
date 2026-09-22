import type { CSSProperties, ReactNode } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import { PrimaryCta } from "@/components/ui/primary-cta";
import { BlobShape, DotLink, Edge, Receipt, Stamp } from "@/components/corporate/home/art";
import {
  isPublicSignupEnabled,
  SIGNUP_DISABLED_MESSAGE_HE,
  SIGNUP_DISABLED_TITLE_HE,
} from "@/lib/auth/signup-gate";
import s from "./home.module.css";

/**
 * Dubiz Homepage v4 — THE public homepage, at the canonical `/home`.
 *
 * Cut over from `/home-candidate` on 2026-09-23 after owner approval and a
 * proven Production run. `/` on the apex host is rewritten to this route
 * (next.config.ts), `/home-candidate` and `/corporate-home` are 308s to it,
 * and the v1 page it replaced sits beside this file as `page.v1-legacy.tsx`
 * (not a route) until the cutover is proven, then it goes.
 *
 * v4 changes the STORY, not the design (2026-09-22): the problem is that the
 * owner is the one holding the business together, the promise is "what needs
 * you today", the first proof is the money, and the principle is that the
 * owner decides. Section 02 is therefore the attention surface, moved up from
 * sixth place; the rest of the order follows the approved sequence. The
 * breadth map answers "why is it useful that this lives together", with two
 * real proofs (inventory, a commitment) and everything else drawn or set.
 *
 * TEMPORARY PRODUCT PROOF: every /landing/v3 asset is a real screen, but the
 * logged-in app is being redesigned, so these are placeholders in fixed slots
 * — swap the file, keep the composition (docs/dubiz-homepage-copy-v4.md §4).
 *
 * Art direction: "D-derived" — ink line, ticket + perforation, document
 * stickers, a stamp only where something was stamped, typography as object,
 * and a small compositional colour family on paper (see marketing-tokens).
 * Ten sections, in this order; Tier A proof moments (collection, documents,
 * invoices, leads), Tier B presence (the secretary, inventory, the accountant),
 * Tier C breadth on one map. No tabs, no carousel: everything is on the page.
 *
 * Every visible string comes from `docs/dubiz-homepage-copy-v3.md`, which was
 * written and gated BEFORE this file. Every product image is a real Dubiz
 * screen or component captured by `scripts/qa/ui/homepage-proof-capture.mjs`
 * (real app, synthetic data, no database) — complete, never cropped.
 *
 * Layout: ≥1024 each section is a stage with the mockup's aspect ratio and
 * objects placed in `cqw`; below that, the same DOM flows in reading order
 * (see home.module.css). Not linked from anywhere yet; `/home` is unchanged.
 */

// The CTA contract is read from the server environment on every request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // `absolute` so the brand leads the title instead of the layout's "%s · Dubiz"
  // template appending a second "· Dubiz". Homepage only.
  title: { absolute: "Dubiz — העסק שלך, מסודר." },
  description:
    "אתה מנהל ב-Dubiz את הגבייה, המסמכים, הלקוחות, הפניות והמלאי — ומה שנשאר פתוח מחכה לך ברשימה אחת של מה דורש אותך היום. תוכנה רשומה ברשות המסים, תעודת רישום 270901.",
  // The apex rewrites `/` to this route, so the same page answers on two URLs.
  // The apex root is the one we want indexed; this points both at it.
  alternates: { canonical: "https://promaxgroup.co.il/" },
};

/* ── placement helpers: mockup pixels (1440 wide) → cqw of the stage ─────── */
const cq = (px: number) => `${(px / 14.4).toFixed(3)}cqw`;
type Place = { x?: number; right?: number; y: number; w: number; r?: number; z?: number; mw?: number };
function at(p: Place): CSSProperties {
  return {
    ...(p.x !== undefined ? { "--x": cq(p.x) } : {}),
    ...(p.right !== undefined ? { "--xr": cq(p.right) } : {}),
    "--y": cq(p.y),
    "--w": cq(p.w),
    "--r": `${p.r ?? 0}deg`,
    "--z": p.z ?? 1,
    ...(p.mw ? { "--mw": `${p.mw}px` } : {}),
  } as CSSProperties;
}
type BlobPlace = {
  x?: number;
  right?: number;
  y: number;
  w: number;
  h: number;
  m?: { x?: string; right?: string; y: string; w: string; h: string };
};
function blobAt(p: BlobPlace): CSSProperties {
  return {
    ...(p.x !== undefined ? { "--bx": cq(p.x) } : {}),
    ...(p.right !== undefined ? { "--bxr": cq(p.right) } : {}),
    "--by": cq(p.y),
    "--bw": cq(p.w),
    "--bh": cq(p.h),
    ...(p.m
      ? {
          "--mdisp": "block",
          ...(p.m.x ? { "--mbx": p.m.x } : {}),
          ...(p.m.right ? { "--mbxr": p.m.right } : {}),
          "--mby": p.m.y,
          "--mbw": p.m.w,
          "--mbh": p.m.h,
        }
      : {}),
  } as CSSProperties;
}
const stage = (h: number) => ({ "--h": h }) as CSSProperties;
const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/* ── real product assets (public/landing/v3, true pixel sizes) ────────────── */
type Asset = { src: string; w: number; h: number };
const A = {
  today: { src: "/landing/v3/today-numbers.webp", w: 1050, h: 582 },
  collectionDesk: { src: "/landing/v3/collection-desktop.webp", w: 2880, h: 1800 },
  collectionPhone: { src: "/landing/v3/collection-phone.webp", w: 1170, h: 2532 },
  invoice: { src: "/landing/v3/invoice-page.webp", w: 1170, h: 2817 },
  leadsDesk: { src: "/landing/v3/leads-desktop.webp", w: 2880, h: 1800 },
  leadsPhone: { src: "/landing/v3/leads-phone.webp", w: 1170, h: 2532 },
  attention: { src: "/landing/v3/attention-phone.webp", w: 1170, h: 2532 },
  invValue: { src: "/landing/v3/inventory-value.webp", w: 1050, h: 390 },
  invHealth: { src: "/landing/v3/inventory-health.webp", w: 1050, h: 483 },
  payables: { src: "/landing/v3/payables-card.webp", w: 1074, h: 570 },
  doc: (n: number): Asset => ({ src: `/landing/v3/doc-${n}.webp`, w: 1074, h: 303 }),
} satisfies Record<string, Asset | ((n: number) => Asset)>;

function Shot({ a, alt, className }: { a: Asset; alt: string; className?: string }) {
  // Already-optimised WebP at ≥2× the rendered size; served as-is so the small
  // UI text inside is not re-encoded soft.
  return <Image src={a.src} alt={alt} width={a.w} height={a.h} unoptimized className={cx(s.img, className)} />;
}

function Tag({ children, onTeal = false }: { children: ReactNode; onTeal?: boolean }) {
  return (
    <span className={cx(s.tag, onTeal && s.tagOnTeal)}>
      <i aria-hidden />
      {children}
    </span>
  );
}

const FAQ = [
  {
    q: "כבר יש לי תוכנת חשבוניות.",
    a: "אפשר להתחיל ב-Dubiz מהדברים האחרים שהעסק מנהל — גבייה, מסמכים, לקוחות, לידים, מלאי וספקים — ולהחליט בהמשך במה להשתמש.",
  },
  {
    q: "Dubiz רודפת אחרי הלקוחות במקומי?",
    a: "לא. היא מראה לך מה עוד פתוח ומכינה את ההודעה ללקוח — ואתה שולח אותה מתי שנוח לך.",
  },
  {
    q: "איך זה עובד מול רואה החשבון?",
    a: "רואה החשבון נשאר שלך. מורידים חבילה מסודרת של החודש — דוח מסכם והמסמכים שאישרת — ומעבירים לו אותה.",
  },
  {
    q: "צריך ספק סליקה כדי לשלוח קישור לתשלום?",
    a: "כן. מחברים את חשבון הסליקה של העסק (כרגע CardCom), והקישור נשלח ללקוח מתי שתבחר.",
  },
  {
    q: "Dubiz עושה דברים לבד?",
    a: "לא. היא מסדרת, מזהה ומכינה טיוטות — ושום דבר לא נשלח ולא מאושר בלי שאתה מחליט.",
  },
  {
    q: "זה עובד עם צוות או עובדים?",
    a: "כרגע Dubiz בנויה לבעל העסק שמנהל את היום־יום בעצמו. גישה לעובדים עם הרשאות עדיין לא קיימת.",
  },
  {
    q: "אני חייב להעביר הכול בבת אחת?",
    a: "לא. מתחילים ממה שנוח — לצלם כמה קבלות או להפיק חשבונית — ומוסיפים בקצב שלך.",
  },
];

const DOCS: Array<{ n: number; p: Place; alt: string }> = [
  { n: 2, p: { right: 250, y: 130, w: 430, r: -4, z: 1 }, alt: "מסמך שנקלט — מוסך הדר, 1,320 ₪, 17.09.2026, שירותים" },
  { n: 3, p: { right: 140, y: 290, w: 430, r: 3, z: 2 }, alt: "מסמך שנקלט — מחסני עץ יוסף, 2,680 ₪, 14.09.2026, חומרים" },
  { n: 4, p: { right: 300, y: 450, w: 430, r: -1.5, z: 3 }, alt: "מסמך שנקלט — דפוס קרני, 540 ₪, 18.09.2026, שירותים" },
  { n: 5, p: { right: 170, y: 610, w: 430, r: 5, z: 4 }, alt: "מסמך שנקלט — תחנת דלק הצפון, 286 ₪, 19.09.2026, דלק" },
];

export default function HomeV3Page() {
  // Single source of truth for the CTA — the same gate /register uses. While
  // registration is closed the page never links to /register.
  const signupOpen = isPublicSignupEnabled();
  const cta = signupOpen
    ? { href: "/register", label: "מתחילים עם Dubiz" }
    : { href: "/login", label: "כניסה למשתמשים קיימים" };

  return (
    <div className={s.page} dir="rtl">
      {/* ═══ 01 · HERO — paper · sky mass · sage entering from the corner ═══ */}
      <section className={cx(s.sec, s.paper)} data-section="01-hero" aria-labelledby="h-hero">
        <div className={s.stage} style={stage(830)}>
          <div aria-hidden className={s.blob} style={blobAt({ x: -60, y: 80, w: 760, h: 700, m: { x: "-12%", y: "46%", w: "110%", h: "46%" } })}>
            <BlobShape variant="a" fill="var(--mkt3-sky)" />
          </div>
          <div aria-hidden className={s.blob} style={blobAt({ x: 1130, y: 600, w: 420, h: 330 })}>
            <BlobShape variant="b" fill="var(--mkt3-sage2)" />
          </div>

          <div className={cx(s.txt, s.o)} style={at({ right: 72, y: 80, w: 520, z: 6 })}>
            <Tag>לבעל עסק שמנהל את היום־יום בעצמו</Tag>
            <h1 id="h-hero" className={s.h1}>
              העסק שלך,
              <br />
              <span className={cx(s.lbl, s.lblOchre)}>מסודר.</span>
            </h1>
            <p className={cx(s.lede, s.ledeLead)}>יותר מהעסק מול העיניים. פחות דברים שאתה מחזיק בראש.</p>
            <p className={s.lede} style={{ maxWidth: "32em" }}>
              אתה מנהל ב-Dubiz את הגבייה, המסמכים, הלקוחות, הפניות והמלאי — ומה
              שנשאר פתוח מחכה לך ברשימה אחת.
            </p>
            <PrimaryCta href={cta.href} className={s.cta}>
              {cta.label}
            </PrimaryCta>
            <p className={s.micro}>
              אתה מחליט על כל צעד · תוכנה רשומה ברשות המסים · תעודת רישום 270901
            </p>
          </div>

          <div aria-hidden className={cx(s.o, s.dOnly)} style={at({ x: 70, y: 166, w: 210, r: 8, z: 2 })}>
            <Receipt />
          </div>

          {/* the ticket: a stub, a perforation, and the real "today in numbers" */}
          <div
            className={cx(s.o, s.ticket)}
            style={{ ...at({ x: 200, y: 170, w: 540, r: -3, z: 3, mw: 520 }), "--ny": "64px", "--notch-bg": "var(--mkt3-sky)" } as CSSProperties}
          >
            <span className={cx(s.notch, s.notchL)} aria-hidden />
            <span className={cx(s.notch, s.notchR)} aria-hidden />
            <div className={s.stub}>
              <b>היום</b>
            </div>
            <div className={s.perf} aria-hidden />
            <Shot
              a={A.today}
              alt="היום במספרים ב-Dubiz — 9 גביות שנגבו ואומתו החודש, 3 ממתינות לגבייה, 7 מסמכים לבדיקה ותשלום אחד למועד"
              className={s.ticketImg}
            />
          </div>

          <div className={cx(s.o, s.stk, s.lift)} style={at({ x: 400, y: 560, w: 390, r: 4, z: 5, mw: 380 })}>
            <Shot a={A.doc(1)} alt="מסמך שנקלט ב-Dubiz — חומרי בניין הגליל, 412 ₪, 20.09.2026, ספק, סכום ותאריך מזוהים, ממתין לאישור" />
          </div>
        </div>
      </section>

      {/* ═══ 02 · WHAT NEEDS YOU TODAY — the positioning's main proof ═══════
          Several domains (a message, a document, a lead, stock) arrive in one
          ranked list. The obligations the owner types in live on the secretary,
          a separate morning surface — said in words, never merged into the list. */}
      <section className={cx(s.sec, s.sage)} data-section="02-attention" aria-labelledby="h-attention">
        <Edge variant="a" fill="var(--mkt3-sage)" className={s.edge} />
        <div className={s.stage} style={stage(900)}>
          <div className={cx(s.txt, s.o)} style={at({ right: 96, y: 110, w: 500, z: 6 })}>
            <Tag>הבוקר שלך</Tag>
            <h2 id="h-attention" className={cx(s.h2, s.h2Big)}>
              מה דורש
              <br />
              אותך היום
            </h2>
            <p className={s.lede}>
              פנייה שמחכה לתשובה, מסמך שממתין לאישור, ליד שהגיע הזמן לחזור אליו,
              מלאי שיורד — ברשימה אחת, לפי מה שדחוף קודם.
            </p>
            <p className={cx(s.lede, s.note)} style={{ marginTop: "18px" }}>
              התשלומים הקבועים שרשמת מופיעים במזכירה, במסך נפרד.
            </p>
          </div>
          <div className={cx(s.o, s.fit, s.doms)} style={at({ x: 150, y: 96, w: 420, r: -2, z: 4 })}>
            <span>פנייה</span>
            <span>מסמך</span>
            <span>ליד</span>
            <span>מלאי</span>
          </div>
          <div className={cx(s.o, s.win, s.offOchre)} style={at({ x: 300, y: 180, w: 330, r: 2, z: 2, mw: 340 })}>
            <Shot
              a={A.attention}
              alt="דורש תשומת לב ב-Dubiz — מעקב ליד שעבר את הזמן, 7 מסמכים ממתינים לבדיקה, מלאי נמוך והזמנה מספק שממתינה לקליטה"
            />
          </div>
          <div aria-hidden className={cx(s.o, s.dOnly)} style={at({ x: 700, y: 560, w: 300 })}>
            <DotLink viewBox="0 0 300 80" d="M0 20 C 90 90, 200 0, 300 60" />
          </div>
        </div>
      </section>

      {/* ═══ 03 · COLLECTION — Tier A · paper · ochre offset ═══ */}
      <section className={cx(s.sec, s.paper)} data-section="03-collection" aria-labelledby="h-collection">
        <div className={s.stage} style={stage(980)}>
          <div className={cx(s.txt, s.o)} style={at({ right: 90, y: 90, w: 380, z: 6 })}>
            <Tag>גבייה</Tag>
            <h2 id="h-collection" className={s.h2}>
              מי שילם,
              <br />
              ומה עוד פתוח
            </h2>
            <p className={s.lede}>
              כל חשבונית שהוצאת נשארת מול העיניים עד שהיא משולמת. שולחים ללקוח
              קישור לתשלום בכרטיס — וכשהוא משלם, הקבלה מופקת ונרשמת מול החשבונית.
            </p>
          </div>
          <div className={cx(s.o, s.win, s.offOchre)} style={at({ x: 64, y: 150, w: 840, z: 2, mw: 390 })}>
            <Shot
              a={A.collectionDesk}
              className={s.dOnly}
              alt="מרכז הגבייה של Dubiz במחשב — רשימת הגביות עם הסכומים, קבוצת דורש טיפול, ופרטי הגבייה הנבחרת"
            />
            <Shot
              a={A.collectionPhone}
              className={s.mOnly}
              alt="מרכז הגבייה של Dubiz בטלפון — חמש גביות פתוחות, סכומים, קבל תשלום ושתי גביות שדורשות טיפול"
            />
          </div>
          <div aria-hidden className={cx(s.o, s.dOnly)} style={at({ x: 980, y: 640, w: 460 })}>
            <DotLink viewBox="0 0 460 300" d="M0 40 C 120 40, 180 220, 460 250" />
          </div>
        </div>
      </section>

      {/* ═══ 03 · DOCUMENTS — Tier A · paper · a sky field entering from the right ═══ */}
      <section className={cx(s.sec, s.paper)} data-section="04-documents" aria-labelledby="h-documents">
        <div className={s.stage} style={stage(840)}>
          <div
            aria-hidden
            className={s.blob}
            style={blobAt({ right: -120, y: -40, w: 900, h: 900, m: { right: "-20%", y: "38%", w: "120%", h: "62%" } })}
          >
            <BlobShape variant="c" fill="var(--mkt3-sky)" />
          </div>
          <div className={cx(s.txt, s.o)} style={at({ x: 110, y: 170, w: 440, z: 6 })}>
            <Tag>מסמכים</Tag>
            <h2 id="h-documents" className={s.h2}>
              קבלה שצילמת
              <br />
              לא נשארת בגלריה
            </h2>
            <p className={s.lede}>
              מעלים את המסמך, ו-Dubiz מזהה ספק, סכום ותאריך. מה שצריך את האישור
              שלך מחכה בתור אחד.
            </p>
          </div>
          {DOCS.map((d) => (
            <div key={d.n} className={cx(s.o, s.stk)} style={at({ ...d.p, mw: 400 })}>
              <Shot a={A.doc(d.n)} alt={d.alt} />
            </div>
          ))}
        </div>
      </section>

      {/* ═══ 04 · INVOICES — Tier A · an ochre field · the real issued invoice + its stamp ═══ */}
      <section className={cx(s.sec, s.paper)} data-section="05-invoices" aria-labelledby="h-invoices">
        <div className={s.stage} style={stage(990)}>
          <div
            className={s.field}
            style={{ "--fxr": cq(120), "--fy": cq(60), "--fw": cq(600), "--fh": cq(880), "--mby": "34%" } as CSSProperties}
            aria-hidden
          />
          <div className={cx(s.txt, s.o)} style={at({ x: 110, y: 220, w: 480, z: 6 })}>
            <Tag>חשבוניות</Tag>
            <h2 id="h-invoices" className={s.h2}>
              חשבונית מס והצעת
              <br />
              מחיר, כמו שצריך
            </h2>
            <p className={s.lede}>
              מספור רציף, והצעת מחיר שהופכת לחשבונית בלחיצה. חשבונית שהופקה לא
              משתנה, ובמסך שלה רואים את היתרה הפתוחה.
            </p>
            <p className={cx(s.lede, s.trust)}>
              <b>Dubiz היא תוכנה רשומה ברשות המסים — תעודת רישום מס׳ 270901.</b>
            </p>
          </div>
          <div className={s.o} style={at({ right: 300, y: 110, w: 320, r: 2, z: 2, mw: 340 })}>
            <div className={cx(s.stk, s.stkPage)}>
              <Shot
                a={A.invoice}
                alt="חשבונית מס שהופקה ב-Dubiz — מספר 001042, תאריך הפקה, יתרה פתוחה של 4,590.20 ₪ ופעולת שליחה לתשלום, ובדיקה קצרה של הלקוח, הפריטים והסכום"
              />
            </div>
            <div className={s.stamp} aria-hidden>
              <Stamp word="הופק" sub="001042" />
            </div>
          </div>
        </div>
      </section>

      {/* ═══ 05 · LEADS — Tier A · the one deep teal band ═══ */}
      <section className={cx(s.sec, s.teal)} data-section="06-leads" aria-labelledby="h-leads">
        <Edge variant="b" fill="var(--mkt3-teal)" className={s.edge} />
        <div className={s.stage} style={stage(1020)}>
          <div className={cx(s.txt, s.o)} style={at({ right: 96, y: 70, w: 540, z: 6 })}>
            <Tag onTeal>לידים</Tag>
            <h2 id="h-leads" className={s.h2}>
              למי לחזור היום
            </h2>
            <p className={cx(s.lede, s.ledeOnTeal)}>
              פנייה שנכנסה, לקוח שביקש הצעה, מישהו שהבטחת לחזור אליו. קובעים מתי
              — וביום הזה הוא מופיע ברשימה. טיפלת? מסמנים בלחיצה.
            </p>
          </div>
          <div className={cx(s.o, s.fit)} style={at({ x: 1110, y: 250, w: 230, r: 4, z: 3 })}>
            <span className={cx(s.lbl, s.lblCoral, s.chipLabel)}>מעקב להיום</span>
          </div>
          <div className={cx(s.o, s.win, s.offTeal)} style={at({ x: 170, y: 290, w: 1100, z: 2, mw: 390 })}>
            <Shot
              a={A.leadsDesk}
              className={s.dOnly}
              alt="רשימת הלידים של Dubiz במחשב — תור עבודה לפי מעקב, וכרטיס הליד הנבחר עם מועד המעקב, הפעולות, הסטטוס וההערות"
            />
            <Shot
              a={A.leadsPhone}
              className={s.mOnly}
              alt="רשימת הלידים של Dubiz בטלפון — פניות לפי מעקב שעבר, מעקב להיום וליד חדש, עם טופל ודחייה בכל שורה"
            />
          </div>
        </div>
      </section>

      {/* ═══ 07 · THE REST OF THE BUSINESS — breadth map · sage field ═══ */}
      <section className={cx(s.sec, s.sage)} data-section="07-map" aria-labelledby="h-map">
        <Edge variant="c" fill="var(--mkt3-sage)" className={s.edge} />
        <div className={s.stage} style={stage(1260)}>
          <div className={cx(s.txt, s.o)} style={at({ right: 100, y: 70, w: 660, z: 6 })}>
            <h2 id="h-map" className={cx(s.h2, s.h2Big)}>
              ובאותו מקום —
              <br />
              שאר העסק
            </h2>
            <p className={s.lede}>
              פחות מערכות לנהל. כל חלק שמתנהל כאן הוא עוד דבר שאתה לא צריך לזכור
              לבד.
            </p>
          </div>

          <div className={cx(s.o, s.ptag)} style={at({ right: 90, y: 300, w: 520, r: -1.5, mw: 460 })}>
            <h3>מלאי</h3>
            <p>מה יש, מה עומד להיגמר, ומה להזמין מהספק.</p>
            <div className={s.ptagImgs}>
              <Shot a={A.invValue} alt="שווי המלאי ב-Dubiz — 7,528 ₪, 6 מוצרים פעילים" />
              <Shot a={A.invHealth} alt="בריאות המלאי ב-Dubiz — 4 פריטים תקינים ו-2 קריטיים" />
            </div>
          </div>
          <div className={cx(s.o, s.ptag)} style={at({ right: 660, y: 270, w: 320, r: 3, mw: 420 })}>
            <h3>לקוחות</h3>
            <p>כרטיס אחד לכל לקוח: החשבוניות, התשלומים, השיחות וההערות.</p>
          </div>
          <div className={cx(s.o, s.ptag, s.ptagSoft)} style={at({ right: 650, y: 580, w: 310, r: -2.5, mw: 420 })}>
            <h3>ספקים והזמנות</h3>
            <p>הספקים, ההזמנה לספק וקליטת הסחורה.</p>
          </div>
          <div className={cx(s.o, s.ptk)} style={at({ x: 80, y: 270, w: 360, r: -3, mw: 420 })}>
            <h3>התחייבויות</h3>
            <p>כל התחייבות עם לוח התשלומים שלה — שולם, נותר ומועד הבא.</p>
            <div className={s.ptkImg}>
              <Shot
                a={A.payables}
                alt="התחייבות ב-Dubiz — מכונת CNC בפריסת 12 תשלומים, 6,000 ₪ שולמו, 12,000 ₪ נותרו, והתשלום הבא ב-25.09.2026"
              />
            </div>
          </div>
          <div className={cx(s.o, s.folder)} style={at({ x: 70, y: 600, w: 370, r: 2, mw: 420 })}>
            <h3>רואה החשבון</h3>
            <p>חבילה מסודרת של החודש — דוח מסכם והמסמכים — להורדה ולהעברה לרואה החשבון.</p>
            <div className={s.files}>
              <span>דוח מסכם</span>
              <span>מסמכים מאושרים</span>
              <span>ממתינים</span>
            </div>
          </div>
          <div className={cx(s.o, s.ptag, s.ptagSky)} style={at({ right: 290, y: 930, w: 330, r: 2, mw: 420 })}>
            <h3>שיחות</h3>
            <p>הפניות מ-WhatsApp העסקי בתיבה אחת, ורואים מי מחכה לתשובה.</p>
          </div>
          <div aria-hidden className={cx(s.o, s.dOnly)} style={at({ x: 752, y: 985, w: 96 })}>
            <DotLink viewBox="0 0 300 80" d="M0 40 C 90 0, 200 80, 300 40" />
          </div>
          <div className={cx(s.o, s.ptag)} style={at({ x: 410, y: 945, w: 340, r: -2, mw: 420 })}>
            <h3>הבוט</h3>
            <p>מכין טיוטת תשובה לפי מה שהגדרת — אתה מחליט אם לשלוח.</p>
          </div>
          <p className={cx(s.o, s.note)} style={at({ x: 410, y: 1165, w: 420 })}>
            שיחות והבוט — בחיבור WhatsApp העסקי.
          </p>
        </div>
      </section>

      {/* ═══ 08 · CONTROL — quiet paper · typography object ═══ */}
      <section className={cx(s.sec, s.paper)} data-section="08-control" aria-labelledby="h-control">
        <div className={s.stage} style={stage(440)}>
          <div aria-hidden className={s.blob} style={blobAt({ x: -60, y: 140, w: 360, h: 360 })}>
            <BlobShape variant="a" fill="var(--mkt3-sage)" />
          </div>
          <div className={cx(s.txt, s.o)} style={at({ right: 110, y: 120, w: 640, z: 6 })}>
            <h2 id="h-control" className={cx(s.h2, s.h2Huge)}>
              שום דבר
              <br />
              לא יוצא <span className={cx(s.lbl, s.lblWhite)}>בלעדיך.</span>
            </h2>
            <p className={s.lede}>Dubiz מסדרת, מזהה ומציעה. אתה מחליט.</p>
          </div>
          <div className={cx(s.o, s.rules)} style={at({ x: 110, y: 150, w: 520, z: 2 })}>
            <p>
              <b>אתה בוחר מה מתחבר</b> <span>— ואפשר לנתק בכל רגע</span>
            </p>
            <p>
              <b>כלום לא נשלח בשמך</b> <span>— לא ללקוח, לא לספק, לא לרשות</span>
            </p>
            <p>
              <b>המידע שלך נשאר שלך</b> <span>— עם ייצוא מסודר בכל רגע</span>
            </p>
          </div>
        </div>
      </section>

      {/* ═══ 09 · FAQ — plain details on a dotted rule ═══ */}
      <section className={cx(s.sec, s.paper)} data-section="09-faq" aria-labelledby="h-faq">
        <div className={cx(s.stage, s.stageFlow)}>
          <div className={s.faq}>
            <h2 id="h-faq" className={s.h2}>
              שאלות שאולי עולות לך
            </h2>
            <div className={s.faqList}>
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>
                    <span className={s.plus} aria-hidden>
                      +
                    </span>
                    {f.q}
                  </summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══ 10 · FINAL CTA — ochre · the ticket's perforated edge ═══ */}
      <section className={cx(s.sec, s.ochre)} data-section="10-final" aria-labelledby="h-final">
        <div className={s.perfEdge} aria-hidden />
        <div className={s.stage} style={stage(600)}>
          <div className={cx(s.txt, s.o)} style={at({ right: 110, y: 130, w: 760, z: 6 })}>
            <h2 id="h-final" className={cx(s.h2, s.h2Final)}>
              {signupOpen ? (
                <>
                  מתחילים לעבוד
                  <br />
                  מסודר.
                </>
              ) : (
                SIGNUP_DISABLED_TITLE_HE
              )}
            </h2>
            {signupOpen ? null : <p className={cx(s.lede, s.ledeOnOchre)}>{SIGNUP_DISABLED_MESSAGE_HE}</p>}
            <PrimaryCta href={cta.href} className={s.cta}>
              {cta.label}
            </PrimaryCta>
          </div>
          <div aria-hidden className={cx(s.o, s.dOnly)} style={at({ x: 170, y: 90, w: 230, r: -8 })}>
            <Receipt check />
          </div>
        </div>
      </section>
    </div>
  );
}
