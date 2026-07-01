/**
 * WP2.3 — Uniform File record layouts, transcribed VERBATIM from the official
 * "הוראות להפקת קבצים במבנה אחיד" version 1.31 (01/05/2009).
 *
 * In-scope records only (BD-1, invoice-issuance software):
 *   INI.TXT:      A000 (466), summary records (19 each)
 *   BKMVDATA.TXT: A100 (95), C100 (444), D110 (339), D120 (222), Z900 (110)
 * Out of scope (not produced): B100, B110, M100.
 *
 * Cancelled fields (מבוטל, length 0) are intentionally omitted — they occupy no
 * columns. Every layout self-asserts that Σ(field lengths) == declared length.
 */

export type FieldKind =
  | { k: "CONST"; value: string }
  | { k: "ALPHA" }
  | { k: "NUM" }
  | { k: "AMOUNT"; frac: number } // signed X9()v.., no dot
  | { k: "UNUM"; frac: number } // unsigned 9()v.., no dot
  | { k: "DATE" }
  | { k: "TIME" };

export type FieldSpec = { id: number; name: string; len: number; kind: FieldKind };
export type RecordLayout = { code: string; length: number; fields: FieldSpec[] };

const konst = (id: number, name: string, len: number, value: string): FieldSpec => ({ id, name, len, kind: { k: "CONST", value } });
const alpha = (id: number, name: string, len: number): FieldSpec => ({ id, name, len, kind: { k: "ALPHA" } });
const num = (id: number, name: string, len: number): FieldSpec => ({ id, name, len, kind: { k: "NUM" } });
const amount = (id: number, name: string, len: number, frac = 2): FieldSpec => ({ id, name, len, kind: { k: "AMOUNT", frac } });
const unum = (id: number, name: string, len: number, frac: number): FieldSpec => ({ id, name, len, kind: { k: "UNUM", frac } });
const date = (id: number, name: string): FieldSpec => ({ id, name, len: 8, kind: { k: "DATE" } });
const time = (id: number, name: string): FieldSpec => ({ id, name, len: 4, kind: { k: "TIME" } });

export const SYSTEM_CONSTANT = "&OF1.31&"; // fields 1005/1104/1154 (§3.1)

// ---- INI.TXT ----

export const A000_LAYOUT: RecordLayout = {
  code: "A000",
  length: 466,
  fields: [
    konst(1000, "קוד רשומה", 4, "A000"),
    alpha(1001, "לשימוש עתידי", 5),
    num(1002, "סך רשומות BKMVDATA", 15),
    num(1003, "מספר עוסק מורשה", 9),
    num(1004, "מזהה ראשי", 15),
    konst(1005, "קבוע מערכת", 8, SYSTEM_CONSTANT),
    num(1006, "מספר רישום התוכנה", 8),
    alpha(1007, "שם התוכנה", 20),
    alpha(1008, "מהדורת התוכנה", 20),
    num(1009, "ע\"מ יצרן התוכנה", 9),
    alpha(1010, "שם יצרן התוכנה", 20),
    num(1011, "סוג התוכנה", 1),
    alpha(1012, "נתיב מיקום שמירת הקבצים", 50),
    num(1013, "סוג הנהח\"ש", 1),
    num(1014, "איזון חשבונאי נדרש", 1),
    num(1015, "מספר חברה ברשם החברות", 9),
    num(1016, "מספר תיק ניכויים", 9),
    alpha(1017, "שטח נתונים עתידי", 10),
    alpha(1018, "שם העסק", 50),
    alpha(1019, "מען העסק - רחוב", 50),
    alpha(1020, "מען העסק - מס בית", 10),
    alpha(1021, "מען העסק - עיר", 30),
    alpha(1022, "מען העסק - מיקוד", 8),
    num(1023, "שנת המס", 4),
    date(1024, "טווח נתונים - תאריך התחלה"),
    date(1025, "טווח נתונים - תאריך סיום"),
    date(1026, "תאריך תחילת התהליך"),
    time(1027, "שעת התחלת התהליך"),
    num(1028, "קוד שפה", 1),
    num(1029, "סט תוים", 1),
    alpha(1030, "שם תוכנת הכיווץ", 20),
    // 1031 cancelled (0)
    alpha(1032, "מטבע מוביל", 3),
    // 1033 cancelled (0)
    num(1034, "מידע על סניפים/ענפים", 1),
    alpha(1035, "שטח לנתונים עתידיים", 46),
  ],
};

export const INI_SUMMARY_LAYOUT: RecordLayout = {
  code: "SUMMARY",
  length: 19,
  fields: [alpha(1050, "קוד רשומה", 4), num(1051, "סך רשומות", 15)],
};

// ---- BKMVDATA.TXT ----

export const A100_LAYOUT: RecordLayout = {
  code: "A100",
  length: 95,
  fields: [
    konst(1100, "קוד רשומה", 4, "A100"),
    num(1101, "מס רשומה בקובץ", 9),
    num(1102, "מספר עוסק מורשה", 9),
    num(1103, "מזהה ראשי", 15),
    konst(1104, "קבוע מערכת", 8, SYSTEM_CONSTANT),
    alpha(1105, "שטח לנתונים עתידיים", 50),
  ],
};

export const Z900_LAYOUT: RecordLayout = {
  code: "Z900",
  length: 110,
  fields: [
    konst(1150, "קוד רשומה", 4, "Z900"),
    num(1151, "מס רשומה בקובץ", 9),
    num(1152, "מספר עוסק מורשה", 9),
    num(1153, "מזהה ראשי", 15),
    konst(1154, "קבוע מערכת", 8, SYSTEM_CONSTANT),
    num(1155, "סך רשומות כולל בקובץ", 15),
    alpha(1156, "שטח לנתונים עתידיים", 50),
  ],
};

export const C100_LAYOUT: RecordLayout = {
  code: "C100",
  length: 444,
  fields: [
    konst(1200, "קוד רשומה", 4, "C100"),
    num(1201, "מס רשומה בקובץ", 9),
    num(1202, "מס עוסק מורשה", 9),
    num(1203, "סוג מסמך", 3),
    alpha(1204, "מספר מסמך", 20),
    date(1205, "תאריך הפקת מסמך"),
    time(1206, "שעת הפקת מסמך"),
    alpha(1207, "שם לקוח/ספק", 50),
    alpha(1208, "מען - רחוב", 50),
    alpha(1209, "מען - מס בית", 10),
    alpha(1210, "מען - עיר", 30),
    alpha(1211, "מען - מיקוד", 8),
    alpha(1212, "מען - מדינה", 30),
    alpha(1213, "מען - קוד מדינה", 2),
    alpha(1214, "טלפון לקוח/ספק", 15),
    num(1215, "מס עוסק מורשה לקוח/ספק", 9),
    date(1216, "תאריך ערך"),
    amount(1217, "סכום סופי במט\"ח", 15),
    alpha(1218, "קוד מט\"ח", 3),
    amount(1219, "סכום לפני הנחת מסמך", 15),
    amount(1220, "הנחת מסמך", 15),
    amount(1221, "סכום לאחר הנחות ללא מע\"מ", 15),
    amount(1222, "סכום המע\"מ", 15),
    amount(1223, "סכום המסמך כולל מע\"מ", 15),
    amount(1224, "סכום הניכוי במקור", 12),
    alpha(1225, "מפתח לקוח/ספק", 15),
    alpha(1226, "שדה התאמה", 10),
    // 1227 cancelled
    alpha(1228, "מסמך מבוטל", 1),
    // 1229 cancelled
    date(1230, "תאריך המסמך"),
    alpha(1231, "מזהה סניף/ענף", 7),
    // 1232 cancelled
    alpha(1233, "מבצע הפעולה", 9),
    num(1234, "שדה מקשר לשורה", 7),
    alpha(1235, "שטח לנתונים עתידיים", 13),
  ],
};

export const D110_LAYOUT: RecordLayout = {
  code: "D110",
  length: 339,
  fields: [
    konst(1250, "קוד רשומה", 4, "D110"),
    num(1251, "מס רשומה בקובץ", 9),
    num(1252, "מס עוסק מורשה", 9),
    num(1253, "סוג המסמך", 3),
    alpha(1254, "מספר המסמך", 20),
    num(1255, "מספר שורה במסמך", 4),
    num(1256, "סוג מסמך בסיס", 3),
    alpha(1257, "מספר מסמך בסיס", 20),
    num(1258, "סוג עסקה", 1),
    alpha(1259, "מק\"ט פנימי", 20),
    alpha(1260, "תיאור הטובין/השירות", 30),
    alpha(1261, "שם היצרן", 50),
    alpha(1262, "מספר סידורי של המוצר", 30),
    alpha(1263, "תיאור יחידת המידה", 20),
    amount(1264, "הכמות", 17, 4),
    amount(1265, "מחיר ליחידה ללא מע\"מ", 15),
    amount(1266, "הנחת שורה", 15),
    amount(1267, "סך סכום לשורה", 15),
    unum(1268, "שיעור המע\"מ בשורה", 4, 2),
    // 1269 cancelled
    alpha(1270, "מזהה סניף/ענף", 7),
    // 1271 cancelled
    date(1272, "תאריך המסמך"),
    num(1273, "שדה מקשר לכותרת", 7),
    alpha(1274, "מזהה סניף/ענף למסמך בסיס", 7),
    alpha(1275, "שטח לנתונים עתידיים", 21),
  ],
};

export const D120_LAYOUT: RecordLayout = {
  code: "D120",
  length: 222,
  fields: [
    konst(1300, "קוד רשומה", 4, "D120"),
    num(1301, "מס רשומה בקובץ", 9),
    num(1302, "מס עוסק מורשה", 9),
    num(1303, "סוג מסמך", 3),
    alpha(1304, "מספר מסמך", 20),
    num(1305, "מספר שורה במסמך", 4),
    num(1306, "סוג אמצעי התשלום", 1),
    num(1307, "מספר הבנק", 10),
    num(1308, "מספר הסניף", 10),
    num(1309, "מספר חשבון", 15),
    num(1310, "מספר המחאה", 10),
    date(1311, "תאריך הפירעון"),
    amount(1312, "סכום השורה", 15),
    num(1313, "קוד החברה הסולקת", 1),
    alpha(1314, "שם הכרטיס הנסלק", 20),
    num(1315, "סוג עסקת האשראי", 1),
    // 1316-1319 cancelled
    alpha(1320, "מזהה סניף/ענף", 7),
    // 1321 cancelled
    date(1322, "תאריך המסמך"),
    num(1323, "שדה מקשר לכותרת", 7),
    alpha(1324, "שטח לנתונים עתידיים", 60),
  ],
};

/** Self-check: every layout's field lengths must sum to its declared length. */
export function assertLayoutConsistency(layout: RecordLayout): void {
  const sum = layout.fields.reduce((acc, f) => acc + f.len, 0);
  if (sum !== layout.length) {
    throw new Error(`Layout ${layout.code}: Σlen=${sum} != ${layout.length}`);
  }
}

export const ALL_LAYOUTS: RecordLayout[] = [
  A000_LAYOUT,
  INI_SUMMARY_LAYOUT,
  A100_LAYOUT,
  Z900_LAYOUT,
  C100_LAYOUT,
  D110_LAYOUT,
  D120_LAYOUT,
];

for (const l of ALL_LAYOUTS) assertLayoutConsistency(l);
