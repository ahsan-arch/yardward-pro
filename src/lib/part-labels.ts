// Printable parts labels: SKU-encoded QR + human-readable text, sized to fit
// a standard 30-up address-label sheet (2.625in x 1in, e.g. Avery 5160) so
// admins can print onto stock they can already buy anywhere.
//
// Client feedback (Fleetio pressure points #7): "Parts labels are only
// available in two sizes and the layout is useless, no part description, QR
// code is far too big, no way to edit layout, includes part location which
// doesn't make any sense at all." This keeps the QR small (just enough to
// scan), puts the part name front and center, and — deliberately, per that
// same complaint — leaves location off the label itself (a label travels
// with the part; printing its shelf location on it goes stale the moment
// the part moves bins).
//
// Doesn't reuse lib/csv.ts's openPrintView: that helper's layout (branded
// header, 640px receipt-style body, footer) is built for one-document
// printouts, not a wrapping grid of small tiles meant to fill a full sheet.

import QRCode from "qrcode";
import { escapeHtml } from "./csv";

export interface PartLabelInput {
  sku: string;
  name: string;
}

export async function printPartLabels(items: PartLabelInput[]): Promise<void> {
  if (items.length === 0) return;
  const qrDataUrls = await Promise.all(
    items.map((i) => QRCode.toDataURL(i.sku, { width: 200, margin: 0 })),
  );
  const labelsHtml = items
    .map(
      (i, idx) => `
    <div class="label">
      <img src="${qrDataUrls[idx]}" class="qr" alt="" />
      <div class="text">
        <div class="name">${escapeHtml(i.name)}</div>
        <div class="sku">${escapeHtml(i.sku)}</div>
      </div>
    </div>`,
    )
    .join("");

  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) return;
  const title = items.length === 1 ? `Label — ${items[0].sku}` : `Part labels (${items.length})`;
  w.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0.2in; }
    .toolbar { margin-bottom: 0.15in; }
    .toolbar button { padding: 8px 16px; font-size: 14px; cursor: pointer; }
    .sheet { display: flex; flex-wrap: wrap; gap: 0.06in; }
    .label {
      width: 2.625in;
      height: 1in;
      border: 1px dashed #ccc;
      display: flex;
      align-items: center;
      gap: 0.1in;
      padding: 0.08in 0.12in;
      page-break-inside: avoid;
      overflow: hidden;
    }
    .qr { width: 0.8in; height: 0.8in; flex-shrink: 0; }
    .text { min-width: 0; }
    .name {
      font-size: 9.5pt;
      font-weight: 600;
      line-height: 1.2;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .sku { font-family: ui-monospace, monospace; font-size: 9pt; color: #444; margin-top: 2px; }
    @media print {
      .toolbar { display: none; }
      .label { border: none; }
      body { margin: 0.25in; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="sheet">${labelsHtml}</div>
</body>
</html>`);
  w.document.close();
  w.focus();
}
