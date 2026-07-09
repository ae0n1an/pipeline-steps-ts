/**
 * Shared CSV parser for the payload validation steps (verify-row-count,
 * validate-business-logic). A small RFC4180-style state machine — plain
 * newline-splitting would miscount rows if a field contains an embedded
 * newline, which generate-synthetic-csv's own csvEscape can produce.
 */

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(content: string): ParsedCsv {
  const rawRows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const c = content[i];

    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rawRows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush a trailing field/row for content that doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rawRows.push(row);
  }

  const [headers, ...dataRows] = rawRows;
  if (!headers) return { headers: [], rows: [] };

  return {
    headers,
    rows: dataRows.map(r => Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? '']))),
  };
}
