# NamastePOS Print Agent

A tiny Node daemon that runs on a restaurant's local PC. It polls the NamastePOS backend for queued print jobs (KOT, bill, token) and pushes the ESC/POS bytes to a thermal printer over LAN (TCP:9100), Bluetooth (rfcomm), or to a file (for testing).

## Why a separate process?
Browsers can't open raw TCP sockets to a 192.168.x.x printer — same reason PetPooja, Posist and Zomato all ship a local bridge.

## Quick start
```bash
cd namastepos_print_agent
cp .env.example .env
# Edit .env — set FF_BUSINESS_ID, FF_AGENT_TOKEN, FF_PRINTER_HOST
npm install
npm start
```

## Transports
- `network` — raw TCP to the printer IP on port 9100 (Epson, Star, most cheap rebadged Chinese printers)
- `bt`      — write to a bound rfcomm device, e.g. `/dev/rfcomm0`
- `file`    — append bytes to a file; great for dev when you don't have hardware

## Issuing an agent token
Settings → Printers → "Generate agent token" → paste into `.env`. Token is scoped to your business and the print-job endpoints only.

## Running as a service
On Linux, install as a systemd unit. On Windows, use nssm. On macOS, use launchd.
