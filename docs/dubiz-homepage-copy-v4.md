# Dubiz Homepage — copy record v4 (binding)

**Status:** approved story. LIVE as the public homepage at the canonical `/home` since the 2026-09-23 cutover (the apex `/` is rewritten to it; `/home-candidate` and `/corporate-home` are 308s to it). Supersedes
`docs/dubiz-homepage-copy-v3.md`. Written before the code; the page may contain
no string that is not here.

**Product truth base:** the deep product audit of `origin/main` @ `3161fb47`
(2026-09-22) and the positioning synthesis that followed it.

## §0 · The story

| layer | what it says |
|---|---|
| problem | the owner is the one holding the business together and remembering everything |
| promise | Dubiz shows what is still open and what needs him today |
| first proof | the money: an invoice stays visible until it is paid, a card payment settles against it |
| principle | Dubiz sorts, identifies and proposes — the owner decides |

Deliberately NOT our language (occupied by Morning, iCount, SUMIT, EasyCount,
H-ERP, checked live 2026-09-22): "ניהול העסק", "כל מה שהעסק צריך", "הכול במקום
אחד", "חיסכון בזמן", "אוטומטי", "קל", customer counts, and — because it is not
ours to say — "מאושרת/מוכרת ברשות המסים". These are enforced by the QA gate.

## §1 · Sections, in order

1. `01-hero` · 2. `02-attention` · 3. `03-collection` · 4. `04-documents` ·
5. `05-invoices` · 6. `06-leads` · 7. `07-map` · 8. `08-control` · 9. `09-faq` ·
10. `10-final`

The attention surface moved from sixth place to second: it is the main proof of
the positioning, so it stands directly under the promise.

## §2 · The strings

**01 hero** — tag "לבעל עסק שמנהל את היום־יום בעצמו" · H1 "העסק שלך, מסודר." ·
lead "יותר מהעסק מול העיניים. פחות דברים שאתה מחזיק בראש." · support "אתה מנהל
ב-Dubiz את הגבייה, המסמכים, הלקוחות, הפניות והמלאי — ומה שנשאר פתוח מחכה לך
ברשימה אחת." · CTA per the signup gate · trust line "אתה מחליט על כל צעד · תוכנה
רשומה ברשות המסים · תעודת רישום 270901".

**02 attention** — tag "הבוקר שלך" · H2 "מה דורש אותך היום" · lede "פנייה שמחכה
לתשובה, מסמך שממתין לאישור, ליד שהגיע הזמן לחזור אליו, מלאי שיורד — ברשימה אחת,
לפי מה שדחוף קודם." · chips פנייה · מסמך · ליד · מלאי · note "התשלומים הקבועים
שרשמת מופיעים במזכירה, במסך נפרד."

*Truth:* `business-status` ranks conversations, reply drafts, documents,
inventory alerts, billing review, supplier drafts and leads. It does NOT include
obligations, payables or overdue collection — hence the note, and hence only
four domains are named.

**03 collection** — tag "גבייה" · H2 "מי שילם, ומה עוד פתוח" · lede "כל חשבונית
שהוצאת נשארת מול העיניים עד שהיא משולמת. שולחים ללקוח קישור לתשלום בכרטיס —
וכשהוא משלם, הקבלה מופקת ונרשמת מול החשבונית."

*Truth:* settlement is automatic for a verified CardCom payment only. No
reminder is ever sent; the owner shares the message himself. "בכרטיס" is
load-bearing and may not be dropped.

**04 documents** — tag "מסמכים" · H2 "קבלה שצילמת לא נשארת בגלריה" · lede
"מעלים את המסמך, ו-Dubiz מזהה ספק, סכום ותאריך. מה שצריך את האישור שלך מחכה
בתור אחד." *Truth:* rule-based extraction, owner approves every document. Gmail
and WhatsApp intake exist but are not promised here.

**05 invoices** — tag "חשבוניות" · H2 "חשבונית מס והצעת מחיר, כמו שצריך" · lede
"מספור רציף, והצעת מחיר שהופכת לחשבונית בלחיצה. חשבונית שהופקה לא משתנה, ובמסך
שלה רואים את היתרה הפתוחה." · trust "Dubiz היא תוכנה רשומה ברשות המסים — תעודת
רישום מס׳ 270901." *Truth:* TAX_INVOICE and QUOTE only; allocation numbers are
never claimed.

**06 leads** — tag "לידים" · H2 "למי לחזור היום" · lede "פנייה שנכנסה, לקוח
שביקש הצעה, מישהו שהבטחת לחזור אליו. קובעים מתי — וביום הזה הוא מופיע ברשימה.
טיפלת? מסמנים בלחיצה." · label "מעקב להיום". *Truth:* the owner sets the
follow-up; there is no automatic capture and no lead → quote → invoice chain.

**07 map** — H2 "ובאותו מקום — שאר העסק" · lede "פחות מערכות לנהל. כל חלק
שמתנהל כאן הוא עוד דבר שאתה לא צריך לזכור לבד." · objects: מלאי · לקוחות ·
ספקים והזמנות · התחייבויות · רואה החשבון · שיחות · הבוט · note "שיחות והבוט —
בחיבור WhatsApp העסקי."

**08 control** — H2 "שום דבר לא יוצא בלעדיך." · lede "Dubiz מסדרת, מזהה ומציעה.
אתה מחליט." · three rules, unchanged from v3.

**09 FAQ** — seven questions: existing invoice software · chasing customers ·
the accountant · the payment provider · does Dubiz act by itself · team access ·
migrating everything at once.

**10 final** — signup-aware, unchanged from v3.

## §3 · Claims that stay out

AI · "הכול מחובר" · "מבינה את העסק" · reminders of any kind · automatic sending ·
automatic chasing · payment methods other than card · outbound payments ·
supplier ordering by Dubiz · lead → invoice · customer balance · allocation
numbers · replacing the accountant · revenue or ROI.

## §4 · Product proof — TEMPORARY

Every image under `public/landing/v3/` is a real Dubiz screen or component
captured by `scripts/qa/ui/homepage-proof-capture.mjs`, with synthetic data and
no database. **The logged-in app is being redesigned, so these are placeholders
in fixed slots:** replace the file at the same path and size, keep the
composition. Current slots: hero ticket (today's numbers) · hero document ·
attention phone · collection desktop/phone · four document cards · the issued
invoice · leads desktop/phone · inventory value + health · the commitment card
(`payables-card.webp`, added in v4).

## §5 · Product follow-ups (recorded, not fixed here)

Attention excludes obligations, payables and overdue collection · the secretary
and attention are two morning surfaces and `/attention` is not in the nav ·
nothing is delivered outside the app · cash/transfer payments cannot be recorded
from the UI · the accountant pack's quarter and year filters · lead ↔ customer ↔
invoice are not linked · the unanswered-inbound counter may not reset.
