# Starter menu templates (seed data, NOT a migration)

One JSON file per template. `menuTemplateService` reads this directory once at
boot and serves it from `GET /businesses/:id/menu/templates`.

## Why a JSON asset and not a migration

- The rows are **product content**, not tenant data. Nothing here belongs to a
  business until an owner taps "Load this menu", at which point the rows are
  written through the ordinary `menuService.bulkImport` path and become normal
  `menu_items` rows owned by that business.
- Migrations in this repo are **forward-only** (`npm run migrate:rollback` is a
  deliberate error). A price typo in a seeded table would need a second
  migration to correct, in every environment, forever. Here it is a one-line
  edit reviewed like any other code change.
- Every environment (dev, test, prod, a founder's laptop) gets the identical
  list with no DB drift and no ~300 extra rows per database.
- No query per page view: the picker is a file read that is cached in process.

## File shape

```json
{
  "slug": "tea-stall",            // URL-safe id, stable forever
  "name": "Tea Stall & Snacks",   // shown in the picker
  "tagline": "One line the owner recognises themselves in",
  "format": "counter",            // counter | dine_in | delivery — a hint only
  "defaultGstPct": 5,             // applied to every item without an override
  "defaultHsnCode": "996331",     // restaurant service SAC
  "notes": ["Shown under the picker, verbatim."],
  "items": [
    { "name": "Cutting Chai", "price": 12, "category": "Chai", "isVeg": true }
  ]
}
```

Per-item `gstPct` / `hsnCode` override the template defaults. That is how the
bar template carries alcohol lines at 0% — liquor is **outside GST** (state
excise / VAT), so a 5% GST line on a beer would be a wrong tax invoice.

## Rules for adding or editing a template

1. **Max 40 items.** Starter is 60 menu items (verified live against
   `GET /v1/public/plans`), so a template plus a handful of the owner's own
   dishes has to fit inside 60 with room to spare.
2. Prices are plausible mid-market Indian prices in whole rupees. They are a
   starting point the owner edits, never a claim.
3. `category` values are short and few (6-9 per template) — they become the
   POS grid's tabs and a long list is unusable on a phone.
4. GST stays the standard 5% restaurant-service rate unless the item is
   genuinely something else. If you are not sure, it is 5% and the note under
   the picker tells the owner to confirm with their CA.
5. No competitor names, no brand names in item names.
