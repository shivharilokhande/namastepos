// NamastePOS — Bill template editor (Sprint 1 / FF-306).
//
// Owner sets logo + address + GSTIN + footer + paper width. Live preview
// on the right shows what the printed receipt will look like.

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Receipt, Save } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

export function BillTemplatePage() {
  const qc = useQueryClient();
  const { data: template } = useQuery({
    queryKey: ['bill-template'], queryFn: ffApi.getBillTemplate,
  });
  const [f, setF] = useState<any>(null);

  // Mirror server → local once loaded
  useEffect(() => {
    if (template && !f) {
      setF({
        logoUrl: template.logoUrl || '',
        headerLines: (template.headerLines || []).join('\n'),
        gstin: template.gstin || '',
        fssaiNo: template.fssaiNo || '',
        footerText: template.footerText || '',
        showToken: template.showToken !== false,
        showTaxBreakdown: template.showTaxBreakdown !== false,
        paperWidthMm: template.paperWidthMm || 80,
      });
    }
  }, [template, f]);

  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));

  const save = useMutation({
    mutationFn: () => ffApi.updateBillTemplate({
      ...f,
      headerLines: f.headerLines.split('\n').map((s: string) => s.trim()).filter(Boolean),
    }),
    onSuccess: () => {
      toast.success('Receipt template saved');
      qc.invalidateQueries({ queryKey: ['bill-template'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (!f) return <div className="p-10 text-center text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Receipt className="h-6 w-6 text-primary" /> Receipt template
          </h1>
          <p className="text-muted-foreground text-sm">
            Customize how your receipts look. Changes apply to all future bills + reprints.
          </p>
        </div>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          <Save className="mr-2 h-4 w-4" /> {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        {/* Editor */}
        <Card>
          <CardHeader>
            <CardTitle>Edit</CardTitle>
            <CardDescription>Fill in only the bits you want shown.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>Logo URL (optional)</Label>
              <Input value={f.logoUrl} onChange={(e) => set('logoUrl', e.target.value)}
                placeholder="https://…/logo.png" />
            </div>
            <div>
              <Label>Header lines (one per line — up to 8)</Label>
              <textarea
                value={f.headerLines}
                onChange={(e) => set('headerLines', e.target.value)}
                rows={5}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder={"Sugar & Spice\nAnjuna Beach Road, Goa\n+91 98765 43210"}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>GSTIN</Label>
                <Input value={f.gstin} onChange={(e) => set('gstin', e.target.value)}
                  placeholder="22AAAAA0000A1Z5" maxLength={15} />
              </div>
              <div>
                <Label>FSSAI no</Label>
                <Input value={f.fssaiNo} onChange={(e) => set('fssaiNo', e.target.value)}
                  placeholder="12345678901234" />
              </div>
            </div>
            <div>
              <Label>Footer note</Label>
              <Input value={f.footerText} onChange={(e) => set('footerText', e.target.value)}
                placeholder="Thank you — please come again!" />
            </div>
            <div className="grid grid-cols-2 gap-3 pt-2">
              <div>
                <Label>Paper width</Label>
                <select className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={f.paperWidthMm}
                  onChange={(e) => set('paperWidthMm', +e.target.value)}>
                  <option value={58}>58 mm</option>
                  <option value={80}>80 mm</option>
                </select>
              </div>
              <div className="flex items-end gap-4 pb-1">
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="checkbox" checked={f.showToken}
                    onChange={(e) => set('showToken', e.target.checked)} />
                  Show token #
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="checkbox" checked={f.showTaxBreakdown}
                    onChange={(e) => set('showTaxBreakdown', e.target.checked)} />
                  Show tax breakdown
                </label>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Live preview — styled like an actual thermal-printed receipt */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Live preview</CardTitle>
            <CardDescription className="text-xs">{f.paperWidthMm}mm thermal</CardDescription>
          </CardHeader>
          <CardContent>
            <div
              className="mx-auto bg-white border-2 border-dashed p-3 font-mono text-[11px] whitespace-pre"
              style={{
                width: f.paperWidthMm === 58 ? 220 : 280,
                lineHeight: 1.35,
              }}
            >
              {f.logoUrl && (
                <div className="text-center mb-2">
                  <img src={f.logoUrl} alt="" className="inline-block max-h-16 object-contain" />
                </div>
              )}
              <div className="text-center font-bold">
                {(f.headerLines || '').split('\n').filter(Boolean).map((l: string, i: number) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
              {f.gstin && <div className="text-center text-[10px]">GSTIN: {f.gstin}</div>}
              {f.fssaiNo && <div className="text-center text-[10px]">FSSAI: {f.fssaiNo}</div>}
              <div className="border-t border-dashed my-2" />
              <div>Order #42 · {new Date().toLocaleString()}</div>
              <div>Server: Cashier</div>
              <div className="border-t border-dashed my-2" />
              <div className="flex justify-between"><span>2× Paneer Tikka</span><span>{formatINR(540)}</span></div>
              <div className="flex justify-between"><span>1× Butter Naan</span><span>{formatINR(60)}</span></div>
              <div className="border-t border-dashed my-2" />
              <div className="flex justify-between"><span>Subtotal</span><span>{formatINR(600)}</span></div>
              <div className="flex justify-between"><span>Service 5%</span><span>{formatINR(30)}</span></div>
              {f.showTaxBreakdown && (
                <>
                  <div className="flex justify-between"><span>CGST 2.5%</span><span>{formatINR(15)}</span></div>
                  <div className="flex justify-between"><span>SGST 2.5%</span><span>{formatINR(15)}</span></div>
                </>
              )}
              <div className="flex justify-between"><span>Round off</span><span>−{formatINR(0)}</span></div>
              <div className="flex justify-between font-bold mt-1 border-t pt-1">
                <span>TOTAL</span><span>{formatINR(660)}</span>
              </div>
              <div className="border-t border-dashed my-2" />
              {f.showToken && (
                <div className="text-center text-base font-extrabold tracking-wider my-1">
                  TOKEN #47
                </div>
              )}
              {f.footerText && (
                <div className="text-center mt-2">{f.footerText}</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
