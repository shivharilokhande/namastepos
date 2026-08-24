// NamastePOS — SKU auto-mapper dialog (FF-103b).
//
// Owner pastes their Zomato/Swiggy menu CSV (name + SKU per row) OR
// a plain list of names, and we auto-pair each row to a NamastePOS
// menu item by lowercase-normalized substring match. Owner reviews +
// commits.
//
// We deliberately don't scrape aggregator URLs (they gate + change
// often). Pasting the CSV from the aggregator's own export tool is
// the reliable path.

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { X, Link2, Check as CheckIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  provider: 'zomato' | 'swiggy' | 'dunzo' | 'magicpin';
}

// Normalise: lowercase, strip punctuation + extra whitespace.
const normalise = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

interface Pair {
  externalName: string;
  externalSku: string;
  menuItemId: string | null;
  menuItemName: string | null;
  confidence: 'exact' | 'partial' | 'none';
}

// Score match: exact = 1.0, contains = 0.5, other = 0.0
function autoMatch(external: string, items: Array<{ id: string; name: string }>) {
  const en = normalise(external);
  let best: { id: string; name: string; score: number } | null = null;
  for (const it of items) {
    const on = normalise(it.name);
    const s = on === en ? 1 : (on.includes(en) || en.includes(on) ? 0.5 : 0);
    if (s > (best?.score || 0)) best = { ...it, score: s };
  }
  return best && best.score > 0 ? best : null;
}

// Very forgiving CSV parser — same as the menu bulk-import.
function parseInput(raw: string): Array<{ name: string; sku: string }> {
  const lines = raw.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  // If first line looks like a header, drop it.
  const first = lines[0].toLowerCase();
  const hasHeader = first.includes('name') && (first.includes('sku') || first.includes('code'));
  const rows = hasHeader ? lines.slice(1) : lines;
  return rows.map((l) => {
    const parts = l.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    return { name: parts[0] || '', sku: parts[1] || parts[0] };
  }).filter((r) => r.name);
}

export function SkuAutoMapDialog({ open, onClose, provider }: Props) {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({ queryKey: ['menu'], queryFn: ffApi.listMenu });
  const [raw, setRaw] = useState('');
  const [pairs, setPairs] = useState<Pair[]>([]);

  const preview = useMemo(() => {
    const rows = parseInput(raw);
    return rows.map<Pair>((r) => {
      const m = autoMatch(r.name, items);
      return {
        externalName: r.name,
        externalSku: r.sku,
        menuItemId: m?.id ?? null,
        menuItemName: m?.name ?? null,
        confidence: !m ? 'none' : m.name.toLowerCase() === r.name.toLowerCase() ? 'exact' : 'partial',
      };
    });
  }, [raw, items]);

  const commit = useMutation({
    mutationFn: async () => {
      const eligible = pairs.filter((p) => p.menuItemId);
      for (const p of eligible) {
        await ffApi.setExternalSku(p.menuItemId!, provider, p.externalSku);
      }
      return eligible.length;
    },
    onSuccess: (n) => {
      toast.success(`Mapped ${n} item${n === 1 ? '' : 's'} to ${provider}`);
      qc.invalidateQueries({ queryKey: ['menu'] });
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
         onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b">
          <div className="flex items-center gap-2">
            <Link2 className="w-5 h-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold capitalize">Auto-map to {provider}</h2>
              <p className="text-xs text-muted-foreground">Paste the {provider} menu CSV or a name-per-line list.</p>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}><X className="w-4 h-4" /></Button>
        </div>

        <div className="p-5 space-y-4">
          <Card>
            <CardContent className="p-4 space-y-2">
              <Label>Paste — one item per line, or CSV: <code>Name,SKU</code></Label>
              <textarea rows={7}
                value={raw} onChange={(e) => { setRaw(e.target.value); setPairs(preview); }}
                placeholder="Masala Chai,ZOM_CHAI_001&#10;Butter Naan,ZOM_NAAN_002"
                className="w-full rounded-md border border-input bg-background p-2 text-sm font-mono" />
              <div className="text-xs text-muted-foreground">
                Tip: {provider} lets you export the menu as CSV — grab it from their partner dashboard.
              </div>
            </CardContent>
          </Card>

          {preview.length > 0 && (
            <Card>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase text-muted-foreground">
                    Preview ({preview.length} row{preview.length === 1 ? '' : 's'})
                  </div>
                  <div className="text-xs">
                    <span className="text-emerald-700">
                      {preview.filter((p) => p.confidence === 'exact').length} exact
                    </span>
                    {' · '}
                    <span className="text-amber-700">
                      {preview.filter((p) => p.confidence === 'partial').length} partial
                    </span>
                    {' · '}
                    <span className="text-red-700">
                      {preview.filter((p) => p.confidence === 'none').length} unmatched
                    </span>
                  </div>
                </div>
                <div className="max-h-96 overflow-y-auto border rounded">
                  <table className="text-xs w-full">
                    <thead className="bg-muted/50 border-b">
                      <tr>
                        <th className="p-2 text-left">External name</th>
                        <th className="p-2 text-left">SKU</th>
                        <th className="p-2 text-left">→ NamastePOS item</th>
                        <th className="p-2 text-left">Match</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((p, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="p-2">{p.externalName}</td>
                          <td className="p-2 font-mono">{p.externalSku}</td>
                          <td className="p-2">
                            {p.menuItemName || <span className="text-muted-foreground italic">—</span>}
                          </td>
                          <td className="p-2">
                            {p.confidence === 'exact' && <span className="text-emerald-700 inline-flex items-center gap-1"><CheckIcon className="w-3 h-3" />exact</span>}
                            {p.confidence === 'partial' && <span className="text-amber-700">partial</span>}
                            {p.confidence === 'none' && <span className="text-red-700">no match</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button onClick={() => { setPairs(preview); commit.mutate(); }}
                        disabled={commit.isPending || preview.every((p) => !p.menuItemId)}>
                  {commit.isPending
                    ? 'Saving…'
                    : `Save ${preview.filter((p) => p.menuItemId).length} mapping${preview.filter((p) => p.menuItemId).length === 1 ? '' : 's'}`}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
