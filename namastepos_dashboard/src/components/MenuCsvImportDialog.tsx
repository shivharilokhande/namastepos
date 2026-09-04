// NamastePOS dashboard — Menu CSV bulk-import dialog (FF-218).
//
// Reusable modal you drop into MenuPage. Three visible steps:
//
//   1. Pick file      — accepts .csv (Excel export or any UTF-8 CSV).
//   2. Preview        — shows the first 10 parsed rows with column
//                       auto-detection (Name/Price/Category are enough).
//   3. Import + result — hits POST /menu/bulk, shows inserted / skipped /
//                        per-row errors.
//
// The parser is deliberately minimal (no papaparse dep) — it handles
// quoted fields with embedded commas and CRLF endings, which is what
// Excel and Google Sheets emit. Anything more exotic (embedded quotes)
// can be added later if a customer complains.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Upload, FileSpreadsheet, AlertTriangle, CheckCircle2, X, Download } from 'lucide-react';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { trackMenuReadyFromServer } from '@/lib/activation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

interface Props {
  open: boolean;
  onClose: () => void;
}

function parseCsv(text: string): Record<string, string>[] {
  // Normalise line endings first, then split.
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const splitLine = (line: string) => {
    const out: string[] = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  // Normalise headers: lowercase + underscores. Accepts "Item Name",
  // "item_name", "ITEM NAME" alike.
  const headers = splitLine(lines[0]).map((h) => h.toLowerCase().trim().replace(/\s+/g, '_'));
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
}

const SAMPLE_CSV = `Name,Price,Category,Description,Veg,GST,HSN
Masala Chai,30,Beverages,Cutting chai in kulhad,true,5,
Butter Naan,40,Breads,Oven-fresh with butter,true,5,
Paneer Butter Masala,280,Main,Creamy tomato base,true,5,
Chicken 65,240,Starters,Spicy fried chicken,false,5,`;

export function MenuCsvImportDialog({ open, onClose }: Props) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [result, setResult] = useState<any>(null);

  const reset = () => { setRows([]); setResult(null); };
  const close = () => { reset(); onClose(); };

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
        setResult(null);
      } catch (err: any) {
        toast.error(`Couldn't read the CSV — ${err.message}`);
      }
    };
    reader.onerror = () => toast.error("Couldn't read the file.");
    reader.readAsText(file);
  };

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'namastepos-menu-sample.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const importRows = useMutation({
    mutationFn: () => ffApi.bulkImportMenu(rows),
    onSuccess: (r: any) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ['menu'] });
      // Activation funnel — `menu_ready` with the right attribution. The
      // dialog can be used from anywhere, so read the resulting menu back
      // rather than guessing the new total from r.inserted.
      if (r.inserted > 0) trackMenuReadyFromServer('bulk_csv');
      if (r.inserted > 0) {
        toast.success(`Imported ${r.inserted} item${r.inserted === 1 ? '' : 's'}` +
          (r.skipped > 0 ? ` · ${r.skipped} skipped` : ''));
      } else {
        toast.error(`No items imported — ${r.skipped} skipped. See the report below.`);
      }
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (!open) return null;

  const preview = rows.slice(0, 10);
  const headers = rows[0] ? Object.keys(rows[0]) : [];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
         onClick={close}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold">Bulk import menu items</h2>
              <p className="text-xs text-muted-foreground">Upload a CSV, review, import.</p>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={close}><X className="w-4 h-4" /></Button>
        </div>

        <div className="p-5 space-y-4">
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="text-xs font-semibold uppercase text-muted-foreground">Step 1 · Pick file</div>
              <Input type="file" accept=".csv,text/csv"
                     onChange={(e) => onPick(e.target.files?.[0])} />
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <button onClick={downloadSample} className="flex items-center gap-1 hover:underline">
                  <Download className="w-3 h-3" /> Download sample CSV
                </button>
                <span>·</span>
                <span>Required columns: <code>Name</code>, <code>Price</code>. Optional: <code>Category</code>, <code>Description</code>, <code>Veg</code>, <code>GST</code>, <code>HSN</code>.</span>
              </div>
            </CardContent>
          </Card>

          {rows.length > 0 && (
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase text-muted-foreground">
                    Step 2 · Preview ({rows.length} row{rows.length === 1 ? '' : 's'})
                  </div>
                  <Button size="sm" variant="ghost" onClick={reset}>Clear</Button>
                </div>
                <div className="overflow-x-auto border rounded">
                  <table className="text-xs w-full">
                    <thead className="bg-muted/50 border-b">
                      <tr>{headers.map((h) => <th key={h} className="p-2 text-left font-medium">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {preview.map((r, i) => (
                        <tr key={i} className="border-b last:border-0">
                          {headers.map((h) => <td key={h} className="p-2">{r[h] || <span className="text-muted-foreground">—</span>}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length > preview.length && (
                  <div className="text-xs text-muted-foreground">
                    + {rows.length - preview.length} more row{rows.length - preview.length === 1 ? '' : 's'} not shown
                  </div>
                )}
                <Button onClick={() => importRows.mutate()}
                        disabled={importRows.isPending}>
                  {importRows.isPending
                    ? 'Importing…'
                    : <><Upload className="w-4 h-4 mr-2" /> Import {rows.length} item{rows.length === 1 ? '' : 's'}</>}
                </Button>
              </CardContent>
            </Card>
          )}

          {result && (
            <Card className={result.errors?.length > 0 ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}>
              <CardContent className="p-4 space-y-2 text-sm">
                <div className="flex items-center gap-2 font-semibold">
                  {result.errors?.length > 0
                    ? <><AlertTriangle className="w-4 h-4 text-amber-700" /> Partial import</>
                    : <><CheckCircle2 className="w-4 h-4 text-emerald-700" /> All imported</>}
                </div>
                <div>
                  <strong>{result.inserted}</strong> item{result.inserted === 1 ? '' : 's'} added
                  {result.skipped > 0 && <> · <strong>{result.skipped}</strong> skipped</>}
                </div>
                {result.errors?.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-amber-900">
                      Show {result.errors.length} error{result.errors.length === 1 ? '' : 's'}
                    </summary>
                    <ul className="mt-2 space-y-0.5">
                      {result.errors.slice(0, 25).map((err: any, i: number) => (
                        <li key={i}>Row {err.row}{err.name ? ` (${err.name})` : ''}: {err.message}</li>
                      ))}
                      {result.errors.length > 25 && (
                        <li>… and {result.errors.length - 25} more</li>
                      )}
                    </ul>
                  </details>
                )}
                <Button size="sm" variant="outline" onClick={close}>Done</Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
