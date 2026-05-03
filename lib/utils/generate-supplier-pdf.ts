import { jsPDF } from "jspdf";

export function generateSupplierPDF(draft: any) {
  const doc = new jsPDF();

  // טעינת הפונט
  doc.addFileToVFS(
    "NotoSansHebrew-Regular.ttf",
    // הפונט ייטען מה-public
    ""
  );

  doc.addFont("NotoSansHebrew-Regular.ttf", "Noto", "normal");
  doc.setFont("Noto");

  const supplierName = draft.supplierName || "ספק";
  const today = new Date().toLocaleDateString("he-IL");

  let y = 20;

  // כותרת
  doc.setFontSize(18);
  doc.text(`הזמנת רכש`, 200, y, { align: "right" });
  y += 10;

  doc.setFontSize(12);
  doc.text(`ספק: ${supplierName}`, 200, y, { align: "right" });
  y += 6;
  doc.text(`מספר הזמנה: #${draft.id}`, 200, y, { align: "right" });
  y += 6;
  doc.text(`תאריך: ${today}`, 200, y, { align: "right" });

  y += 12;

  // כותרות טבלה
  doc.setFontSize(11);
  doc.text("מספר", 180, y, { align: "right" });
  doc.text("שם מוצר", 140, y, { align: "right" });
  doc.text("כמות", 90, y, { align: "right" });
  doc.text("יחידה", 60, y, { align: "right" });

  y += 6;

  // קו
  doc.line(20, y, 190, y);
  y += 6;

  draft.lines.forEach((line: any, index: number) => {
    doc.text(String(index + 1), 180, y, { align: "right" });
    doc.text(line.rawName || "ללא שם", 140, y, { align: "right" });
    doc.text(String(line.quantity), 90, y, { align: "right" });
    doc.text(line.unitType || "UNIT", 60, y, { align: "right" });

    y += 8;
  });

  // הורדה
  doc.save(`supplier-order-${draft.id}.pdf`);
}