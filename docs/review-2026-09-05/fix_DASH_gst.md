# fix_DASH_gst — web POS recorded ₹0 GST on every order (P0, 2026-09-05)

Scope respected: no git, edits only under `namastepos_dashboard/`.

## DASH-GST → FIXED

### Root cause
`NewOrderDialog.tsx` had a manual "Tax (₹)" input backed by `useState(0)` and sent `tax` in the
`POST /orders` body. An explicit `0` is honoured by the backend as a client assertion, so every
web order was persisted with ₹0 GST unless the cashier typed a number.

### Files changed
1. `namastepos_dashboard/src/lib/gstEstimate.ts` — **new** (pure helper). `estimateGst(lines, gstScheme)` is a
   line-for-line port of `namastepos_backend/src/services/gstService2.js#computeGstBreakdown` (intra-state path:
   bucket by slab, `round2(taxable×pct/100)`, CGST = `round2(gst/2)`, SGST = remainder, 2-dp totals). Returns all
   zeros when `schemeChargesNoGst(gstScheme)` (i.e. `composition`, mirroring `gstSchemeService.chargesNoGst`).
2. `namastepos_dashboard/src/components/NewOrderDialog.tsx`
   - Removed the `tax` state and the "Tax (₹)" `<Input>`; replaced with a one-line hint ("GST is added from each
     item's slab" / "Composition scheme — bill of supply, no GST").
   - `CartLine` gains `gstPct?: number | null`. `addItem()` (plain items, upsell strip, voice) and
     `ItemConfigDialog.onConfirm()` (variant + modifier lines) now carry the **parent** item's `gstPct` — the server
     applies `mi.gst_pct` to the variant+modifier line price, so variants inherit the parent slab.
   - `gst = useMemo(estimateGst(cart lines, gstScheme))`; `tax = gst.totalGst`;
     `total = max(0, subtotal − discount) + tax` (exactly what `orderService` does when `tax` is omitted:
     GST is computed on RAW line amounts and added to the discounted base). `payableTotal`, split-leg
     `splitRemaining`, wallet auto-apply and points cap all flow from this, so the cashier collects the
     GST-inclusive amount.
   - `gstScheme` read from the shared `useMe()` query (`me.business.gstScheme`) with `getBusinessCache()?.gstScheme`
     fallback, default `'regular'` (same as server).
   - Totals panel: "CGST (est.)" and "SGST (est.)" rows (hidden when 0 / composition). Footer buttons already show
     the GST-inclusive total.
   - Create body: `tax` **omitted entirely** (not 0). `discount`, `discountIsPreTax` unchanged.
   - `onSuccess`: uses the SERVER order — toast shows `o.total`; a `toast.warning` fires if the server total
     differs from the client estimate by > ₹0.01 so the cashier collects the billed figure. `trackFirstBill`
     already used `o.total` / `o.paymentMethod`.
3. `namastepos_dashboard/src/api/namastepos.ts` — added `GstScheme` type and `MeBusiness` interface
   (`id`, `gstScheme?`, index signature) and typed `MeResponse.business` with it (was `any`; index signature keeps
   every other consumer compiling).

### Other order-creation sites (item 4)
Grepped `createOrder`, `api.post(...orders`, `tax:`, `addToSession`, `TablesPage`, `CaptainPage`, `BillSplitDialog`,
`GuestBillPanel`. **`NewOrderDialog` is the only dashboard creator of orders** (`ffApi.createOrder` has one call site;
TablesPage/CaptainPage/OrdersPage all render `NewOrderDialog`). TablesPage settle/print and BillSplitDialog use the
SERVER session totals (`session.taxInr/cgstInr/sgstInr`) — no hardcoded `tax: 0` anywhere else. No further edits needed.

### Test added / verification
- **Parity test** (regression for the estimate): transpiled `gstEstimate.ts` with tsc and ran it against the real backend
  `computeGstBreakdown` over 20,000 seeded random carts (1–6 lines, slabs 0/5/12/18/28/null/undefined, prices to the
  paisa, qty 1–5) + composition-scheme zero check + a hand vector (2×₹250@5% + 1×₹99@18% → CGST 21.41 / SGST 21.41 /
  total 42.82): `cases=20002 fails=0`, exit 0. (Dashboard has no vitest; script lives outside the repo — the helper is a
  pure function so it can be dropped into a vitest file verbatim if one is added.)
- `cd namastepos_dashboard && npx tsc --noEmit -p .` → exit 0
- `npm run lint` → exit 0, **0 errors** (549 warnings, all pre-existing incl. the unused `Card`/`CardContent` import in
  this file)
- `npm run build` → exit 0 (`✓ built in 3.87s`)
- Backend contract confirmed read-only: `orderController.js:66` `tax: Joi.number().min(0).allow(null)` (optional, no
  default) and `orderService.js:254/981` `taxOmitted` → adopt server GST in every mode.

### Manual check for the orchestrator (post-deploy)
Open POS → add a 5% item + an 18% variant item → panel shows CGST/SGST (est.) rows and a GST-inclusive total; place
with a split payment → server accepts (legs sum within ±₹0.01) and the returned order has non-zero `tax/cgst/sgst`.
On a business with `gst_scheme='composition'` no GST rows appear and the total equals subtotal − discount.

### Notes / not done
- The "Discount before tax" checkbox is now display-inert (GST is added on top of the discounted base either way,
  matching the server's omitted-tax path). Left in place per the brief ("keep `discountIsPreTax` as is"); removing it
  is a one-line follow-up if wanted.
- The estimate assumes intra-state (CGST+SGST); the dialog never sends `isInterState`, same as before.
- Item-level `gstPct` is NOT added to the request items (the omitted-tax path already yields the server figure and the
  Joi item schema was not checked for that key).

### Needs orchestrator
None — all edits inside `namastepos_dashboard/`.

### Needs founder
None.
