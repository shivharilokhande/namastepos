// NamastePOS dashboard — Web Bluetooth ESC/POS printer driver (2026-08-25).
//
// WHY this exists: the founder wants the dashboard to talk to a nearby
// Bluetooth thermal printer directly from the browser. Until now physical
// printing was mobile-app-only (printer_service.dart) or via the LAN print
// agent; the web fallback was an HTML popup + window.print()
// (receiptPrint.ts), which needs an OS printer driver most thermal
// printers don't ship for browsers. Chrome/Edge expose Web Bluetooth, and
// virtually every cheap BLE thermal printer (the kind Indian restaurants
// actually buy) is just a BLE-serial bridge: one service, one writable
// characteristic, raw ESC/POS bytes in. This module is that bridge.
//
// Limits, stated up front: Web Bluetooth is Chromium-only (no iOS Safari,
// no Firefox), requires HTTPS + a user gesture, and only reaches BLE
// (GATT) printers — classic-Bluetooth-only (SPP) printers won't appear in
// the chooser. The mobile app / print agent remain the production path;
// this is a convenience for the owner at the laptop.

import { getBusinessCache } from '@/api/client';
import { formatIstDateTime, type PrintReceiptOptions } from '@/lib/receiptPrint';

// ── Web Bluetooth type shims ────────────────────────────────────────────────
// WHY local shims (2026-08-25): tsconfig lib is ["ES2020","DOM","DOM.Iterable"]
// and the project does NOT depend on @types/web-bluetooth, so none of these
// names exist at compile time. Declaring the minimal surface we use, module-
// scoped (no `declare global`), keeps the dependency footprint at zero and
// can't collide with a future @types/web-bluetooth install.

interface BluetoothCharacteristicProperties {
  write: boolean;
  writeWithoutResponse: boolean;
}

interface BluetoothRemoteGATTCharacteristic {
  readonly uuid: string;
  readonly properties: BluetoothCharacteristicProperties;
  // Typed as Uint8Array (not DOM BufferSource) on purpose: TS 5.7 makes
  // Uint8Array generic over ArrayBufferLike, which BufferSource rejects —
  // and since these shims are ours, we only declare what we actually send.
  /** Deprecated alias kept as the last-resort fallback — older Chromium only. */
  writeValue(value: Uint8Array): Promise<void>;
  writeValueWithResponse?(value: Uint8Array): Promise<void>;
  writeValueWithoutResponse?(value: Uint8Array): Promise<void>;
}

interface BluetoothRemoteGATTService {
  readonly uuid: string;
  getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristic[]>;
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryServices(): Promise<BluetoothRemoteGATTService[]>;
}

interface BluetoothDevice {
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void;
}

interface Bluetooth {
  requestDevice(options: {
    acceptAllDevices?: boolean;
    optionalServices?: string[];
  }): Promise<BluetoothDevice>;
}

type NavigatorWithBluetooth = Navigator & { bluetooth?: Bluetooth };

// ── Constants ───────────────────────────────────────────────────────────────

// WHY these UUIDs (2026-08-25): Web Bluetooth only lets a page talk to
// services it declared in requestDevice(). Cheap BLE thermal printers don't
// share one standard service, but in practice nearly all of them use one of
// these four "BLE serial" services, so declaring all four + acceptAllDevices
// covers the market without needing a per-brand picker:
//   000018f0… — the quasi-standard "printer service" (Goojprt, Xprinter, many
//               generic 58mm units)
//   0000ff00… — common Chinese BLE-serial clone service (MTP/PeriPage family)
//   0000ffe0… — HM-10/JDY UART-bridge modules embedded in budget printers
//   49535343… — Microchip/ISSC transparent UART (Epson-compatible + many POS
//               brands)
const PRINTER_SERVICE_UUIDS = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
];

// WHY 150 bytes / 30ms (2026-08-25): BLE default ATT MTU is 23 bytes but
// Chromium negotiates up — 150 stays safely under the ~180–240 byte payloads
// budget printers advertise while keeping chunk count low. The 30ms pause
// between chunks matches what the printers' own vendor apps do: their MCUs
// have tiny RX buffers and silently DROP bytes mid-receipt when writes come
// back-to-back (writeWithoutResponse has no flow control), which prints as
// garbled half-receipts. Slower-but-complete beats fast-but-corrupt on a bill.
const CHUNK_SIZE = 150;
const CHUNK_DELAY_MS = 30;

// WHY 32 chars (2026-08-25): 58mm paper at ESC/POS Font A is 32 columns —
// the dominant width for BLE printers in Indian restaurants (the 80mm units
// are usually LAN/USB and go through the print agent instead). A 32-wide
// layout also prints fine on 80mm paper, just with margin; the reverse (48
// on 58mm) wraps mid-word and mangles the bill.
const WIDTH = 32;
const SEP = '-'.repeat(WIDTH);

// ESC/POS byte sequences (verified against the Epson command reference —
// same commands printer_service.dart sends on mobile).
const ESC_INIT = [0x1b, 0x40]; // ESC @ — reset formatting/state
const LF = 0x0a;
const CUT_PARTIAL = [0x1d, 0x56, 66, 0]; // GS V 66 0 — feed + partial cut

// ── Support check ───────────────────────────────────────────────────────────

export function isWebBluetoothSupported(): boolean {
  // navigator.bluetooth only exists on Chromium in a secure context (HTTPS
  // or localhost) — one truthiness check covers both browser and protocol.
  return typeof navigator !== 'undefined'
    && !!(navigator as NavigatorWithBluetooth).bluetooth;
}

// ── Text helpers (32-column ESC/POS layout) ─────────────────────────────────

// WHY ASCII-only (2026-08-25): these printers default to code page 437 and
// ship with wildly inconsistent codepage support — sending UTF-8 prints
// mojibake. Everything funnels through this transliterator so ₹ becomes
// "Rs." (the one non-ASCII char guaranteed on every Indian bill) and any
// other exotic char degrades to '?' instead of garbage.
function toAscii(s: string): string {
  return s
    .replace(/₹/g, 'Rs.')
    .replace(/[×✕✖]/g, 'x')
    .replace(/[–—]/g, '-')
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/…/g, '...')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x0A\x20-\x7E]/g, '?');
}

function encodeAscii(s: string): number[] {
  const out: number[] = [];
  for (const ch of toAscii(s)) out.push(ch.codePointAt(0) as number);
  return out;
}

// Word-wrap with a hard break for single tokens longer than the line —
// a 40-char item name must wrap, not overflow into the price column.
function wrapText(s: string, width: number): string[] {
  const words = toAscii(s).trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let w of words) {
    while (w.length > width) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [''];
}

function centerLines(s: string): string[] {
  return wrapText(s, WIDTH).map((l) =>
    l.length >= WIDTH ? l : ' '.repeat(Math.floor((WIDTH - l.length) / 2)) + l);
}

// "qty× name …… amount" rows: amount pinned to the right edge of the first
// line, long names wrap underneath with a 2-space hang indent so the qty
// column stays scannable — mirrors the mobile _buildReceipt layout.
function rowWithAmount(left: string, amount: string): string[] {
  const amt = toAscii(amount);
  const leftWidth = Math.max(WIDTH - amt.length - 1, 10);
  const wrapped = wrapText(left, leftWidth);
  const out = [wrapped[0].padEnd(WIDTH - amt.length, ' ') + amt];
  for (let i = 1; i < wrapped.length; i++) out.push(`  ${wrapped[i]}`);
  return out;
}

// Money on receipts keeps paise (same rule as receiptPrint.money): ₹49.50
// must not print as ₹50. ASCII "Rs." because of the codepage rule above.
function money(n: number | undefined | null): string {
  const v = Number(n ?? 0);
  return `${v < 0 ? '-' : ''}Rs.${Math.abs(v).toFixed(2)}`;
}

// ── Receipt rendering (PrintReceiptOptions → 32-col text lines) ─────────────
// Same data contract as the HTML popup printer (receiptPrint.printReceipt)
// so OrdersPage/TablesPage can feed either path with one options object.
function buildReceiptLines(opts: PrintReceiptOptions): string[] {
  const biz = getBusinessCache() || {};
  const lines: string[] = [];

  // Header: owner's bill-template lines win, else business profile — the
  // exact fallback chain receiptPrint uses, so both outputs look alike.
  const headerLines: string[] = (opts.headerLines && opts.headerLines.length > 0)
    ? opts.headerLines
    : [biz.name || 'NamastePOS', biz.address, biz.phone ? `Ph: ${biz.phone}` : '']
      .filter(Boolean) as string[];
  headerLines.forEach((h) => lines.push(...centerLines(h)));

  const gstin = opts.gstin || biz.gstin || '';
  if (gstin) lines.push(...centerLines(`GSTIN: ${gstin}`));
  if (opts.fssaiNo) lines.push(...centerLines(`FSSAI: ${opts.fssaiNo}`));

  lines.push(SEP);
  lines.push(...centerLines(opts.title || 'TAX INVOICE'));
  if (opts.duplicate) {
    lines.push(...centerLines(
      `** DUPLICATE **${opts.reprintCount ? ` (copy ${opts.reprintCount})` : ''}`,
    ));
  }
  if (opts.orderNo != null && opts.orderNo !== '') lines.push(...centerLines(`Order #${opts.orderNo}`));
  if (opts.billNo) lines.push(...centerLines(`Bill #${opts.billNo}`));
  if (opts.tableLabel != null && opts.tableLabel !== '') lines.push(...centerLines(`Table ${opts.tableLabel}`));
  if (opts.dateTime) lines.push(...centerLines(`${formatIstDateTime(opts.dateTime)} IST`));
  const customerLine = [opts.customerName, opts.customerPhone].filter(Boolean).join(' / ');
  if (customerLine) lines.push(...centerLines(customerLine));

  lines.push(SEP);
  for (const it of opts.items || []) {
    const lineTotal = it.lineTotal ?? (Number(it.qty || 0) * Number(it.price || 0));
    const name = `${it.qty}x ${it.name}`
      + (it.variantLabel ? ` (${it.variantLabel})` : '');
    lines.push(...rowWithAmount(name, money(lineTotal)));
    if (it.note) lines.push(...wrapText(`  > ${it.note}`, WIDTH));
  }

  lines.push(SEP);
  const t = opts.totals || { total: 0 };
  if (t.subtotal != null) lines.push(...rowWithAmount('Subtotal', money(t.subtotal)));
  if (t.discount) lines.push(...rowWithAmount('Discount', `-${money(t.discount)}`));
  if (t.tax) lines.push(...rowWithAmount('GST', `+${money(t.tax)}`));
  if (t.serviceCharge) lines.push(...rowWithAmount('Service charge', `+${money(t.serviceCharge)}`));
  if (t.roundOff) lines.push(...rowWithAmount('Round-off', money(t.roundOff)));
  lines.push(...rowWithAmount('TOTAL', money(t.total)));

  lines.push(SEP);
  // PAID vs UNPAID mirrors the refund-gating rule app-wide: unpaid/null
  // paymentMethod means money not collected yet.
  const paid = !!opts.paymentMethod && opts.paymentMethod !== 'unpaid';
  lines.push(...centerLines(
    paid ? `Paid: ${String(opts.paymentMethod).toUpperCase()}` : 'UNPAID',
  ));

  if (opts.tokenNo != null && opts.tokenNo !== '') {
    lines.push(SEP);
    lines.push(...centerLines(`TOKEN #${opts.tokenNo}`));
  }

  lines.push(SEP);
  const footer = (opts.footerText && opts.footerText.trim())
    ? opts.footerText.trim()
    : 'Thank you, visit again!';
  footer.split('\n').forEach((f) => lines.push(...centerLines(f)));

  return lines;
}

// Wrap rendered text lines in ESC/POS framing: init, body, feed, cut.
function frameEscpos(lines: string[]): Uint8Array {
  return Uint8Array.from([
    ...ESC_INIT, // reset state — a prior crashed job must not leak bold/CJK mode
    ...encodeAscii(lines.join('\n')),
    LF, LF, LF, LF, // clear the tear bar before cutting
    ...CUT_PARTIAL,
  ]);
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

// ── Printer handle ──────────────────────────────────────────────────────────

export class BtPrinter {
  private device: BluetoothDevice;

  private server: BluetoothRemoteGATTServer;

  private characteristic: BluetoothRemoteGATTCharacteristic;

  private gone = false;

  constructor(
    device: BluetoothDevice,
    server: BluetoothRemoteGATTServer,
    characteristic: BluetoothRemoteGATTCharacteristic,
  ) {
    this.device = device;
    this.server = server;
    this.characteristic = characteristic;
    // Printers power-save aggressively; track the OS-level drop so
    // isConnected turns false even when nobody called disconnect().
    device.addEventListener('gattserverdisconnected', () => { this.gone = true; });
  }

  get deviceName(): string {
    return this.device.name || 'Bluetooth printer';
  }

  get isConnected(): boolean {
    return !this.gone && this.server.connected;
  }

  disconnect(): void {
    this.gone = true;
    try { this.server.disconnect(); } catch { /* already dropped — fine */ }
  }

  /**
   * Send raw ESC/POS bytes, chunked to CHUNK_SIZE with CHUNK_DELAY_MS
   * between chunks (see the WHY on those constants — printer RX buffers
   * overflow silently otherwise). writeWithoutResponse is preferred: it's
   * what these printers are built for and ~5× faster than acknowledged
   * writes on a long receipt.
   */
  async printRaw(bytes: Uint8Array): Promise<void> {
    if (!this.isConnected) throw new Error('Printer is not connected — reconnect and try again');
    const ch = this.characteristic;
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
      if (ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse) {
        await ch.writeValueWithoutResponse(chunk);
      } else if (ch.writeValueWithResponse) {
        await ch.writeValueWithResponse(chunk);
      } else {
        // Deprecated writeValue: only path on older Chromium builds.
        await ch.writeValue(chunk);
      }
      if (i + CHUNK_SIZE < bytes.length) await sleep(CHUNK_DELAY_MS);
    }
  }

  /** Short self-test ticket so the owner can verify pairing in one tap. */
  async printTest(): Promise<void> {
    const lines = [
      ...centerLines('NamastePOS test print'),
      ...centerLines(`${formatIstDateTime(new Date())} IST`),
    ];
    await this.printRaw(frameEscpos(lines));
  }

  /**
   * Print a full receipt from the same PrintReceiptOptions object the HTML
   * popup printer (receiptPrint.printReceipt) consumes — callers build the
   * options once and choose the output device at the end.
   */
  async printReceiptEscpos(opts: PrintReceiptOptions): Promise<void> {
    await this.printRaw(frameEscpos(buildReceiptLines(opts)));
  }
}

// ── Connect flow ────────────────────────────────────────────────────────────

/**
 * Open the browser's Bluetooth chooser and wire up the first writable
 * characteristic. MUST be called from a user gesture (click handler) —
 * Chromium rejects requestDevice() otherwise.
 *
 * WHY acceptAllDevices + optionalServices (2026-08-25): filtering the
 * chooser by service UUID hides printers that don't ADVERTISE their serial
 * service (many only expose it after connect), so we show everything and
 * declare the four candidate services for post-connect access instead.
 * WHY "first writable characteristic": BLE-serial printers expose exactly
 * one write pipe; probing properties beats hardcoding per-brand
 * characteristic UUIDs, which is the hardcoding trap we avoid project-wide.
 */
export async function connectBtPrinter(): Promise<BtPrinter> {
  const bluetooth = (navigator as NavigatorWithBluetooth).bluetooth;
  if (!bluetooth) {
    throw new Error('Web Bluetooth is not supported in this browser — use Chrome or Edge over HTTPS');
  }

  const device = await bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: PRINTER_SERVICE_UUIDS,
  });
  if (!device.gatt) {
    throw new Error(`"${device.name || 'Device'}" does not support GATT connections`);
  }

  const server = await device.gatt.connect();
  try {
    // getPrimaryServices() only returns services covered by optionalServices —
    // i.e. exactly our four candidates when the printer implements any of them.
    const services = await server.getPrimaryServices();
    for (const service of services) {
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        chars = await service.getCharacteristics();
      } catch {
        continue; // service exposes nothing readable — try the next one
      }
      const writable = chars.find(
        (c) => c.properties.writeWithoutResponse || c.properties.write,
      );
      if (writable) return new BtPrinter(device, server, writable);
    }
    throw new Error(
      `"${device.name || 'Device'}" has no writable print service — it may not be a BLE thermal printer`,
    );
  } catch (e) {
    // Don't strand a half-open GATT link: the printer would refuse the next
    // connect attempt until it times out or power-cycles.
    try { server.disconnect(); } catch { /* already dropped */ }
    throw e;
  }
}

// ── Shared singleton ────────────────────────────────────────────────────────
// WHY module-level (2026-08-25): a BLE link dies if its BtPrinter is garbage-
// collected with the page component. Module state lives for the whole SPA
// session, so the connection survives navigating away from /printers and
// back — the owner pairs once, then prints from any page.
let sharedBtPrinter: BtPrinter | null = null;

export function getSharedBtPrinter(): BtPrinter | null {
  // Drop stale handles (printer powered off / walked out of range) so the UI
  // never shows a green dot for a dead link.
  if (sharedBtPrinter && !sharedBtPrinter.isConnected) sharedBtPrinter = null;
  return sharedBtPrinter;
}

export function setSharedBtPrinter(p: BtPrinter | null): void {
  if (sharedBtPrinter && sharedBtPrinter !== p) sharedBtPrinter.disconnect();
  sharedBtPrinter = p;
}
