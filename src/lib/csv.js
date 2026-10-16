/**
 * Builds CSV text. Cells that start with = + - @ or a tab are prefixed so a spreadsheet cannot run them as a
 * formula (CSV injection), and every cell is quoted.
 */
const safe = (value) => {
  let text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

export function toCsv(columns, rows) {
  const lines = [columns.map((c) => safe(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => safe(c.value(row))).join(","));
  return `﻿${lines.join("\r\n")}\r\n`; // BOM so Excel reads UTF-8
}
