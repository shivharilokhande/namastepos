// "Switch to NamastePOS" migration wizard (2026-09-03).
//
// A 5-step guided import for restaurants moving over from another POS:
//   1. Menu               → POST /menu/bulk           (supports variant rows)
//   2. Customers & balances → POST /imports/customers (loyalty + wallet openings)
//   3. Sales history      → POST /imports/sales-history (one aggregate order/day)
//   4. Expenses           → POST /imports/expenses
//   5. Done               → reconciliation summary
//
// Every step: explainer → template CSV → file pick (parsed client-side via
// the shared @/lib/csv parser) → column mapping (auto-mapped by fuzzy header
// match, overridable) → 5-row preview → chunked import (500 rows/POST) with
// a progress bar and an Excel-line-accurate error/warning table.
//
// All imports are idempotent server-side (re-runs upsert profiles, skip
// already-booked balances / already-imported dates with warnings), so "run
// it again after fixing the failed rows" is always safe. Copy never names
// other POS products — house rule: it's always "your old POS".

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRightLeft, ArrowLeft, ArrowRight, Upload, Download, CheckCircle2,
  AlertTriangle, Info, UtensilsCrossed, Users, TrendingUp, Receipt,
  PartyPopper,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { parseCsv, downloadCsv, type CsvRow } from '@/lib/csv';

// ── Types ────────────────────────────────────────────────────────────────

interface RowIssue { row: number | string; text: string }
interface StepResult {
  imported: number;
  failed: RowIssue[];
  warnings: RowIssue[];
  /** step-specific extras for the reconciliation card */
  extra?: { variants?: number; revenueInr?: number };
}

interface FieldSpec {
  key: string;          // API row key this field maps to
  label: string;
  required?: boolean;
  synonyms: string[];   // normalised (lowercase snake_case) header candidates
  hint?: string;
}

interface StepConfig {
  key: 'menu' | 'customers' | 'sales' | 'expenses';
  title: string;
  icon: typeof Upload;
  explainer: string;
  exportHint: string;
  templateName: string;
  templateCsv: string;
  fields: FieldSpec[];
  chunkSize: number;
  /** POST one chunk; returns a normalised report with rows RELATIVE to the chunk */
  submitChunk: (rows: Record<string, string>[]) => Promise<StepResult>;
  /** turn one parsed CSV row into the API row shape using the header mapping */
  shape: (row: CsvRow, mapping: Record<string, string>) => Record<string, string>;
}

// ── Small value normalisers ──────────────────────────────────────────────

const normPhone = (v: string): string => {
  let d = (v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
};
const normNumber = (v: string): string => (v || '').replace(/[₹,%\s,]/g, '');
const normBool = (v: string): string => {
  const s = (v || '').trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'veg'].includes(s)) return 'true';
  if (['no', 'n', 'false', '0', 'non veg', 'non-veg', 'nonveg'].includes(s)) return 'false';
  return v;
};
// dd-mm-yyyy / dd/mm/yyyy → yyyy-mm-dd (legacy exports love day-first)
const normDate = (v: string): string => {
  const m = (v || '').trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return (v || '').trim();
};

// Generic shaper: pick each mapped header's cell, drop blanks, apply an
// optional per-field transform.
function shapeWith(
  fields: FieldSpec[],
  transforms: Record<string, (v: string) => string> = {},
) {
  return (row: CsvRow, mapping: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const f of fields) {
      const header = mapping[f.key];
      if (!header) continue;
      let v = row[header];
      if (v === undefined || v === '') continue;
      if (transforms[f.key]) v = transforms[f.key](v);
      if (v !== '') out[f.key] = v;
    }
    return out;
  };
}

// ── Step configs ─────────────────────────────────────────────────────────

const MENU_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Item name', required: true,
    synonyms: ['item_name', 'name', 'item', 'dish', 'dish_name', 'product_name', 'product'] },
  { key: 'price', label: 'Selling price (₹)', required: true,
    synonyms: ['selling_price', 'price', 'rate', 'mrp', 'sale_price', 'amount', 'online_price'] },
  { key: 'category', label: 'Category',
    synonyms: ['category', 'item_category', 'group', 'category_name', 'menu_category'] },
  { key: 'gst_pct', label: 'GST %',
    synonyms: ['gst_pct', 'gst', 'gst_%', 'tax', 'tax_slab', 'tax_%', 'gst_rate'] },
  { key: 'hsn_code', label: 'HSN code', synonyms: ['hsn_code', 'hsn', 'sac'] },
  { key: 'is_veg', label: 'Veg?', synonyms: ['veg', 'is_veg', 'food_type', 'veg_nonveg', 'diet'] },
  { key: 'description', label: 'Description', synonyms: ['description', 'desc', 'details'] },
  { key: 'sku', label: 'SKU / short code', synonyms: ['sku', 'short_code', 'item_code', 'code'] },
  { key: 'variant_name', label: 'Variant name', hint: 'e.g. Half / Full — repeat the item name on variant rows',
    synonyms: ['variant_name', 'variant', 'variation', 'size', 'portion'] },
  { key: 'variant_price', label: 'Variant price (₹)',
    synonyms: ['variant_price', 'variation_price', 'size_price', 'portion_price'] },
];

const CUSTOMER_FIELDS: FieldSpec[] = [
  { key: 'phone', label: 'Phone (10-digit)', required: true,
    synonyms: ['phone', 'mobile', 'phone_no', 'mobile_no', 'mobile_number', 'phone_number', 'contact', 'contact_no'] },
  { key: 'name', label: 'Name', synonyms: ['name', 'customer_name', 'full_name'] },
  { key: 'email', label: 'Email', synonyms: ['email', 'email_id', 'mail'] },
  { key: 'tags', label: 'Tags', synonyms: ['tags', 'tag', 'segment', 'labels'] },
  { key: 'whatsappOptIn', label: 'WhatsApp opt-in',
    synonyms: ['whatsapp_opt_in', 'whatsapp_optin', 'whatsapp', 'wa_optin', 'opt_in'] },
  { key: 'loyaltyPoints', label: 'Loyalty points',
    synonyms: ['loyalty_points', 'points', 'points_balance', 'loyalty_balance', 'loyalty'] },
  { key: 'walletBalanceInr', label: 'Wallet / khata balance (₹)',
    synonyms: ['wallet_balance_inr', 'wallet_balance', 'wallet', 'khata_balance', 'khata', 'advance', 'balance'] },
  { key: 'notes', label: 'Notes', synonyms: ['notes', 'note', 'remarks', 'comment'] },
];

const SALES_FIELDS: FieldSpec[] = [
  { key: 'date', label: 'Date (YYYY-MM-DD)', required: true,
    synonyms: ['date', 'bill_date', 'order_date', 'business_date', 'day'] },
  { key: 'orders', label: 'No. of orders', required: true,
    synonyms: ['orders', 'no_of_orders', 'order_count', 'bills', 'no_of_bills', 'invoices', 'covers'] },
  { key: 'grossInr', label: 'Gross sales (₹)', required: true,
    synonyms: ['gross_inr', 'gross', 'gross_sales', 'gross_amount', 'total_sales', 'sales', 'revenue', 'total'] },
  { key: 'discountInr', label: 'Discount (₹)',
    synonyms: ['discount_inr', 'discount', 'discounts', 'total_discount'] },
  { key: 'taxInr', label: 'Tax / GST (₹)',
    synonyms: ['tax_inr', 'tax', 'gst', 'total_tax', 'gst_amount', 'tax_amount'] },
];

const EXPENSE_FIELDS: FieldSpec[] = [
  { key: 'date', label: 'Date (YYYY-MM-DD)', required: true,
    synonyms: ['date', 'expense_date', 'bill_date', 'day'] },
  { key: 'amount', label: 'Amount (₹)', required: true,
    synonyms: ['amount', 'amt', 'value', 'total', 'expense_amount'] },
  { key: 'category', label: 'Category',
    synonyms: ['category', 'expense_category', 'type', 'head'] },
  { key: 'description', label: 'Description',
    synonyms: ['description', 'details', 'remarks', 'note', 'notes', 'particulars'] },
];

// Menu errors come back as { row: 1-based DATA index, name, message } from
// /menu/bulk — convert to CSV file lines (+1 for the header) here; the
// /imports/* endpoints already report file lines.
const menuSubmit = async (rows: Record<string, string>[]): Promise<StepResult> => {
  const r = await ffApi.bulkImportMenu(rows);
  return {
    imported: r.inserted ?? 0,
    failed: (r.errors ?? []).map((e: { row: number; name?: string; message: string }) => ({
      row: e.row + 1,
      text: e.name ? `${e.name}: ${e.message}` : e.message,
    })),
    warnings: [],
    extra: { variants: r.variants ?? 0 },
  };
};

const importsSubmit = (fn: (rows: any[]) => Promise<any>) =>
  async (rows: Record<string, string>[]): Promise<StepResult> => {
    const r = await fn(rows);
    return {
      imported: r.imported ?? 0,
      failed: (r.failed ?? []).map((f: { row: number; error: string }) => ({ row: f.row, text: f.error })),
      warnings: (r.warnings ?? []).map((w: { row: number; warning: string }) => ({ row: w.row, text: w.warning })),
    };
  };

const STEPS: StepConfig[] = [
  {
    key: 'menu',
    title: 'Menu',
    icon: UtensilsCrossed,
    explainer: 'Bring your full menu across — items, categories, prices, GST slabs and portion variants (Half/Full, sizes).',
    exportHint: 'In your old POS: Admin → Menu (or Items) → Export as CSV/Excel. Save as CSV. For variants, repeat the item name on extra rows with the variant name and price.',
    templateName: 'namastepos-menu-template.csv',
    templateCsv: `Item Name,Category,Selling Price,GST Pct,HSN Code,Veg,Description,Variant Name,Variant Price
Paneer Butter Masala,Main Course,280,5,,yes,Rich tomato gravy,,
Paneer Butter Masala,Main Course,280,5,,yes,,Half,180
Masala Dosa,South Indian,120,5,,yes,Crisp dosa with potato filling,,`,
    fields: MENU_FIELDS,
    chunkSize: 500,
    submitChunk: menuSubmit,
    shape: shapeWith(MENU_FIELDS, {
      price: normNumber, gst_pct: normNumber, variant_price: normNumber, is_veg: normBool,
    }),
  },
  {
    key: 'customers',
    title: 'Customers & balances',
    icon: Users,
    explainer: 'Import your customer list with loyalty points and wallet/khata balances as of today. Balances are booked once through the proper ledgers — re-running never double-credits.',
    exportHint: 'In your old POS: CRM (or Customers) → Export CSV. If loyalty/wallet balances export separately, merge them into one sheet by phone number first.',
    templateName: 'namastepos-customers-template.csv',
    templateCsv: `Phone,Name,Email,Tags,WhatsApp Opt In,Loyalty Points,Wallet Balance INR,Notes
9876543210,Asha Sharma,asha@example.com,"vip,regular",yes,120,250.50,Prefers window seat
9812345678,Rahul Verma,,walk-in,no,0,0,`,
    fields: CUSTOMER_FIELDS,
    chunkSize: 500,
    submitChunk: importsSubmit(ffApi.importCustomers),
    shape: shapeWith(CUSTOMER_FIELDS, {
      phone: normPhone, loyaltyPoints: normNumber,
      walletBalanceInr: normNumber, whatsappOptIn: normBool,
    }),
  },
  {
    key: 'sales',
    title: 'Sales history',
    icon: TrendingUp,
    explainer: 'Keep your old sales for reference — one summary row per past day. Each day lands as a single aggregate order, so historical reports and revenue totals stay comparable. Already-imported dates are skipped automatically.',
    exportHint: 'In your old POS: Reports → Day-wise sales summary → Export CSV. One row per day with order count, gross sales, discount and tax. Up to 3 years (1100 days) per upload.',
    templateName: 'namastepos-sales-history-template.csv',
    templateCsv: `Date,Orders,Gross INR,Discount INR,Tax INR
2026-07-01,42,10500,500,500.25
2026-07-02,38,9800,0,466.67`,
    fields: SALES_FIELDS,
    chunkSize: 500,
    submitChunk: importsSubmit(ffApi.importSalesHistory),
    shape: shapeWith(SALES_FIELDS, {
      date: normDate, orders: normNumber, grossInr: normNumber,
      discountInr: normNumber, taxInr: normNumber,
    }),
  },
  {
    key: 'expenses',
    title: 'Expenses',
    icon: Receipt,
    explainer: 'Optionally bring past expenses (rent, gas, salaries…) so your P&L history is complete from day one.',
    exportHint: 'In your old POS: Expenses (or Cash Management) → Export CSV. Categories map to: ingredients, fuel, labor, rent, utilities, packaging, marketing, maintenance, chef_salary, helper_salary, staff_salary, gas, electricity, water, transport, equipment, cleaning, license_fees, other.',
    templateName: 'namastepos-expenses-template.csv',
    templateCsv: `Date,Category,Amount,Description
2026-08-01,gas,1200,Cylinder refill
2026-08-03,electricity,3400,July bill`,
    fields: EXPENSE_FIELDS,
    chunkSize: 500,
    submitChunk: importsSubmit(ffApi.importExpenses),
    shape: shapeWith(EXPENSE_FIELDS, { date: normDate, amount: normNumber }),
  },
];

// Fuzzy auto-map: exact normalised match first, then substring either way.
function autoMap(headers: string[], fields: FieldSpec[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const taken = new Set<string>();
  for (const f of fields) {
    let hit = headers.find((h) => !taken.has(h) && f.synonyms.includes(h));
    if (!hit) {
      hit = headers.find((h) => !taken.has(h) &&
        f.synonyms.some((s) => h.includes(s) || (s.length >= 4 && s.includes(h))));
    }
    if (hit) { mapping[f.key] = hit; taken.add(hit); }
  }
  return mapping;
}

const inr = (n: number) =>
  `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// ── One import step ──────────────────────────────────────────────────────

function ImportStep({ config, onResult, result }: {
  config: StepConfig;
  onResult: (r: StepResult) => void;
  result: StepResult | null;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const headers = useMemo(() => (rows[0] ? Object.keys(rows[0]) : []), [rows]);

  const onPick = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseCsv(reader.result as string);
        if (parsed.length === 0) {
          toast.error('CSV is empty. Add at least one row below the header.');
          return;
        }
        setRows(parsed);
        setMapping(autoMap(Object.keys(parsed[0]), config.fields));
        setProgress(null);
      } catch (err) {
        toast.error(`Couldn't read the CSV — ${err instanceof Error ? err.message : 'parse error'}`);
      }
    };
    reader.onerror = () => toast.error("Couldn't read the file.");
    reader.readAsText(file);
  };

  const missingRequired = config.fields.filter((f) => f.required && !mapping[f.key]);
  const shaped = useMemo(
    () => rows.map((r) => config.shape(r, mapping)),
    [rows, mapping, config],
  );

  const runImport = useMutation({
    mutationFn: async (): Promise<StepResult> => {
      const total = Math.ceil(shaped.length / config.chunkSize);
      setProgress({ done: 0, total });
      const acc: StepResult = { imported: 0, failed: [], warnings: [], extra: {} };
      let netImportedInr = 0;
      for (let c = 0; c < total; c++) {
        const offset = c * config.chunkSize;
        const chunk = shaped.slice(offset, offset + config.chunkSize);
        const rep = await config.submitChunk(chunk);
        acc.imported += rep.imported;
        // Backend rows are CSV lines RELATIVE to the chunk (data from line 2)
        // — shift by the chunk offset so they match the real file.
        const shift = (x: RowIssue): RowIssue =>
          typeof x.row === 'number' ? { ...x, row: x.row + offset } : x;
        const failedHere = rep.failed.map(shift);
        const warnedHere = rep.warnings.map(shift);
        acc.failed.push(...failedHere);
        acc.warnings.push(...warnedHere);
        if (rep.extra?.variants) {
          acc.extra!.variants = (acc.extra!.variants ?? 0) + rep.extra.variants;
        }
        if (config.key === 'sales') {
          // Reconciliation: net revenue actually imported = Σ (gross − discount)
          // over chunk rows minus the failed/skipped lines.
          const bad = new Set([...failedHere, ...warnedHere].map((x) => x.row));
          chunk.forEach((row, i) => {
            const line = offset + i + 2;
            if (bad.has(line)) return;
            netImportedInr += (Number(row.grossInr) || 0) - (Number(row.discountInr) || 0);
          });
        }
        setProgress({ done: c + 1, total });
      }
      if (config.key === 'sales') acc.extra!.revenueInr = Math.round(netImportedInr * 100) / 100;
      return acc;
    },
    onSuccess: (r) => {
      onResult(r);
      qc.invalidateQueries({ queryKey: ['menu'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['expenses'] });
      if (r.imported > 0) {
        toast.success(`Imported ${r.imported} row${r.imported === 1 ? '' : 's'}`
          + (r.failed.length ? ` · ${r.failed.length} failed` : '')
          + (r.warnings.length ? ` · ${r.warnings.length} skipped` : ''));
      } else if (r.warnings.length > 0 && r.failed.length === 0) {
        toast.info('Nothing new to import — these rows were already imported earlier.');
      } else {
        toast.error(`No rows imported — ${r.failed.length} failed. See the report below.`);
      }
    },
    onError: (e) => { setProgress(null); toast.error(apiError(e)); },
  });

  const previewFields = config.fields.filter((f) => mapping[f.key]);
  const preview = shaped.slice(0, 5);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <config.icon className="h-4 w-4 text-primary" /> {config.title}
          </CardTitle>
          <CardDescription>{config.explainer}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start gap-2 text-sm rounded-md border bg-muted/40 p-3">
            <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">{config.exportHint}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline"
                    onClick={() => downloadCsv(config.templateName, config.templateCsv)}>
              <Download className="mr-2 h-4 w-4" /> Download template CSV
            </Button>
            <Input type="file" accept=".csv,text/csv" className="max-w-xs"
                   onChange={(e) => onPick(e.target.files?.[0])} />
          </div>
        </CardContent>
      </Card>

      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Match your columns</CardTitle>
            <CardDescription>
              We matched your CSV headers automatically — fix any that look wrong.
              {rows.length} row{rows.length === 1 ? '' : 's'} parsed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {config.fields.map((f) => (
                <label key={f.key} className="text-sm space-y-1">
                  <span className="font-medium">
                    {f.label}{f.required && <span className="text-destructive"> *</span>}
                  </span>
                  <select
                    className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                    value={mapping[f.key] ?? ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}>
                    <option value="">— not mapped —</option>
                    {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                  {f.hint && <span className="block text-xs text-muted-foreground">{f.hint}</span>}
                </label>
              ))}
            </div>
            {missingRequired.length > 0 && (
              <div className="text-sm text-amber-700 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Map the required column{missingRequired.length === 1 ? '' : 's'}:{' '}
                {missingRequired.map((f) => f.label).join(', ')}
              </div>
            )}

            {previewFields.length > 0 && (
              <div className="overflow-x-auto border rounded">
                <table className="text-xs w-full">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="p-2 text-left font-medium w-14">Line</th>
                      {previewFields.map((f) => (
                        <th key={f.key} className="p-2 text-left font-medium">{f.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="p-2 text-muted-foreground">{i + 2}</td>
                        {previewFields.map((f) => (
                          <td key={f.key} className="p-2">
                            {r[f.key] || <span className="text-muted-foreground">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows.length > 5 && (
              <div className="text-xs text-muted-foreground">Showing first 5 of {rows.length} rows</div>
            )}

            {progress && (
              <div className="space-y-1">
                <div className="h-2 rounded bg-muted overflow-hidden">
                  <div className="h-full bg-primary transition-all"
                       style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
                </div>
                <div className="text-xs text-muted-foreground">
                  Uploading batch {Math.min(progress.done + 1, progress.total)} of {progress.total}…
                </div>
              </div>
            )}

            <Button onClick={() => runImport.mutate()}
                    disabled={runImport.isPending || missingRequired.length > 0}>
              {runImport.isPending
                ? 'Importing…'
                : <><Upload className="mr-2 h-4 w-4" /> Import {rows.length} row{rows.length === 1 ? '' : 's'}</>}
            </Button>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className={result.failed.length > 0 ? 'border-amber-300' : 'border-emerald-300'}>
          <CardContent className="p-4 space-y-2 text-sm">
            <div className="flex items-center gap-2 font-semibold">
              {result.failed.length > 0
                ? <><AlertTriangle className="w-4 h-4 text-amber-600" /> Partial import</>
                : <><CheckCircle2 className="w-4 h-4 text-emerald-600" /> Imported</>}
            </div>
            <div>
              <strong>{result.imported}</strong> imported
              {result.extra?.variants ? <> · <strong>{result.extra.variants}</strong> variants</> : null}
              {result.warnings.length > 0 && <> · <strong>{result.warnings.length}</strong> skipped (already imported)</>}
              {result.failed.length > 0 && <> · <strong>{result.failed.length}</strong> failed</>}
            </div>
            {(result.failed.length > 0 || result.warnings.length > 0) && (
              <div className="overflow-x-auto border rounded">
                <table className="text-xs w-full">
                  <thead className="border-b">
                    <tr>
                      <th className="p-2 text-left font-medium w-16">Line</th>
                      <th className="p-2 text-left font-medium w-20">Kind</th>
                      <th className="p-2 text-left font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.failed.slice(0, 50).map((f, i) => (
                      <tr key={`f${i}`} className="border-b last:border-0">
                        <td className="p-2">{f.row}</td>
                        <td className="p-2 text-destructive">error</td>
                        <td className="p-2">{f.text}</td>
                      </tr>
                    ))}
                    {result.warnings.slice(0, 50).map((w, i) => (
                      <tr key={`w${i}`} className="border-b last:border-0">
                        <td className="p-2">{w.row}</td>
                        <td className="p-2 text-amber-600">skipped</td>
                        <td className="p-2">{w.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.failed.length > 50 && (
                  <div className="p-2 text-xs text-muted-foreground">
                    … and {result.failed.length - 50} more errors. Fix the CSV and re-upload —
                    re-running is safe, nothing gets double-imported.
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────

const STEP_LABELS = [...STEPS.map((s) => s.title), 'Done'];

export function MigrationPage() {
  const [step, setStep] = useState(0);
  const [results, setResults] = useState<Partial<Record<StepConfig['key'], StepResult>>>({});

  const isDone = step === STEPS.length;
  const active = isDone ? null : STEPS[step];
  const menu = results.menu; const customers = results.customers;
  const sales = results.sales; const expenses = results.expenses;
  const anythingImported = Object.values(results).some((r) => r && r.imported > 0);

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ArrowRightLeft className="h-6 w-6 text-primary" /> Switch to NamastePOS
        </h1>
        <p className="text-muted-foreground text-sm">
          Moving from another POS? Bring your menu, customers, balances and sales
          history over in four guided steps. Every step is safe to re-run — nothing
          is ever imported twice. You can keep your old POS running in parallel
          until you're confident.
        </p>
      </div>

      {/* Stepper */}
      <div className="flex flex-wrap items-center gap-1">
        {STEP_LABELS.map((label, i) => {
          const complete = i < STEPS.length && !!results[STEPS[i].key as StepConfig['key']];
          return (
            <button key={label} type="button" onClick={() => setStep(i)}
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border transition
                      ${i === step ? 'bg-primary text-primary-foreground border-primary'
                        : complete ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-background text-muted-foreground border-input'}`}>
              {complete
                ? <CheckCircle2 className="h-3.5 w-3.5" />
                : <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px]">{i + 1}</span>}
              {label}
            </button>
          );
        })}
      </div>

      {active && (
        <ImportStep key={active.key} config={active}
                    result={results[active.key] ?? null}
                    onResult={(r) => setResults((prev) => ({ ...prev, [active.key]: r }))} />
      )}

      {isDone && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <PartyPopper className="h-5 w-5 text-primary" />
              {anythingImported ? 'Migration summary' : 'Nothing imported yet'}
            </CardTitle>
            <CardDescription>
              {anythingImported
                ? 'Cross-check these counts against your old POS reports — that\'s your reconciliation.'
                : 'Go back to any step to upload a CSV, or explore NamastePOS and come back later — this wizard is always in the sidebar.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1.5">
              <li className="flex items-center gap-2">
                <UtensilsCrossed className="h-4 w-4 text-muted-foreground" />
                <strong>{menu?.imported ?? 0}</strong> menu items
                {menu?.extra?.variants ? <> (+{menu.extra.variants} variants)</> : null}
                {' '}— <Link className="underline" to="/menu">review menu</Link>
              </li>
              <li className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <strong>{customers?.imported ?? 0}</strong> customers with balances
                {' '}— <Link className="underline" to="/customers">review customers</Link>
              </li>
              <li className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                {sales?.extra?.revenueInr != null
                  ? <><strong>{inr(sales.extra.revenueInr)}</strong>&nbsp;sales across <strong>{sales.imported}</strong> day{sales.imported === 1 ? '' : 's'}</>
                  : <><strong>0</strong> sales days</>}
                {' '}— <Link className="underline" to="/reports">see reports</Link>
              </li>
              <li className="flex items-center gap-2">
                <Receipt className="h-4 w-4 text-muted-foreground" />
                <strong>{expenses?.imported ?? 0}</strong> expenses
                {' '}— <Link className="underline" to="/expenses">review expenses</Link>
              </li>
            </ul>
            {anythingImported && (
              <p className="text-muted-foreground">
                Tip: run NamastePOS alongside your old POS for a few days and compare
                the daily totals. If a CSV had failed rows, fix and re-upload just
                those — re-runs never duplicate anything.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Nav */}
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" disabled={step === 0}
                onClick={() => setStep((s) => Math.max(0, s - 1))}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        {!isDone && (
          <Button size="sm" onClick={() => setStep((s) => Math.min(STEPS.length, s + 1))}>
            {results[active!.key] ? 'Continue' : 'Skip for now'} <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
