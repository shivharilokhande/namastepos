import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatDateTime, formatINR } from '@/lib/utils';

// L2 (2026-08-28) — referral program admin view + payouts.

interface Referral {
  id: string; referrerName: string; referredName: string; code: string;
  status: string; createdAt: string; awardedAt: string | null;
}
const STATUS_VARIANT: Record<string, any> = { pending: 'warning', signed_up: 'secondary', awarded: 'success' };

export function ReferralsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const { data: referrals = [] } = useQuery<Referral[]>({
    queryKey: ['referrals', status],
    queryFn: () => adminApi.referrals({ status: status || undefined }),
  });
  const { data: payouts } = useQuery({ queryKey: ['addon-payouts'], queryFn: () => adminApi.addonPayouts() });

  const reward = useMutation({
    mutationFn: (id: string) => adminApi.referralReward(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['referrals'] }); toast.success('Awarded — both got +30 days'); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Referrals & partners</h1>
        <p className="text-muted-foreground">{referrals.length} referrals · restaurant-to-restaurant growth</p>
      </div>

      <div className="flex gap-2">
        <select className="h-9 rounded-md border bg-background px-3 text-sm"
          value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="pending">Pending (code shared)</option>
          <option value="signed_up">Signed up</option>
          <option value="awarded">Awarded</option>
        </select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Referred by</TableHead><TableHead>New restaurant</TableHead>
              <TableHead>Code</TableHead><TableHead>Status</TableHead>
              <TableHead>Signed up</TableHead><TableHead className="text-right">Action</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {referrals.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">No referrals yet.</TableCell></TableRow>
              )}
              {referrals.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.referrerName}</TableCell>
                  <TableCell>{r.referredName}</TableCell>
                  <TableCell className="font-mono text-xs">{r.code}</TableCell>
                  <TableCell><Badge variant={STATUS_VARIANT[r.status] || 'muted'}>{r.status}</Badge></TableCell>
                  <TableCell className="text-sm">{formatDateTime(r.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    {r.status === 'signed_up' ? (
                      <Button size="sm" variant="ghost" onClick={() => reward.mutate(r.id)} disabled={reward.isPending}>Award +30d</Button>
                    ) : r.status === 'awarded' ? <span className="text-xs text-muted-foreground">✓ awarded</span>
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* L5 — add-on partner payouts */}
      <div>
        <h2 className="text-lg font-semibold mb-2">Add-on partner payouts</h2>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Add-on</TableHead><TableHead>Partner</TableHead>
                <TableHead className="text-right">Active</TableHead><TableHead className="text-right">Share %</TableHead>
                <TableHead className="text-right">Gross</TableHead><TableHead className="text-right">Payout</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {(!payouts || payouts.rows.length === 0) && (
                  <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No partner add-ons configured.</TableCell></TableRow>
                )}
                {payouts?.rows?.map((p: any) => (
                  <TableRow key={p.slug}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>{p.partner}</TableCell>
                    <TableCell className="text-right">{p.activeCount}</TableCell>
                    <TableCell className="text-right">{p.revenueSharePct}%</TableCell>
                    <TableCell className="text-right">{formatINR(p.grossInr)}</TableCell>
                    <TableCell className="text-right font-medium">{formatINR(p.payoutInr)}</TableCell>
                  </TableRow>
                ))}
                {payouts?.rows?.length > 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-right font-semibold">Total payout</TableCell>
                    <TableCell className="text-right font-bold">{formatINR(payouts.totals.payoutInr)}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
