// NamastePOS dashboard — "paste your menu" (2026-09-05).
//
// WHY: the CSV importer and the /migrate wizard both assume the owner HAS an
// export from a previous system. A first-time owner, or one moving off paper,
// has nothing to export. What they DO have is the menu as text — the WhatsApp
// message they send regulars, a typed list, a note on their phone. This takes
// that text.
//
// NOT OCR. A photo of a menu card is explicitly out of scope: a half-working
// OCR over a phone photo produces confident wrong prices, and a wrong price is
// worse than no menu.
//
// Three honest steps:
//   1. Paste. The server parses and returns a preview — it writes nothing.
//   2. Correct. Every name, price and category is editable, low-confidence
//      rows are flagged, and every line the parser could NOT read is listed
//      so nothing disappears quietly.
//   3. Import. The confirmed rows go through the EXISTING POST /menu/bulk, so
//      the plan-cap pre-check and the all-or-nothing transaction apply exactly
//      as they do for a CSV.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  X, ClipboardPaste, Upload, AlertTriangle, Loader2, Trash2, Info,
} from 'lucide-react';
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

interface Row {
  name: string;
  price: string;      // string so the input can be emptied mid-edit
  category: string;
  confidence: 'high' | 'low';
  note: string | null;
  line: string;
}

interface Unparsed { lineNo: number; line: string; reason: string }

const EXAMPLE = `STARTERS
Paneer Tikka 250
Masala Chai - 20
2. Butter Naan .... 40

Main Course:
Dal Makhani Rs 260
Butter Chicken ₹400`;

export function MenuPasteDialog({ open, onClose }: Props) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [unparsed, setUnparsed] = useState<Unparsed[]>([]);
  const [result, setResult] = useState<any>(null);

  const reset = () => { setText(''); setRows(null); setUnparsed([]); setResult(null); };
  const close = () => { reset(); onClose(); };

  const parse = useMutation({
    mutationFn: () => ffApi.parseMenuText(text),
    onSuccess: (r: any) => {
      setUnparsed(r.unparsed || []);
      setRows((r.items || []).map((i: any) => ({
        name: i.name,
        price: String(i.price),
        category: i.category,
        confidence: i.confidence,
        note: i.note,
        line: i.line,
      })));
      setResult(null);
      if (!r.items?.length) {
        toast.error("Couldn't read any items. Each line needs a name and a price, like: Paneer Tikka 250");
      }
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const importRows = useMutation({
    mutationFn: () => ffApi.bulkImportMenu(
      (rows || [])
        .filter((r) => r.name.trim() && r.price !== '' && Number(r.price) >= 0)
        .map((r) => ({
          name: r.name.trim(),
          price: Number(r.price),
          category: r.category.trim() || 'Menu',
        })),
    ),
    onSuccess: (r: any) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ['menu'] });
      if (r.inserted > 0) {
        trackMenuReadyFromServer('paste');
        toast.success(`${r.inserted} items added${r.skipped > 0 ? ` · ${r.skipped} skipped` : ''}`);
      } else {
        toast.error(`Nothing imported — ${r.skipped} skipped. See the report below.`);
      }
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (!open) return null;

  const patch = (i: number, p: Partial<Row>) => {
    setRows((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[i] = { ...next[i], ...p };
      return next;
    });
  };
  const drop = (i: number) => setRows((prev) => (prev ? prev.filter((_, x) => x !== i) : prev));

  const usable = (rows || []).filter((r) => r.name.trim() && r.price !== '').length;
  const lowConfidence = (rows || []).filter((r) => r.confidence === 'low').length;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={close}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-background z-10">
          <div className="flex items-center gap-2">
            <ClipboardPaste className="w-5 h-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold">Paste your menu</h2>
              <p className="text-xs text-muted-foreground">
                One item per line, name then price. Check what we read before it saves.
              </p>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={close}><X className="w-4 h-4" /></Button>
        </div>

        <div className="p-5 space-y-4">
          {/* Step 1 — paste */}
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="text-xs font-semibold uppercase text-muted-foreground">
                Step 1 · Paste the text
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                spellCheck={false}
                placeholder={EXAMPLE}
                className="w-full rounded-md border border-input bg-background p-3 text-sm font-mono"
              />
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-muted-foreground max-w-md">
                  Works with a WhatsApp message, a typed list, numbered lines,
                  dotted leaders and ₹ / Rs. A line that is only a heading
                  (&ldquo;STARTERS&rdquo;, &ldquo;Main Course:&rdquo;) becomes a category.
                  A photo of a menu card will not work — type or paste the text.
                </p>
                <Button onClick={() => parse.mutate()} disabled={!text.trim() || parse.isPending}>
                  {parse.isPending
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Reading…</>
                    : 'Read the menu'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Step 2 — correct */}
          {rows && rows.length > 0 && (
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="text-xs font-semibold uppercase text-muted-foreground">
                    Step 2 · Check and fix ({usable} item{usable === 1 ? '' : 's'})
                  </div>
                  {lowConfidence > 0 && (
                    <div className="text-xs text-amber-800 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {lowConfidence} row{lowConfidence === 1 ? '' : 's'} we are not sure about — highlighted
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  {rows.map((r, i) => (
                    <div key={i}
                         className={`flex gap-2 items-center rounded p-1 ${
                           r.confidence === 'low' ? 'bg-amber-50' : ''}`}>
                      <Input className="flex-1 h-8" value={r.name}
                             onChange={(e) => patch(i, { name: e.target.value })} />
                      <Input className="w-24 h-8" type="number" value={r.price}
                             onChange={(e) => patch(i, { price: e.target.value })} />
                      <Input className="w-32 h-8" value={r.category}
                             onChange={(e) => patch(i, { category: e.target.value })} />
                      <button onClick={() => drop(i)} className="p-1 hover:bg-accent rounded"
                              title="Don't import this line">
                        <Trash2 className="w-3.5 h-3.5 text-destructive" />
                      </button>
                    </div>
                  ))}
                </div>
                {rows.some((r) => r.note) && (
                  <ul className="text-xs text-amber-900 space-y-0.5">
                    {rows.filter((r) => r.note).map((r, i) => (
                      <li key={i}>{r.name}: {r.note}</li>
                    ))}
                  </ul>
                )}
                <Button onClick={() => importRows.mutate()}
                        disabled={usable === 0 || importRows.isPending}>
                  {importRows.isPending
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing…</>
                    : <><Upload className="w-4 h-4 mr-2" /> Add {usable} item{usable === 1 ? '' : 's'} to my menu</>}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Lines we could not read — never hidden */}
          {unparsed.length > 0 && (
            <Card className="border-amber-300 bg-amber-50">
              <CardContent className="p-4 text-xs space-y-1.5 text-amber-900">
                <div className="font-semibold flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5" />
                  {unparsed.length} line{unparsed.length === 1 ? '' : 's'} we could not read
                </div>
                <div>
                  Nothing was guessed for these. Add them by hand, or fix the
                  line and read the menu again.
                </div>
                <ul className="space-y-0.5 pt-1">
                  {unparsed.slice(0, 20).map((u) => (
                    <li key={u.lineNo}>
                      <span className="font-mono">{u.line || '(blank)'}</span>
                      {' — '}{u.reason}
                    </li>
                  ))}
                  {unparsed.length > 20 && <li>… and {unparsed.length - 20} more</li>}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Result */}
          {result && (
            <Card className={result.errors?.length > 0
              ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}>
              <CardContent className="p-4 space-y-2 text-sm">
                <div>
                  <strong>{result.inserted}</strong> item{result.inserted === 1 ? '' : 's'} added
                  {result.skipped > 0 && <> · <strong>{result.skipped}</strong> skipped</>}
                </div>
                {result.errors?.length > 0 && (
                  <ul className="text-xs space-y-0.5">
                    {result.errors.slice(0, 15).map((e: any, i: number) => (
                      <li key={i}>Row {e.row}{e.name ? ` (${e.name})` : ''}: {e.message}</li>
                    ))}
                  </ul>
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
