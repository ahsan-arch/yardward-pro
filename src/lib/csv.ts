// Tiny CSV builder + browser download trigger. Excel-friendly: UTF-8 BOM so
// accented client names survive, CRLF line endings, all cells quoted.

export function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  const cell = (v: string | number | null | undefined) => {
    let s = v == null ? "" : String(v);
    // CSV / formula injection guard. A field that an untrusted submitter
    // controls (driver name, notes, client-portal load type, etc.) can start
    // with =, +, -, @ or a tab/CR and Excel/Sheets will evaluate it as a
    // formula when the exported file is opened — e.g. =HYPERLINK(...) to
    // phish the admin, or a DDE payload. Neutralise by prefixing a single
    // quote so the cell renders as literal text. We do this BEFORE quoting so
    // the leading quote is inside the quoted cell. (Negative numbers that are
    // genuinely numeric still read fine with the leading apostrophe stripped
    // by the user if needed; safety wins over a cosmetic apostrophe.)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  };
  return (
    "﻿" + [headers.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\r\n")
  );
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Print-friendly popup used as the "PDF with our logo" path: the user hits
// the browser's print dialog and saves as PDF. Avoids shipping a PDF lib.
export function openPrintView(title: string, bodyHtml: string) {
  const w = window.open("", "_blank", "width=800,height=900");
  if (!w) return;
  // `title` is interpolated into the document <title> raw, so escape it here
  // even though current callers pass system-generated strings — a formstack
  // form name or imported field could carry markup and break out of the
  // <title> context (</title><script>…). `bodyHtml` is the callers'
  // responsibility (they escapeHtml every cell before composing it).
  w.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; max-width: 640px; margin: 24px auto; padding: 0 16px; }
    .brand { display: flex; align-items: center; gap: 12px; border-bottom: 2px solid #D7261E; padding-bottom: 12px; margin-bottom: 20px; }
    .brand img { height: 48px; }
    table { border-collapse: collapse; width: 100%; font-size: 14px; }
    td { padding: 7px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
    td:first-child { color: #666; white-space: nowrap; width: 200px; }
    td:last-child { font-weight: 600; }
    .footer { margin-top: 24px; font-size: 11px; color: #888; }
    @media print { .noprint { display: none; } }
  </style>
</head>
<body>
  <div class="brand">
    <img src="${window.location.origin}/brand/ehs-logo-full.svg" alt="Engage Hydrovac Services" />
  </div>
  ${bodyHtml}
  <p class="footer">Generated ${new Date().toLocaleString()} — Engage Hydrovac Services</p>
  <button class="noprint" onclick="window.print()" style="margin-top:16px;padding:8px 16px;">Print / Save as PDF</button>
</body>
</html>`);
  w.document.close();
  w.focus();
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
