// Shared CSV helpers (2026-09-03) — extracted from BulkImportPage so the
// migration wizard (/migrate) reuses the exact same parser instead of
// duplicating it. Deliberately no papaparse dep.

export type CsvRow = Record<string, string>;

// Tiny CSV parser — handles quoted fields with embedded commas and CRLF,
// which is what Excel / Google Sheets emit. Headers are normalised to
// lowercase snake_case so "Cost Per Unit INR", "cost_per_unit_inr" and
// "COST PER UNIT INR" all land on the same key.
export function parseCsv(text: string): CsvRow[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '', inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = splitLine(lines[0]).map((h) => h.toLowerCase().trim().replace(/\s+/g, '_'));
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const obj: CsvRow = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
}

// Renames snake_case CSV headers to the camelCase keys the API expects and
// drops blank cells so backend Joi defaults apply instead of empty strings
// failing number coercion.
export function shapeRow(row: CsvRow, mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [csvKey, apiKey] of Object.entries(mapping)) {
    const v = row[csvKey];
    if (v !== undefined && v !== '') out[apiKey] = v;
  }
  return out;
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
