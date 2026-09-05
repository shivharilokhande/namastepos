---
tags: [namastepos, money]
---
# GST and Money

- Money is **paise integers** in the DB (`*_paise`), `round2` rupees on the wire. Never float-multiply prices.
- GST slab per menu item: `menu_items.gst_pct` (default 5; composition-scheme businesses default 0). Intra-state CGST+SGST split is the **correct default** for restaurants; `isInterState` opts into IGST.
- `gstService2.computeGstBreakdown` is the one implementation. Ports: dashboard `src/lib/gstEstimate.ts`, mobile `lib/utils/gst.dart` (tests generated from the backend numbers).
- **Who computes tax on an order (since 2026-09-05):** an **omitted** `tax` in `POST /orders` means "server computes from the menu"; an explicit `0` is a client assertion (honoured in `ORDER_TAX_ENFORCE=log`, overridden in `enforce`). Both tills omit it and show CGST/SGST as an estimate; receipts print from the server's returned order row.
- `order_items.gst_pct / gst_amount` are written on create (paise-exact allocation, remainder on the heaviest line). Tax invoices read them; legacy rows fall back to `orders.tax`; invoice total == order total.
- Composition scheme (`businesses.gst_scheme`, mig 092): bill of supply, no GST rows, overrides the menu.
- GSTR-1/3B CSV: `gstrExportService.js` on the real `tax_invoices` schema (`*_paise`, `recipient_*`, `businesses.state_code`).
- E-invoice / e-way: production **refuses** until GSP/IRP credentials exist (no fake IRNs); non-prod emits `DEMO-NOT-A-VALID-IRN-…`.
- Subscription invoices (our own GST invoice PDF): `platform.gstin` set in super-admin, `sgst = tax - cgst`.
