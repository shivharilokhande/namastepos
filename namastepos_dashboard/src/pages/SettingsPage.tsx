import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi } from '@/api/namastepos';
import { apiError, setBusinessCache } from '@/api/client';

export function SettingsPage() {
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: ffApi.me });
  const [form, setForm] = useState<any>({});

  useEffect(() => {
    if (me?.business) setForm({
      name: me.business.name || '',
      phone: me.business.phone || '',
      city: me.business.city || '',
      category: me.business.category || '',
      gstin: me.business.gstin || '',
      address: me.business.address || '',
      upi_id: me.business.upiId || '',
      bank_account: me.business.bankAccount || '',
      bank_ifsc: me.business.bankIfsc || '',
    });
  }, [me]);

  const save = useMutation({
    mutationFn: () => ffApi.patchMe(form),
    onSuccess: (res: any) => {
      toast.success('Saved');
      if (res.business) setBusinessCache(res.business);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Business profile, used on receipts and reports.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Business profile</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><Label>Name</Label><Input value={form.name || ''} onChange={(e) => set('name', e.target.value)} /></div>
          <div><Label>Phone</Label><Input value={form.phone || ''} onChange={(e) => set('phone', e.target.value)} /></div>
          <div><Label>City</Label><Input value={form.city || ''} onChange={(e) => set('city', e.target.value)} /></div>
          <div><Label>Category</Label><Input value={form.category || ''} onChange={(e) => set('category', e.target.value)} /></div>
          <div className="md:col-span-2"><Label>Address</Label><Input value={form.address || ''} onChange={(e) => set('address', e.target.value)} /></div>
          <div><Label>GSTIN</Label><Input value={form.gstin || ''} onChange={(e) => set('gstin', e.target.value)} /></div>
          <div><Label>UPI ID</Label><Input value={form.upi_id || ''} onChange={(e) => set('upi_id', e.target.value)} placeholder="yourbusiness@upi" /></div>
          <div><Label>Bank account</Label><Input value={form.bank_account || ''} onChange={(e) => set('bank_account', e.target.value)} /></div>
          <div><Label>IFSC</Label><Input value={form.bank_ifsc || ''} onChange={(e) => set('bank_ifsc', e.target.value)} /></div>
          <div className="md:col-span-2 flex justify-end">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
