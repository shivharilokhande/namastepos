// NamastePOS Print Agent (FF-302 / R-PRT-1)
//
// This is a small standalone Node daemon a restaurant runs on a PC inside
// their LAN. It polls the NamastePOS backend for queued print jobs, sends
// the ESC/POS bytes to the configured thermal printer, then reports back.
//
// Why a separate process? Browsers can't talk to LAN printers (TCP:9100
// is blocked from JS), so we need a local helper. Same pattern as PetPooja
// Print Helper, Petpooja Bridge, or Zomato Print Manager.

require('dotenv').config();
const axios = require('axios');
const net = require('net');
const fs = require('fs');
const path = require('path');

const {
  // Hardcode-audit fix (2026-08-24): default was :3000 while every other
  // component (backend, dashboard, tests) uses :4000 — a fresh install
  // without FF_API_URL silently polled a dead port.
  FF_API_URL = 'http://localhost:4000',
  FF_AGENT_TOKEN,
  FF_BUSINESS_ID,
  FF_PRINTER_TRANSPORT = 'file',
  FF_PRINTER_HOST = '192.168.1.50',
  FF_PRINTER_PORT = '9100',
  FF_PRINTER_DEVICE = '/dev/rfcomm0',
  FF_PRINTER_FILE = './out/print.bin',
  FF_POLL_INTERVAL_MS = '2000',
} = process.env;

if (!FF_AGENT_TOKEN || !FF_BUSINESS_ID) {
  console.error('[print-agent] FATAL: set FF_AGENT_TOKEN and FF_BUSINESS_ID in .env');
  process.exit(1);
}

const http = axios.create({
  baseURL: `${FF_API_URL.replace(/\/$/, '')}/v1/businesses/${FF_BUSINESS_ID}`,
  headers: { Authorization: `Bearer ${FF_AGENT_TOKEN}` },
  timeout: 8000,
});

// ── Transports ─────────────────────────────────────────────────────────
// Each transport accepts raw bytes (Buffer) and returns a Promise<void>.

function sendNetwork(bytes) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { client.destroy(); } catch (_) {}
      err ? reject(err) : resolve();
    };
    client.setTimeout(5000, () => finish(new Error('TCP timeout')));
    client.on('error', finish);
    client.connect(parseInt(FF_PRINTER_PORT, 10), FF_PRINTER_HOST, () => {
      client.write(bytes, () => finish(null));
    });
  });
}

function sendBluetooth(bytes) {
  // For desktops on Linux/macOS, set up rfcomm bind first (system-specific):
  //   sudo rfcomm bind /dev/rfcomm0 AA:BB:CC:DD:EE:FF 1
  // Then this just writes to that character device.
  return new Promise((resolve, reject) => {
    fs.writeFile(FF_PRINTER_DEVICE, bytes, (err) => err ? reject(err) : resolve());
  });
}

function sendFile(bytes) {
  // Useful for testing — keeps growing the output file.
  const outDir = path.dirname(FF_PRINTER_FILE);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  return new Promise((resolve, reject) => {
    fs.appendFile(FF_PRINTER_FILE, bytes, (err) => err ? reject(err) : resolve());
  });
}

const transports = { network: sendNetwork, bt: sendBluetooth, file: sendFile };
const send = transports[FF_PRINTER_TRANSPORT];
if (!send) {
  console.error(`[print-agent] FATAL: unknown FF_PRINTER_TRANSPORT=${FF_PRINTER_TRANSPORT}`);
  process.exit(1);
}

// ── ESC/POS fallback formatter ─────────────────────────────────────────
// If the job comes back as plain text (no escpos bytes), wrap it with init
// + center alignment + 2x lines + a cut at the end. The backend usually
// sends pre-baked ESC/POS via printerService, but be defensive.
function wrapText(text) {
  const ESC = 0x1B, GS = 0x1D;
  const out = [];
  out.push(Buffer.from([ESC, 0x40])); // init
  out.push(Buffer.from(text, 'utf8'));
  out.push(Buffer.from('\n\n\n', 'utf8'));
  out.push(Buffer.from([GS, 0x56, 66, 0])); // partial cut
  return Buffer.concat(out);
}

// ── Polling loop ───────────────────────────────────────────────────────
async function pollOnce() {
  let job;
  try {
    const r = await http.get('/print-jobs/next');
    job = r.data?.job;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      console.error('[print-agent] auth failed — check FF_AGENT_TOKEN');
    } else {
      console.warn('[print-agent] poll failed:', err.message);
    }
    return;
  }
  if (!job) return; // nothing queued — quiet

  console.log(`[print-agent] job ${job.id} · ${job.kind || 'unknown'} (${(job.escposBase64 || job.text || '').length} bytes)`);

  let bytes;
  if (job.escposBase64) {
    bytes = Buffer.from(job.escposBase64, 'base64');
  } else if (job.escposHex) {
    bytes = Buffer.from(job.escposHex, 'hex');
  } else if (job.text) {
    bytes = wrapText(job.text);
  } else {
    console.warn('[print-agent] job has no payload — marking failed');
    await http.post(`/print-jobs/${job.id}/done`, { ok: false, errorMessage: 'empty payload' }).catch(() => {});
    return;
  }

  try {
    await send(bytes);
    await http.post(`/print-jobs/${job.id}/done`, { ok: true });
    console.log(`[print-agent] ✓ printed ${job.id}`);
  } catch (err) {
    console.error(`[print-agent] ✗ failed ${job.id}:`, err.message);
    try {
      await http.post(`/print-jobs/${job.id}/done`, {
        ok: false,
        errorMessage: err.message.slice(0, 240),
      });
    } catch (_) {}
  }
}

console.log(`[print-agent] starting — transport=${FF_PRINTER_TRANSPORT} target=${
  FF_PRINTER_TRANSPORT === 'network' ? `${FF_PRINTER_HOST}:${FF_PRINTER_PORT}` :
  FF_PRINTER_TRANSPORT === 'bt' ? FF_PRINTER_DEVICE : FF_PRINTER_FILE
} poll=${FF_POLL_INTERVAL_MS}ms`);

setInterval(pollOnce, parseInt(FF_POLL_INTERVAL_MS, 10));
// Run one immediately so first print happens fast at boot
pollOnce();
