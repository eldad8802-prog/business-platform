# קופונים — Reality Check מול חזון ה-Marketplace הציבורי

> **מה זה:** בדיקה מול הקוד הקיים בלבד — האם Dubiz כבר מכילה בסיס לפלטפורמת-קופונים ציבורית, או שהיא רק כלי-פנימי ליצירה/הנפקה. **לא תכנון, לא פתרונות, לא UI, לא שינוי-קוד.**
> **כללים:** Evidence-First. אם אין ראיה — כתוב [U]. חלקי — סמן ⚠️. תיוג: **[O]** תצפית מהקוד · **[I]** הסקה · **[U]** לא-ידוע.
> **בסיס:** קריאת הסכימה (Prisma), כל ה-APIs, ה-services, ה-libs והמסכים (2026-07-06).

---

## שורה תחתונה (הכי חשוב)

[I, מבוסס-ראיות] **Dubiz כבר מכילה בסיס חלקי — אך משמעותי — לפלטפורמת-קופונים ציבורית.** קיימים כבר: **רשימת קופונים ציבורית חוצה-עסקים** (ללא אימות), **דף-קופון ציבורי** לפי מזהה, **QR**, **הנפקה** (issue), **מימוש** (redeem), **הפרדת תבנית↔מופע** (Offer↔Coupon), **טבלת מימושים** ו-**audit trail**. כלומר התשתית ל"כל קופון עולה אוטומטית למסך ציבורי ונפתח לכל אדם" **קיימת בגרעינה**.

**מה חסר לחזון המלא (לא קיים):** **מיקום/עיר כנתון אמיתי**, **סינון לפי תחום/עיר**, **דגלי פרסום/נראות/אישור** (published/visibility/approval), **מנגנון "קישור אחד → כמה הנפקות ייחודיות מוגבלות-כמות"**, **ברקוד**, **מיון לפי שווי-הטבה**, ו**הבחנת UI בין ציבורי לבעל-עסק**.

**המשמעות:** זה **לא רק כלי-פנימי** — יש כבר שלד-מרקטפלייס (למעשה, שכבת-הנתונים תוכננה חוצה-עסקים מלכתחילה). אבל הוא **לא שלם**, וכמה חלקים "ציבוריים" קיימים כתופעת-לוואי של הקוד ולא כפיצ'ר מגובש.

---

## 4. השמות האמיתיים בקוד (חשוב — הפיצ'ר לא נקרא "coupons" באופן אחיד)

[O] אין ישות בשם `voucher`/`benefit`/`template`/`issuedOffer`. השמות בפועל:

| מושג | השם בקוד |
|---|---|
| **תבנית** (מה שנוצר ביצירה) | **`Offer`** (מודל) · namespace `/offers`, `/api/offers` |
| **מופע מונפק** (token/QR) | **`Coupon`** (מודל) · namespace `/revenue`, `/api/revenue/coupons` |
| **מימוש** | **`RedemptionEvent`** (מודל) · `/revenue/redeem`, `/api/coupons/[token]/redeem` |
| **מעטפת** | **`/promotions`** ("מבצעים", שכבת-קופונים) |
| **בית** | **`/revenue`** ("Revenue Activation") + **`/promotions/coupons`** |
| שדה "הטבה" | `customerBenefitText` (שדה ב-Offer, לא ישות) |

[O] כלומר: **"קופון" ב-UI = לפעמים `Offer` (תבנית) ולפעמים `Coupon` (מופע).** ה"פיצ'ר" מפוזר על שלושה namespaces: `offers` / `revenue` / `promotions`.

---

## 1. מה קיים בפועל (עם קבצים)

**Routes / Pages** [O]
- `/revenue` ([app/revenue/page.tsx](app/revenue/page.tsx)) — **רשימה ציבורית חוצה-עסקים** (6 מדורגים) + חיפוש.
- `/revenue/coupons/[id]` ([app/revenue/coupons/[id]/page.tsx](app/revenue/coupons/[id]/page.tsx)) — **דף-קופון ציבורי** לפי `publicId`, חשיפת קוד + QR + שיתוף.
- `/revenue/issue` · `/revenue/redeem` — הנפקה · מימוש.
- `/offers/create` — פלואו יצירה (4 שלבים). · `/offers` — רשימת dev.
- `/promotions` · `/promotions/coupons` — מעטפת · רשימת קופונים-של-העסק.

**APIs** [O]
- **ציבוריים (ללא אימות):** `GET /api/revenue/coupons/active` (**חוצה-עסקים**, [lib/services/revenue/active-coupons.service.ts](lib/services/revenue/active-coupons.service.ts)) · `GET /api/revenue/coupons/[id]` · `GET /api/revenue/coupons/[id]/code`.
- **דורשי-אימות:** `GET/POST /api/offers` · `POST /api/offers/[id]/coupon` (הנפקה) · `POST /api/coupons/[token]/redeem` (מימוש) · `POST /api/offers/image`.

**Models** [O] — `Offer`, `Coupon`, `RedemptionEvent`, enum `CouponStatus{ACTIVE,REDEEMED,EXPIRED,CANCELLED}`.

**Services** [O] — `offer.service`, `coupon.service`, `redeem.service`, `revenue/active-coupons.service`(+`.rank`), `revenue/coupon-code.service`, `revenue/coupon-details-public.service`. תלות: `audit.service`, `storage/public-asset-storage.service`.

**QR** [O] — `qrcode.react` (`QRCodeCanvas`) ב-issue/detail/offers. **Audit** [O] — `logAuditEvent` על create/issue/redeem/reject.

**דירוג ("מובילים"/featured)** [O] — שני מנועים: `active-coupons.rank` (recency+expiry+text-richness) ו-`rankCoupons` ([lib/revenue/issue/issue.helpers.ts](lib/revenue/issue/issue.helpers.ts)).

**חיפוש** [O] — צד-לקוח בלבד (התאמת-טקסט על title/description/city) ב-/revenue ו-/promotions/coupons.

**שדות-עסק לתצוגה** [O] — `Business.name` ✅ · `BusinessProfile.category/subCategory/businessModel` ✅ (קיימים, **לא מוצגים באף רשימת-קופונים**) · `Offer.imageUrl` ✅ · `Offer.description` ✅.

## 2. מה קיים חלקית (⚠️)

- **מסך ציבורי ראשי** ⚠️ — `/revenue` שולף API ציבורי חוצה-עסקים ומציג 6 מדורגים, אבל: הוא **בתוך האפליקציה** ("Revenue Activation"), לא ממוצב כ"אתר קופונים ציבורי"; והרשימה מציגה רק **Coupons מונפקים** — Offer שלא הונפק לא יופיע.
- **פרסום אוטומטי** ⚠️ — כל Coupon `ACTIVE` ולא-פג **מופיע אוטומטית** בציבורי (אין שלב-פרסום), אבל אין דגל visibility/published שמבחין "להציג/לא להציג".
- **CTA "צור קופון"** ⚠️ — קיים ב-/revenue ו-/promotions/coupons → `/offers/create`, אבל **מוצג תמיד**, בלי הבחנת ציבורי-מול-בעל-עסק.
- **הרשאות/Guards** ⚠️ — קיימות **רק בשכבת-ה-API** (`getCurrentUser` על יצירה/הנפקה/מימוש); **אין guard ב-UI**, ו-/revenue עצמו נטען ללא token.
- **ייחודיות-מימוש** ⚠️ — כל Coupon חד-פעמי (מימוש נעול ב-`$transaction`, token/qrValue `@unique`), אבל זה **פר-קופון**, לא "קישור אחד שמנפיק N ברקודים ייחודיים".
- **דירוג לפי שווי** ⚠️ — דירוג קיים, אבל לפי עדכניות/פקיעה/עושר-טקסט — **לא לפי גובה-הטבה** (אין שדה סכום/אחוז).
- **מיקום** ⚠️/❌ — הקוד מפנה ל-`profile.city`/`profile.address`, אבל **אין שדה כזה בסכימה** (ראה §3) → בפועל **ריק תמיד**.

## 3. מה לא קיים בכלל (❌, מפורש)

- ❌ **שדה מיקום/עיר אמיתי** — ל-`BusinessProfile` אין `city`/`address` (רק `billingAddress` לחשבוניות); ל-`Business` אין. הקוד קורא `profile.city` → `undefined`.
- ❌ **סינון לפי עיר / לפי תחום-עסק** — אין filter כזה בשום route (category קיים בפרופיל אך לא מסונן).
- ❌ **ברקוד** — קיים רק ב-inventory ([components/inventory/barcode-scanner.tsx](components/inventory/barcode-scanner.tsx)); **אין ברקוד בקופונים** (רק QR).
- ❌ **דגלי פרסום/נראות** — אין `published`/`draft`/`visibility`/`isPublic`/`public/private` על Offer/Coupon.
- ❌ **Approval / moderation flow** — אין.
- ❌ **מנגנון "קישור → כמה הנפקות ייחודיות"** — אין link שמנפיק QR חדש בכל לחיצה.
- ❌ **ספירת-הנפקות / הגבלת-כמות** — אין שדה `issueCount`/`maxIssuances`/`usageLimit` על Offer/Coupon.
- ❌ **slug** — הזיהוי הוא `publicId`(uuid) ו-`token`; אין slug קריא.
- ❌ **מיון "ההטבות הכי משתלמות"** — אין נתון שווי-הטבה למיין לפיו.
- ❌ **תיאור/לוגו של העסק לתצוגה ציבורית** — אין `business.description`; לוגו קיים רק כ-`billingLogoDataUrl` (חשבוניות). התמונה היחידה היא `Offer.imageUrl`.
- ❌ **enum `OfferStatus`** מוגדר אך **אינו בשימוש** (Offer משתמש ב-`isActive` בוליאני).

## 5. הפלואו הקיים בפועל

[O] **נכנסים** מ-`/revenue` (ציבורי, חוצה-עסקים) או `/promotions/coupons` (של-העסק, דורש token) → **יוצרים** ב-`/offers/create` (סוג→ניסוח→תוקף→סיכום) → `POST /api/offers` יוצר **Offer** (הסוג לא נשמר) → **מנפיקים** ב-`/revenue/issue` → `POST /api/offers/:id/coupon` יוצר **Coupon** (token, qrValue=URL ל-redeem) → **משתפים** (WhatsApp/העתקה, נוסח מקומי) → **מממשים** ב-`/revenue/redeem` → `POST /api/coupons/:token/redeem` (דורש עסק מאומת) יוצר **RedemptionEvent** (issuing≠redeeming) → **חוזרים לניהול** דרך `/revenue` / `/promotions/coupons` / דף-פרטים `/revenue/coupons/[publicId]`. **הנפקה אוטומטית** אפשרית עם `?autoIssue=1`.

## 6. פער מול חזון ה-Marketplace

| אזור | קיים היום | נדרש לחזון | פער |
|---|---|---|---|
| מסך ציבורי לקופונים | ⚠️ `/revenue` ציבורי, חוצה-עסקים, 6 מדורגים | אתר/מסך ציבורי ממוצב לכל אדם | **חלקי** — קיים כתשתית, לא ממוצב |
| 6 כרטיסיות מרכזיות | ✅ limit 6 + דירוג | 6 featured | **קיים** |
| הצגה אוטומטית של קופוני-עסקים | ⚠️ כל Coupon ACTIVE מופיע (רק מונפקים) | פרסום אוטומטי מבוקר | **חלקי** — אין נראות/פרסום |
| בחירה/סינון לפי מיקום | ❌ אין שדה עיר | סינון עיר | **חסר** |
| סינון לפי תחום-עסק | ⚠️ category קיים, לא מסונן | filter קטגוריה | **חלקי-לחסר** |
| חיפוש קופונים | ✅ טקסט צד-לקוח | חיפוש | **קיים (בסיסי)** |
| מיון לפי הכי משתלם | ❌ אין נתון שווי | מיון שווי | **חסר** |
| CTA "צור קופון" (לבעלי-עסק) | ⚠️ קיים, מוצג תמיד | גלוי רק לבעל-עסק מחובר | **חלקי** — אין הבחנה |
| הבחנת ציבורי↔בעל-עסק | ❌ אין ב-UI (רק API) | הבחנה ברורה | **חסר** |
| דף-קופון ציבורי + קישור מימוש | ✅ `/revenue/coupons/[publicId]` + `/code` | דף ציבורי + קישור | **קיים** |
| QR | ✅ | QR | **קיים** |
| Barcode | ❌ (רק inventory) | ברקוד | **חסר** |
| תבנית↔מופע | ✅ Offer↔Coupon | הפרדה | **קיים** |
| קישור-פרסום שמנפיק N ייחודיים | ❌ קופון=הנפקה-אחת | link→N ברקודים ייחודיים | **חסר** |
| ספירה/הגבלת-הנפקות | ❌ | cap (למשל 50) | **חסר** |
| ייחודיות-מימוש | ⚠️ פר-קופון (חד-פעמי) | פר-הנפקה | **חלקי** |
| טבלת issued / redemptions | ✅ Coupon / RedemptionEvent | טבלאות | **קיים** |
| Audit trail | ✅ logAuditEvent | audit | **קיים** |
| Status קופון | ✅ ACTIVE/REDEEMED/EXPIRED/CANCELLED | סטטוסים | **קיים (חלקי)** |
| published/draft/visibility | ❌ | דגלי פרסום | **חסר** |
| Approval flow | ❌ | אישור | **חסר** |
| ownership | ✅ issuingBusinessId | בעלות | **קיים** |
| נתוני-עסק לתצוגה | ⚠️ name✅ category✅(מוסתר) עיר❌ לוגו❌ תיאור❌ | שם/עיר/תחום/תמונה/תיאור | **חלקי** |

## 7. שאלות פתוחות ([U] — לא ניתן להסיק מהקוד)

1. האם החשיפה הציבורית של `/api/revenue/coupons/active` ו-`/[id]`/`/code` היא **כוונה** (מרקטפלייס) או **תוצר-לוואי** שלא הוקשח? — אין ראיה.
2. מדוע `/revenue` (חוצה-עסקים) ו-`/promotions/coupons` (של-העסק) קיימים במקביל — מי ה"בית" האמיתי? — אין ראיה.
3. האם ה-`category/subCategory/businessModel` נועדו לשמש לסינון-מרקטפלייס או רק להכוונה? — כרגע רק להכוונה.
4. מדוע שדה מיקום מוזכר בקוד בלי שדה-סכימה — שריד מתוכנון קודם? — [I] סביר, אין ראיה ישירה.
5. היכן/מתי נקבע `CANCELLED`, והאם יש פוגה מתוזמנת — לא נמצא מסלול.

## 8. סיכונים הנובעים מהמצב הקיים (ללא פתרונות)

- [O] **חשיפת-נתונים לא-מכוונת:** `/api/revenue/coupons/active` (כל העסקים), `/[id]` ו-`/code` — **ציבוריים ללא אימות**; `/code` מחזיר `token` לכל מי שמחזיק `publicId`. אם החזון הציבורי אינו רשמי, זו חשיפה שקיימת כבר היום.
- [O] **הצגה "ריקה" של מיקום:** קוד שמפנה ל-`profile.city` שלא קיים → שדה-מיקום תמיד ריק; כל UI שמסתמך עליו יציג ריק.
- [O] **מודל-הנפקה לא תואם לחזון-הקישור:** קופון=הנפקה-אחת; מנגנון "קישור→N ברקודים" ידרוש מודל-נתונים חדש (אין ספירה/הגבלה/הנפקה-מרובה). זה **פער-ליבה**, לא הרחבה.
- [O] **ריבוי משטחים/מנועים כפולים** (2 בתים, 2 מנועי-דירוג, 3 מנועי-הכוונה, enum יתום) — בסיס לא-אחיד לבנייה עליו.
- [O] **ערבוב ציבורי/פנימי בלי guard-UI:** CTA "צור קופון" ורשימות ציבוריות מוצגים ללא הבחנת-משתמש — עמימות מי-רואה-מה.
- [O] **הסוג שאינו נשמר** — כל מיון/סינון עתידי לפי "סוג הטבה" יצטרך מקור-נתונים חדש (הסוג לא ב-DB).

---

## המסקנה הסופית (לשאלה שנשאלה)

[I] **Dubiz היום אינה "רק כלי-פנימי" — היא כלי-פנימי-ליצירה-והנפקה שיושב על תשתית-נתונים שכבר תוכננה חוצה-עסקים/ציבורית.** בסיס-המרקטפלייס **קיים חלקית**: רשימה ציבורית, דף ציבורי, QR, issue/redeem, ownership, audit. **החסר** להפוך אותו לפלטפורמה: **מיקום כנתון**, **סינון עיר/תחום**, **נראות/פרסום/אישור**, **מנגנון הקישור→הנפקות-מוגבלות-ייחודיות**, **ברקוד**, **מיון-שווי**, ו**הבחנת ציבורי↔בעל-עסק**. שניים מאלה (**מנגנון-הקישור** ו**המיקום**) הם **פערי-ליבה** במודל-הנתונים, לא שכבת-תצוגה.

*Reality Check בלבד — לא תכנון, לא עיצוב, לא שינוי-קוד. ההחלטה איך לשלב את החזון עם העבודה על היצירה נעשית בנפרד, על בסיס הממצאים כאן.*
