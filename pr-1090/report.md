# iPhone input zoom — measurement

| screen | engine | lang | text-entry fields | served: min px · below 16px | with the iOS rule: min px · below 16px | page width / viewport (iOS rule, after focus) | visual viewport scale after focus | last action reachable |
|---|---|---|---|---|---|---|---|---|
| customers-list | chromium | he | 1 | 14 · 1 | 16 · 0 | 393/393 | 1 | — |
| customers-new | chromium | he | 4 | 14 · 4 | 16 · 0 | 393/393 | 1 | true |
| leads-new | chromium | he | 5 | 14 · 5 | 16 · 0 | 393/393 | 1 | true |
| supplier-edit | chromium | he | 19 | 14 · 19 | 16 · 0 | 393/393 | 1 | true |
| business-details | chromium | he | 10 | 13 · 10 | 16 · 0 | 393/393 | 1 | — |
| billing-identity-gate | chromium | he | 6 | 13 · 6 | 16 · 0 | 393/393 | 1 | true |
| customers-list | chromium | en | 1 | 14 · 1 | 16 · 0 | 393/393 | 1 | — |
| customers-new | chromium | en | 4 | 14 · 4 | 16 · 0 | 393/393 | 1 | true |
| leads-new | chromium | en | 5 | 14 · 5 | 16 · 0 | 393/393 | 1 | true |
| supplier-edit | chromium | en | 19 | 14 · 19 | 16 · 0 | 393/393 | 1 | true |
| business-details | chromium | en | 10 | 13 · 10 | 16 · 0 | 393/393 | 1 | — |
| billing-identity-gate | chromium | en | 6 | 13 · 6 | 16 · 0 | 393/393 | 1 | true |
| customers-list | webkit | he | 1 | 14 · 1 | 16 · 0 | 390/390 | 1 | — |
| customers-new | webkit | he | 4 | 14 · 4 | 16 · 0 | 390/390 | 1 | true |
| leads-new | webkit | he | 5 | 14 · 5 | 16 · 0 | 390/390 | 1 | true |
| supplier-edit | webkit | he | 19 | 14 · 19 | 16 · 0 | 390/390 | 1 | true |
| business-details | webkit | he | 10 | 13 · 10 | 16 · 0 | 390/390 | 1 | — |
| billing-identity-gate | webkit | he | 6 | 13 · 6 | 16 · 0 | 390/390 | 1 | true |
| customers-list | webkit | en | 1 | 14 · 1 | 16 · 0 | 390/390 | 1 | — |
| customers-new | webkit | en | 4 | 14 · 4 | 16 · 0 | 390/390 | 1 | true |
| leads-new | webkit | en | 5 | 14 · 5 | 16 · 0 | 390/390 | 1 | true |
| supplier-edit | webkit | en | 19 | 14 · 19 | 16 · 0 | 390/390 | 1 | true |
| business-details | webkit | en | 10 | 13 · 10 | 16 · 0 | 390/390 | 1 | — |
| billing-identity-gate | webkit | en | 6 | 13 · 6 | 16 · 0 | 390/390 | 1 | true |

CSS.supports('-webkit-touch-callout: none'): Chromium false, Playwright WebKit false.

Fields below 16px as served (the iPhone zoom triggers):

- customers-list: input[text] "חיפוש לפי שם או טלפון" 14px
- customers-new: input[text] "crm-new-name" 14px; input[text] "crm-new-phone" 14px; input[text] "crm-new-email" 14px; input[text] "crm-new-city" 14px
- leads-new: input[text] "lead-new-name" 14px; input[text] "lead-new-phone" 14px; input[text] "lead-new-email" 14px; select "lead-new-source" 14px; textarea "במשפט אחד — מה ביקש?" 14px
- supplier-edit: input[text] "sup-edit-name" 14px; input[text] "sup-edit-phone" 14px; input[text] "sup-edit-email" 14px; select "sup-edit-taxIdType" 14px; input[text] "sup-edit-taxId" 14px; input[text] "sup-edit-legalName" 14px; input[text] "למשל: מזון, אריזות, שירותים" 14px; input[text] "sup-edit-website" 14px; input[text] "sup-edit-contactName" 14px; input[text] "sup-edit-contactRole" 14px; input[text] "sup-edit-contactPhone" 14px; input[text] "sup-edit-contactEmail" 14px; input[text] "sup-edit-addressStreet" 14px; input[text] "sup-edit-addressCity" 14px; input[text] "sup-edit-addressPostalCode" 14px; select "sup-edit-paymentTerms" 14px; select "sup-edit-payMethod" 14px; input[text] "sup-edit-lead" 14px; textarea "sup-edit-notes" 14px
- business-details: input[text] "שם העסק" 15px; input[text] "שם העסק במסמך" 13px; select "סוג עסקבחרו…עוסק פטורעוסק מורשהחברה בע"מ" 13px; input[text] "ע.מ. / ח.פ." 13px; textarea "כתובתרחוב הבדיקה 1, תל אביב" 13px; input[text] "טלפון" 13px; input[text] "דוא"ל" 13px; input[text] "מספר עוסק מורשה (אם רלוונטי)" 13px; textarea "פרטי תשלום (בנק / Bit / הוראות)" 13px; textarea "שורת פוטר (אופציונלי)" 13px
- billing-identity-gate: input[text] "שם העסק במסמך" 13px; select "סוג עסקבחרו…עוסק פטורעוסק מורשהחברה בע"מ" 13px; input[text] "ע.מ. / ח.פ." 13px; textarea "כתובת" 13px; input[text] "טלפון" 13px; input[text] "דוא"ל" 13px

All checks passed.
