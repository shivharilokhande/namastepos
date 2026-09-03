// Bulk import hub (Founder request 2026-08-25).
//
// This page used to be retail-SKU-only (R3). Founder asked for one place to
// bulk-import "menu, purchases, ingredients and other required", so it is now
// a tabbed hub:
//
//   Menu items   — reuses the existing MenuCsvImportDialog / POST /menu/bulk
//                  (FF-218) instead of duplicating that flow here.
//   Ingredients  — POST /imports/ingredients        (ingredients table)
//   Purchases    — POST /imports/ingredients/purchases
//                  (ingredient goods-received: stock + weighted-avg cost +
//                   ingredient_transactions, same as a manual purchase entry)
//   Expenses     — POST /imports/expenses           (expenses table)
//   Retail SKUs  — the original POST /retail/bulk-import, unchanged.
//
// CSVs are parsed client-side (same minimal quoted-field parser the menu
// dialog uses — deliberately no papaparse dep) and sent as a JSON `rows`
// array; the backend validates per row and returns
// { imported, failed: [{ row, error }] } so users get an Excel-line-accurate
// error table instead of an all-or-nothing failure.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Upload, FileSpreadsheet, AlertTriangle, CheckCircle2, Download,
  UtensilsCrossed, Carrot, ShoppingCart, Receipt, Barcode,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MenuCsvImportDialog } from '@/components/MenuCsvImportDialog';
import { ffApi } from '@/api/namastepos';
import { api, apiError, getBusinessCache } from '@/api/client';
// 2026-09-03: parser/shaper/download moved to @/lib/csv so the migration
// wizard (/migrate) shares them instead of duplicating.
import { parseCsv, shapeRow, downloadCsv, type CsvRow } from '@/lib/csv';

interface ImportFailure {
  // Number for the new /imports/* endpoints (CSV file line); the legacy
  // retail endpoint reports the item *name* instead — keep the union so we
  // can render both without lying about the shape.
  row: number | string;
  error: string;
}
interface ImportReport { imported: number; failed: ImportFailure[] }

// ── Import type configs ─────────────────────────────────────────────────

interface ImportTypeConfig {
  key: string;
  label: string;
  icon: typeof Upload;
  blurb: string;
  columnsNote: string;
  templateName: string;
  templateCsv: string;
  submit: (rows: CsvRow[]) => Promise<ImportReport>;
}

const INGREDIENT_MAP: Record<string, string> = {
  name: 'name', category: 'category', unit: 'unit', stock: 'stock',
  reorder_level: 'reorderLevel', cost_per_unit_inr: 'costPerUnitInr',
  vendor: 'vendor', vendor_phone: 'vendorPhone', notes: 'notes',
};
const PURCHASE_MAP: Record<string, string> = {
  ingredient: 'ingredient', qty: 'qty',
  unit_cost_inr: 'unitCostInr', total_cost_inr: 'totalCostInr',
  vendor: 'vendor', note: 'note',
};
const EXPENSE_MAP: Record<string, string> = {
  date: 'date', category: 'category', amount: 'amount', description: 'description',
};

const postImport = async (path: string, rows: Record<string, string>[]): Promise<ImportReport> => {
  const b = getBusinessCache();
  const r = await api.post(`/businesses/${b.id}${path}`, { rows });
  return r.data as ImportReport;
};

const IMPORT_TYPES: ImportTypeConfig[] = [
  {
    key: 'ingredients',
    label: 'Ingredients',
    icon: Carrot,
    blurb: 'Raw materials for recipe costing — name, unit, opening stock and cost.',
    columnsNote: 'Required: Name. Optional: Category, Unit (g/kg/ml/l/piece/pack/dozen), Stock, Reorder Level, Cost Per Unit INR, Vendor, Vendor Phone, Notes.',
    templateName: 'namastepos-ingredients-template.csv',
    templateCsv: `Name,Category,Unit,Stock,Reorder Level,Cost Per Unit INR,Vendor,Vendor Phone,Notes
Basmati Rice,grains,kg,25,10,90,Sharma Traders,9876543210,
Paneer,dairy,kg,5,2,320,Amul Distributor,,Keep refrigerated
Red Chilli Powder,spices,g,2000,500,0.45,,,`,
    submit: (rows) => postImport('/imports/ingredients', rows.map((r) => shapeRow(r, INGREDIENT_MAP))),
  },
  {
    key: 'purchases',
    label: 'Purchases',
    icon: ShoppingCart,
    blurb: 'Goods received against existing ingredients — bumps stock and recalculates the weighted-average cost, exactly like a manual purchase entry.',
    columnsNote: 'Required: Ingredient (must already exist), Qty, and one of Unit Cost INR / Total Cost INR. Optional: Vendor, Note.',
    templateName: 'namastepos-purchases-template.csv',
    templateCsv: `Ingredient,Qty,Unit Cost INR,Total Cost INR,Vendor,Note
Basmati Rice,10,95,,Sharma Traders,Weekly stock
Paneer,2,,650,Amul Distributor,`,
    submit: (rows) => postImport('/imports/ingredients/purchases', rows.map((r) => shapeRow(r, PURCHASE_MAP))),
  },
  {
    key: 'expenses',
    label: 'Expenses',
    icon: Receipt,
    blurb: 'Business expenses — rent, gas, salaries, electricity and the rest.',
    columnsNote: 'Required: Date (YYYY-MM-DD), Amount. Optional: Category (ingredients, fuel, labor, rent, utilities, packaging, marketing, maintenance, chef_salary, helper_salary, staff_salary, gas, electricity, water, transport, equipment, cleaning, license_fees, other), Description.',
    templateName: 'namastepos-expenses-template.csv',
    templateCsv: `Date,Category,Amount,Description
2026-08-01,gas,1200,Cylinder refill
2026-08-03,electricity,3400,July bill
2026-08-05,staff_salary,15000,Waiter salary`,
    submit: (rows) => postImport('/imports/expenses', rows.map((r) => shapeRow(r, EXPENSE_MAP))),
  },
  {
    key: 'retail',
    label: 'Retail SKUs',
    icon: Barcode,
    blurb: 'Retail items with HSN and GST — the original bulk SKU import.',
    columnsNote: 'Columns: Name, Category, Unit, HSN Code, GST Pct (0/5/12/18/28), Price INR, Stock.',
    templateName: 'namastepos-retail-sku-template.csv',
    templateCsv: `Name,Category,Unit,HSN Code,GST Pct,Price INR,Stock
Parle-G 100g,Biscuits,piece,1905,18,10,120
Tata Salt 1kg,Grocery,pack,2501,5,28,40`,
    // Legacy endpoint shape is { created, errors: [{ row: <name>, error }] } —
    // adapt it to the shared report shape so one result card renders all tabs.
    submit: async (rows) => {
      const r = await ffApi.bulkImportRetail(rows);
      return {
        imported: r.created ?? 0,
        failed: (r.errors ?? []).map((e: { row?: string; error: string }) => ({
          row: e.row ?? '?', error: e.error,
        })),
      };
    },
  },
];

// Query caches to refresh after a successful import, per import type — so
// the Ingredients / Expenses pages show new rows without a manual reload.
const INVALIDATE_KEYS: Record<string, string[]> = {
  ingredients: ['ingredients'],
  purchases: ['ingredients'],
  expenses: ['expenses'],
  retail: ['retail'],
};

// ── Generic CSV import section (template → pick → preview → import) ─────

function ImportSection({ config }: { config: ImportTypeConfig }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [report, setReport] = useState<ImportReport | null>(null);

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
        setReport(null);
      } catch (err) {
        toast.error(`Couldn't read the CSV — ${err instanceof Error ? err.message : 'parse error'}`);
      }
    };
    reader.onerror = () => toast.error("Couldn't read the file.");
    reader.readAsText(file);
  };

  const importRows = useMutation({
    mutationFn: () => config.submit(rows),
    onSuccess: (r) => {
      setReport(r);
      for (const key of INVALIDATE_KEYS[config.key] ?? []) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      if (r.imported > 0) {
        toast.success(`Imported ${r.imported} row${r.imported === 1 ? '' : 's'}` +
          (r.failed.length > 0 ? ` · ${r.failed.length} failed` : ''));
      } else {
        toast.error(`No rows imported — ${r.failed.length} failed. See the report below.`);
      }
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Spec (2026-08-25): preview the first 5 parsed rows before importing.
  const preview = rows.slice(0, 5);
  const headers = rows[0] ? Object.keys(rows[0]) : [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Step 1 · Get the template &amp; pick a file</CardTitle>
          <CardDescription>{config.blurb}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button size="sm" variant="outline"
                  onClick={() => downloadCsv(config.templateName, config.templateCsv)}>
            <Download className="mr-2 h-4 w-4" /> Download template CSV
          </Button>
          <Input type="file" accept=".csv,text/csv" onChange={(e) => onPick(e.target.files?.[0])} />
          <p className="text-xs text-muted-foreground">{config.columnsNote} Max 1000 rows per upload.</p>
        </CardContent>
      </Card>

      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Step 2 · Preview ({rows.length} row{rows.length === 1 ? '' : 's'} parsed)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto border rounded">
              <table className="text-xs w-full">
                <thead className="bg-muted/50 border-b">
                  <tr>{headers.map((h) => <th key={h} className="p-2 text-left font-medium">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      {headers.map((h) => (
                        <td key={h} className="p-2">{r[h] || <span className="text-muted-foreground">—</span>}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > preview.length && (
              <div className="text-xs text-muted-foreground mt-2">
                Showing first {preview.length} of {rows.length} rows
              </div>
            )}
            <Button className="mt-3" onClick={() => importRows.mutate()} disabled={importRows.isPending}>
              {importRows.isPending
                ? 'Importing…'
                : <><Upload className="mr-2 h-4 w-4" /> Import {rows.length} row{rows.length === 1 ? '' : 's'}</>}
            </Button>
          </CardContent>
        </Card>
      )}

      {report && (
        <Card className={report.failed.length > 0 ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}>
          <CardContent className="p-4 space-y-2 text-sm">
            <div className="flex items-center gap-2 font-semibold">
              {report.failed.length > 0
                ? <><AlertTriangle className="w-4 h-4 text-amber-700" /> Partial import</>
                : <><CheckCircle2 className="w-4 h-4 text-emerald-700" /> All imported</>}
            </div>
            <div>
              <strong>{report.imported}</strong> row{report.imported === 1 ? '' : 's'} imported
              {report.failed.length > 0 && <> · <strong>{report.failed.length}</strong> failed</>}
            </div>
            {report.failed.length > 0 && (
              <div className="overflow-x-auto border rounded bg-background/60">
                <table className="text-xs w-full">
                  <thead className="border-b">
                    <tr>
                      <th className="p-2 text-left font-medium w-20">Row</th>
                      <th className="p-2 text-left font-medium">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.failed.slice(0, 50).map((f, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="p-2">{f.row}</td>
                        <td className="p-2">{f.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {report.failed.length > 50 && (
                  <div className="p-2 text-xs text-muted-foreground">
                    … and {report.failed.length - 50} more. Fix the CSV and re-upload just the failed rows.
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

// ── Page ────────────────────────────────────────────────────────────────

export function BulkImportPage() {
  const [tab, setTab] = useState<string>('menu');
  const [menuDialogOpen, setMenuDialogOpen] = useState(false);
  const active = IMPORT_TYPES.find((t) => t.key === tab);

  const tabs: { key: string; label: string; icon: typeof Upload }[] = [
    { key: 'menu', label: 'Menu items', icon: UtensilsCrossed },
    ...IMPORT_TYPES.map((t) => ({ key: t.key, label: t.label, icon: t.icon })),
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <FileSpreadsheet className="h-6 w-6 text-primary" /> Bulk import
        </h1>
        <p className="text-muted-foreground text-sm">
          Bring your data over in bulk — download a CSV template, fill it, upload, review, import.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <Button key={t.key} size="sm"
                  variant={tab === t.key ? 'default' : 'outline'}
                  onClick={() => setTab(t.key)}>
            <t.icon className="mr-2 h-4 w-4" /> {t.label}
          </Button>
        ))}
      </div>

      {tab === 'menu' ? (
        // Menu import already exists (FF-218) as MenuCsvImportDialog on the
        // Menu page — reuse the component here instead of rebuilding the
        // flow, so validation, sample CSV and cache invalidation stay in one
        // place.
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Menu items</CardTitle>
            <CardDescription>
              Upload dishes with prices, categories, veg flag, GST and HSN.
              Required columns: Name, Price. The importer includes a sample CSV.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setMenuDialogOpen(true)}>
              <Upload className="mr-2 h-4 w-4" /> Import menu CSV
            </Button>
          </CardContent>
        </Card>
      ) : active ? (
        // key= forces a remount on tab switch so a half-done upload from one
        // type can never be submitted to another type's endpoint.
        <ImportSection key={active.key} config={active} />
      ) : null}

      <MenuCsvImportDialog open={menuDialogOpen} onClose={() => setMenuDialogOpen(false)} />
    </div>
  );
}
