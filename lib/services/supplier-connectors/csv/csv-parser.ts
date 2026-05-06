type CsvRecord = Record<string, string>;

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  out.push(current);
  return out.map((v) => v.trim());
}

function isHeaderKeyValid(key: string) {
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * Minimal internal CSV parser (MVP).
 * - First non-empty row is headers
 * - Comma-separated values
 * - Basic double-quote wrapping + "" escaping
 * - Skips empty rows
 * - Returns [] for empty CSV or invalid headers
 */
export function parseCsvToRecords(csv: string): CsvRecord[] {
  if (typeof csv !== "string") return [];

  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());

  if (headers.length === 0 || headers.some((h) => !isHeaderKeyValid(h))) {
    return [];
  }

  const records: CsvRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);

    const record: CsvRecord = {};
    for (let c = 0; c < headers.length; c++) {
      record[headers[c]] = values[c] ?? "";
    }

    records.push(record);
  }

  return records;
}

