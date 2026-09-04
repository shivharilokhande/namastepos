// NamastePOS dashboard — starter menu picker (2026-09-05).
//
// THE WALL THIS REMOVES: typing 30-80 dishes with prices on a phone is 45-90
// minutes, and it sits between signup and the first bill. The activation audit
// (2026-09-04) called it the single thing most likely to end a 7-day trial on
// day one. This turns it into two taps.
//
// Flow: pick a format → see the actual items and prices → Load. Nothing is
// hidden behind the button: an owner about to put 34 rows into their menu gets
// to read them first, including the GST notes, because a template they cannot
// inspect is a template they will not trust.
//
// LOADING IS A MERGE. Items whose names the business already has are left
// completely alone — not re-priced, not removed — and reported back. Loading
// the same template twice therefore does nothing the second time. The dialog
// says so before the owner taps, because "will this wipe what I typed?" is the
// first question anyone asks.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  X, Sparkles, ChevronLeft, Check, AlertTriangle, Info, Loader2,
} from 'lucide-react';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { trackMenuReadyFromServer } from '@/lib/activation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatINR } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful load, with how many items went in. */
  onLoaded?: (inserted: number) => void;
}

interface TemplateSummary {
  slug: string;
  name: string;
  tagline: string | null;
  format: string | null;
  itemCount: number;
  categories: string[];
  notes: string[];
  sample: { name: string; price: number }[];
}

export function MenuTemplateDialog({ open, onClose, onLoaded }: Props) {
  const qc = useQueryClient();
  const [slug, setSlug] = useState<string | null>(null);

  const { data: list = [], isLoading, error } = useQuery<TemplateSummary[]>({
    queryKey: ['menu-templates'],
    queryFn: ffApi.listMenuTemplates,
    enabled: open,
    staleTime: 60 * 60 * 1000, // product content — it does not change per session
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['menu-template', slug],
    queryFn: () => ffApi.getMenuTemplate(slug as string),
    enabled: open && !!slug,
    staleTime: 60 * 60 * 1000,
  });

  const apply = useMutation({
    mutationFn: () => ffApi.applyMenuTemplate(slug as string),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ['menu'] });
      // Activation funnel — `menu_ready` attributed to the template path, so
      // "median signup → first bill by source" can be read later.
      if (r.inserted > 0) trackMenuReadyFromServer('template');
      if (r.inserted > 0) {
        toast.success(
          `${r.inserted} items added${r.alreadyPresent?.length
            ? ` · ${r.alreadyPresent.length} you already had were left alone`
            : ''}. Tap any item to change its price.`,
        );
        onLoaded?.(r.inserted);
        close();
      } else {
        toast.info('You already have every item in this menu. Nothing changed.');
      }
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const close = () => { setSlug(null); onClose(); };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
         onClick={close}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-background z-10">
          <div className="flex items-center gap-2">
            {slug && (
              <Button size="sm" variant="ghost" onClick={() => setSlug(null)} title="Back to the list">
                <ChevronLeft className="w-4 h-4" />
              </Button>
            )}
            <Sparkles className="w-5 h-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold">
                {slug && detail ? detail.name : 'Start with a menu'}
              </h2>
              <p className="text-xs text-muted-foreground">
                {slug
                  ? `${detail?.itemCount ?? '—'} items · edit any price after loading`
                  : 'Pick the closest kind of kitchen. Items, categories and GST come pre-filled.'}
              </p>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={close}><X className="w-4 h-4" /></Button>
        </div>

        <div className="p-5 space-y-4">
          {isLoading && (
            <div className="p-8 text-center text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading menus…
            </div>
          )}
          {!!error && (
            <div className="p-4 text-sm text-destructive">
              Couldn&apos;t load the starter menus. {apiError(error)}
            </div>
          )}

          {/* ── List ─────────────────────────────────────────────────── */}
          {!slug && !isLoading && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {list.map((t) => (
                <button
                  key={t.slug}
                  onClick={() => setSlug(t.slug)}
                  className="text-left rounded-lg border p-3 hover:border-primary hover:bg-primary/5 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold">{t.name}</div>
                    <Badge variant="muted" className="text-[10px] shrink-0">{t.itemCount} items</Badge>
                  </div>
                  {t.tagline && (
                    <div className="text-xs text-muted-foreground mt-1">{t.tagline}</div>
                  )}
                  <div className="text-[11px] text-muted-foreground mt-2 truncate">
                    {t.categories.slice(0, 5).join(' · ')}
                    {t.categories.length > 5 ? ' · …' : ''}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* ── One template, in full ────────────────────────────────── */}
          {slug && detailLoading && (
            <div className="p-8 text-center text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading items…
            </div>
          )}
          {slug && detail && (
            <>
              {detail.notes?.length > 0 && (
                <Card className="border-sky-200 bg-sky-50">
                  <CardContent className="p-3 space-y-1.5 text-xs text-sky-900">
                    {detail.notes.map((n: string, i: number) => (
                      <div key={i} className="flex gap-2">
                        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>{n}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              <Card className="border-amber-200 bg-amber-50">
                <CardContent className="p-3 text-xs text-amber-900 flex gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    Nothing you already have is touched. Items with a name you
                    already use are skipped, not re-priced or removed. Load it
                    twice and the second time does nothing.
                  </span>
                </CardContent>
              </Card>

              <div className="border rounded overflow-hidden">
                <table className="text-xs w-full">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="p-2 text-left font-medium">Item</th>
                      <th className="p-2 text-left font-medium">Category</th>
                      <th className="p-2 text-right font-medium">Price</th>
                      <th className="p-2 text-right font-medium">GST</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((it: any, i: number) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="p-2">
                          <span className={`inline-block h-2 w-2 rounded-full mr-1.5 ${
                            it.isVeg ? 'bg-emerald-600' : 'bg-red-600'}`} />
                          {it.name}
                        </td>
                        <td className="p-2 text-muted-foreground">{it.category}</td>
                        <td className="p-2 text-right font-medium">{formatINR(it.price)}</td>
                        <td className="p-2 text-right text-muted-foreground">{it.gstPct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {slug && detail && (
          <div className="flex items-center justify-between gap-2 p-5 border-t bg-muted/30 sticky bottom-0">
            <Button variant="ghost" onClick={() => setSlug(null)}>Pick another</Button>
            <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
              {apply.isPending
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading…</>
                : <><Check className="w-4 h-4 mr-2" /> Load these {detail.itemCount} items</>}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
