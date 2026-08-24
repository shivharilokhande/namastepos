// CSV / Excel bulk import (R3)
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Upload, FileSpreadsheet, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';

// Tiny CSV parser — handles quoted fields with commas
function parseCsv(text: string): any[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const splitCsvLine = (line: string) => {
    const out: string[] = [];
    let cur = '', inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const obj: any = {};
    headers.forEach((h, i) => { obj[h] = cells[i]; });
    return obj;
  });
}

export function BulkImportPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [result, setResult] = useState<any>(null);

  const onPick = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseCsv(reader.result as string);
        setRows(parsed);
        setResult(null);
      } catch (err: any) {
        toast.error(`Parse failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const importRows = useMutation({
    mutationFn: () => ffApi.bulkImportRetail(rows),
    onSuccess: (r: any) => { setResult(r); toast.success(`Imported ${r.created}, ${r.errors?.length || 0} errors`); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <FileSpreadsheet className="h-6 w-6 text-primary" /> Bulk SKU import
        </h1>
        <p className="text-muted-foreground text-sm">
          Upload a CSV with columns: <code>name, category, unit, hsn_code, gst_pct, price_inr, stock</code>
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Step 1 — Upload CSV</CardTitle>
          <CardDescription>Max 1000 rows per upload.</CardDescription>
        </CardHeader>
        <CardContent>
          <Input type="file" accept=".csv,text/csv" onChange={(e) => onPick(e.target.files?.[0])} />
          {rows.length > 0 && <div className="text-sm mt-2">Parsed <strong>{rows.length}</strong> row(s). Preview:</div>}
        </CardContent>
      </Card>

      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 2 — Preview &amp; import</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead className="border-b">
                  <tr>{Object.keys(rows[0]).map((h) => <th key={h} className="p-2 text-left">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.slice(0, 8).map((r, i) => (
                    <tr key={i} className="border-b">
                      {Object.values(r).map((v: any, j: number) => <td key={j} className="p-2">{String(v)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 8 && <div className="text-xs text-muted-foreground mt-2">+ {rows.length - 8} more rows…</div>}
            <Button className="mt-3" onClick={() => importRows.mutate()} disabled={importRows.isPending}>
              <Upload className="mr-2 h-4 w-4" /> Import {rows.length} rows
            </Button>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className={result.errors?.length > 0 ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}>
          <CardContent className="p-4 text-sm">
            <div className="font-bold mb-1">{result.created} item(s) imported</div>
            {result.errors?.length > 0 && (
              <div>
                <div className="flex items-center gap-1 text-amber-800"><AlertTriangle className="h-3 w-3" /> {result.errors.length} errors:</div>
                {result.errors.slice(0, 10).map((err: any, i: number) => (
                  <div key={i} className="text-xs">• {err.row || '?'}: {err.error}</div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
