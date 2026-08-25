// NamastePOS dashboard — shared 80mm POS receipt printer (2026-08-25).
//
// WHY this exists: the dashboard had no way to produce a physical receipt
// for an order — "Reprint" on OrdersPage only bumped the backend audit
// counter and toasted "Duplicate printed" without printing anything. The
// mobile app prints over Bluetooth (printer_service.dart → _buildReceipt);
// on the web the equivalent is a popup rendered as an 80mm thermal-roll
// receipt + window.print(), the same pattern TablesPage.printSessionBill
// already uses for session bills. This module generalises that pattern so
// OrdersPage (and later TablesPage) can print ANY order/bill through one
// tested code path instead of each page hand-rolling its own HTML.

import { toast } from 'sonner';
import { getBusinessCache } from '@/api/client';
import { formatINR } from '@/lib/utils';

// Escape user-controlled strings (item names, notes, customer name,
// template footer…) before document.write — a menu item literally named
// "<img onerror=…>" must print as text, not execute inside the popup.
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// WHY explicit Asia/Kolkata (2026-08-25 founder bug "timings are not
// correct"): timestamps are stored as timestamptz (UTC) and were being
// formatted with whatever timezone the renderer happened to run in — UTC
// on the Render server for PDFs, browser TZ on screen. An Indian POS must
// show IST on every printed document regardless of where it renders, so
// every date on a receipt/invoice goes through this helper.
export function formatIstDateTime(d: string | Date | null | undefined): string {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

export interface ReceiptLine {
  qty: number;
  name: string;
  /** Unit price in INR. Used to derive lineTotal when it isn't supplied. */
  price?: number;
  /** Line total in INR — wins over qty × price when provided. */
  lineTotal?: number;
  /** e.g. "Half" / "Large" — printed inline after the item name. */
  variantLabel?: string | null;
  /** Kitchen note ("less spicy") — printed as a small indented sub-line. */
  note?: string | null;
}

export interface ReceiptTotals {
  subtotal?: number;
  discount?: number;
  tax?: number;
  serviceCharge?: number;
  roundOff?: number;
  total: number;
}

export interface PrintReceiptOptions {
  /** Banner under the business header. Defaults to 'TAX INVOICE' to match
   *  the mobile printBill() receipt. */
  title?: string;
  orderNo?: string | number | null;
  /** Session/consolidated bill number — printed alongside/instead of orderNo. */
  billNo?: string | null;
  tokenNo?: string | number | null;
  tableLabel?: string | number | null;
  /** Rendered in IST — see formatIstDateTime. */
  dateTime?: string | Date | null;
  customerName?: string | null;
  customerPhone?: string | null;
  items: ReceiptLine[];
  totals: ReceiptTotals;
  /** 'cash' | 'upi' | 'card' | 'unpaid' | null. unpaid/null prints UNPAID. */
  paymentMethod?: string | null;
  /** Prints the ** DUPLICATE ** banner (reprints of settled orders). */
  duplicate?: boolean;
  /** Shown on the duplicate banner: "copy 2". */
  reprintCount?: number;
  /** Bill-template overrides (Settings → Receipt template). When absent we
   *  fall back to the business cache so the receipt always has a header. */
  headerLines?: string[] | null;
  footerText?: string | null;
  gstin?: string | null;
  fssaiNo?: string | null;
  /** Default true — set false to open the preview without auto-printing. */
  autoPrint?: boolean;
}

// Money on receipts keeps paise when present (₹49.50 must not print as
// ₹50 — formatINR's default rounds to whole rupees, which corrupts bills).
function money(n: number | undefined | null): string {
  return formatINR(Number(n ?? 0), { decimals: true });
}

/**
 * Open a popup with an 80mm POS-style receipt and trigger window.print().
 *
 * Returns true when the popup opened (print dialog shown), false when the
 * browser blocked it (a toast is raised so the cashier knows why nothing
 * happened — the old silent failure is exactly the bug this fixes).
 *
 * IMPORTANT for callers: invoke this synchronously inside the click
 * handler (before any await) — window.open only succeeds while the user
 * gesture is still "active", so async work (audit calls etc.) must happen
 * AFTER the popup is open.
 */
export function printReceipt(opts: PrintReceiptOptions): boolean {
  // Business identity from the login-time cache — zero network calls, same
  // source TablesPage/BillingPage already print from.
  const biz = getBusinessCache() || {};

  // Header: the owner's custom template lines win (that's the whole point
  // of the Receipt-template settings page); otherwise business profile.
  const headerLines: string[] = (opts.headerLines && opts.headerLines.length > 0)
    ? opts.headerLines
    : [biz.name || 'NamastePOS', biz.address, biz.phone ? `Ph: ${biz.phone}` : ''].filter(Boolean);
  const gstin = opts.gstin || biz.gstin || '';

  const headerHtml = headerLines
    .map((l, i) => `<div class="c${i === 0 ? ' biz' : ''}">${escapeHtml(l)}</div>`)
    .join('');

  const itemRows = (opts.items || [])
    .map((it) => {
      const lineTotal = it.lineTotal ?? (Number(it.qty || 0) * Number(it.price || 0));
      const nameBits = `${escapeHtml(it.qty)}&times; ${escapeHtml(it.name)}`
        + (it.variantLabel ? ` <span class="dim">(${escapeHtml(it.variantLabel)})</span>` : '');
      const noteRow = it.note
        ? `<tr><td class="note" colspan="2">&nbsp;&nbsp;› ${escapeHtml(it.note)}</td></tr>`
        : '';
      return `
      <tr>
        <td>${nameBits}</td>
        <td class="amt">${escapeHtml(money(lineTotal))}</td>
      </tr>${noteRow}`;
    })
    .join('');

  const t = opts.totals || { total: 0 };
  const totalRows = [
    t.subtotal != null ? `<tr><td>Subtotal</td><td class="amt">${escapeHtml(money(t.subtotal))}</td></tr>` : '',
    t.discount ? `<tr><td>Discount</td><td class="amt">-${escapeHtml(money(t.discount))}</td></tr>` : '',
    t.tax ? `<tr><td>GST</td><td class="amt">+${escapeHtml(money(t.tax))}</td></tr>` : '',
    t.serviceCharge ? `<tr><td>Service charge</td><td class="amt">+${escapeHtml(money(t.serviceCharge))}</td></tr>` : '',
    t.roundOff ? `<tr><td>Round-off</td><td class="amt">${escapeHtml(money(t.roundOff))}</td></tr>` : '',
    `<tr class="tot"><td>TOTAL</td><td class="amt">${escapeHtml(money(t.total))}</td></tr>`,
  ].join('');

  // PAID vs UNPAID mirrors the refund gating rule everywhere else in the
  // app: unpaid/null paymentMethod ⇒ money not collected yet.
  const paid = !!opts.paymentMethod && opts.paymentMethod !== 'unpaid';
  const paymentLine = paid
    ? `Paid: ${escapeHtml(String(opts.paymentMethod).toUpperCase())}`
    : 'UNPAID';

  const customerLine = [opts.customerName, opts.customerPhone]
    .filter(Boolean).join(' · ');

  const dupBanner = opts.duplicate
    ? `<div class="dup">** DUPLICATE **${opts.reprintCount ? ` (copy ${escapeHtml(opts.reprintCount)})` : ''}</div>`
    : '';

  // Footer text comes from the bill template ("Thank you! Visit again")
  // when configured; template newlines become printed lines.
  const footer = (opts.footerText && opts.footerText.trim())
    ? escapeHtml(opts.footerText.trim()).replace(/\n/g, '<br/>')
    : 'Thank you, visit again!';

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(opts.title || 'TAX INVOICE')}${opts.orderNo ? ` #${escapeHtml(opts.orderNo)}` : ''}</title>
<style>
  /* 80mm thermal-roll look: narrow column, dashed rules, mono digits —
     same visual language as the mobile ESC/POS receipt so a web-printed
     bill and a Bluetooth-printed one look like siblings. */
  @page { size: 80mm auto; margin: 4mm; }
  body {
    font-family: ui-monospace, 'Courier New', Menlo, monospace;
    width: 72mm; margin: 0 auto; padding: 8px 0;
    color: #000; font-size: 12px; line-height: 1.35;
  }
  .c { text-align: center; }
  .biz { font-size: 16px; font-weight: 800; }
  .dim { color: #444; }
  .note { font-size: 10px; font-style: italic; color: #333; }
  .dup {
    text-align: center; font-weight: 800; letter-spacing: 2px;
    border: 1px dashed #000; margin: 6px 0; padding: 3px 0;
  }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  .amt { text-align: right; white-space: nowrap; }
  .tot td { font-weight: 800; font-size: 14px; border-top: 1px solid #000; padding-top: 4px; }
  .pay { text-align: center; font-weight: 700; }
  .token { text-align: center; font-size: 20px; font-weight: 800; letter-spacing: 2px; }
  .noprint { text-align: center; margin-top: 14px; }
  .noprint button {
    padding: 8px 18px; font-weight: 700; cursor: pointer;
    border: 1px solid #000; background: #fff; border-radius: 4px;
  }
  @media print { .noprint { display: none; } body { padding: 0; } }
</style>
</head>
<body>
  ${headerHtml}
  ${gstin ? `<div class="c">GSTIN: ${escapeHtml(gstin)}</div>` : ''}
  ${opts.fssaiNo ? `<div class="c">FSSAI: ${escapeHtml(opts.fssaiNo)}</div>` : ''}
  <hr />
  <div class="c" style="font-weight:800">${escapeHtml(opts.title || 'TAX INVOICE')}</div>
  ${dupBanner}
  ${opts.orderNo != null ? `<div class="c">Order #${escapeHtml(opts.orderNo)}</div>` : ''}
  ${opts.billNo ? `<div class="c">Bill #${escapeHtml(opts.billNo)}</div>` : ''}
  ${opts.tableLabel ? `<div class="c">Table ${escapeHtml(opts.tableLabel)}</div>` : ''}
  ${opts.dateTime ? `<div class="c">${escapeHtml(formatIstDateTime(opts.dateTime))} IST</div>` : ''}
  ${customerLine ? `<div class="c">${escapeHtml(customerLine)}</div>` : ''}
  <hr />
  <table>${itemRows}</table>
  <hr />
  <table>${totalRows}</table>
  <hr />
  <div class="pay">${paymentLine}</div>
  ${opts.tokenNo != null && opts.tokenNo !== '' ? `<hr /><div class="token">TOKEN #${escapeHtml(opts.tokenNo)}</div>` : ''}
  <hr />
  <div class="c">${footer}</div>
  <div class="noprint">
    <!-- Fallback for browsers where the auto-print gets swallowed
         (popup focus quirks) — the cashier can always re-trigger. -->
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
</body>
</html>`;

  // Popup (not a hidden iframe) so the receipt stays open after printing —
  // cashiers often re-print or save the PDF a second time.
  const w = window.open('', '_blank', 'width=420,height=640');
  if (!w) {
    toast.error('Popup blocked — allow popups for this site to print the receipt');
    return false;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  // document.write is synchronous, so the DOM is ready here; focus first so
  // the print dialog attaches to the popup, not the dashboard tab.
  w.focus();
  if (opts.autoPrint !== false) w.print();
  return true;
}
