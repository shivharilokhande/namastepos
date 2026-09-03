// NamastePOS dashboard — Outlets (2026-09-03).
//
// One table of every outlet the signed-in user can switch into (the same
// ungated /outlet-groups/my-outlets feed the sidebar switcher uses), plus
// — for owners on a plan/addon that includes `multi_outlet` — the
// consolidated GROUP ROLLUP: revenue and order count per outlet for a date
// range, from /outlet-groups/:groupId/rollup.
//
// The rollup is the ONLY thing shared across outlets. Everything else
// (menu, tables, staff, orders, settings, reports) is per-outlet, which is
// why switching swaps the session token and clears the query cache.
//
// A 402 FEATURE_LOCKED from the rollup (or from create) renders the
// multi-outlet upsell instead of a broken card.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, Loader2, Lock, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { CreateOutletDialog, OutletUpsellDialog } from '@/components/OutletSwitcher';
import { ffApi } from '@/api/namastepos';
import { getBusinessCache } from '@/api/client';
import { featureLockedInfo, useMyOutlets, useOutletSwitch } from '@/hooks/useOutletSwitch';
import { formatINR } from '@/lib/utils';

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const ROLE_LABEL: Record<string, string> = {
  business_owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  waiter: 'Waiter',
  chef: 'Kitchen',
};

export function OutletsPage() {
  const outletsQ = useMyOutlets();
  const switcher = useOutletSwitch();
  const [createOpen, setCreateOpen] = useState(false);
  const [upsell, setUpsell] = useState<{ open: boolean; requiredTier?: string }>({ open: false });
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(daysAgo(0));

  const outlets = outletsQ.data || [];
  const current = outlets.find((o) => o.current) || null;
  const isOwner = (current?.role || getBusinessCache()?.role) === 'business_owner';
  const groupId = current?.groupId || null;

  // Owner + a group + multi_outlet. The last one we can't know locally, so
  // we just call it and treat a 402 as "locked" (see below) — one source of
  // truth (the backend) instead of a second client-side gate that can drift.
  const rollupQ = useQuery({
    queryKey: ['outlet-rollup', groupId, from, to],
    queryFn: () => ffApi.outletRollup(groupId as string, { startDate: from, endDate: to }),
    enabled: !!groupId && isOwner,
    retry: false,
  });
  const rollupLocked = featureLockedInfo(rollupQ.error);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Building2 className="h-6 w-6" /> Outlets
          </h1>
          <p className="text-muted-foreground text-sm">
            Each outlet keeps its own menu, tables, staff, orders, settings and
            reports. Only the group revenue rollup below spans all of them.
          </p>
        </div>
        {isOwner && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Create outlet
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Your outlets{current?.groupName ? ` · ${current.groupName}` : ''}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Your role</TableHead>
                <TableHead className="text-right">&nbsp;</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outletsQ.isLoading && (
                <TableRow><TableCell colSpan={5} className="text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!outletsQ.isLoading && outlets.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-muted-foreground">No outlets found.</TableCell></TableRow>
              )}
              {outlets.map((o) => (
                <TableRow key={o.businessId}>
                  <TableCell className="font-medium">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {o.outletLabel || o.name}
                      {o.isParent && <Badge variant="secondary">HQ</Badge>}
                      {o.current && <Badge>Current</Badge>}
                    </span>
                  </TableCell>
                  <TableCell>{o.name}</TableCell>
                  <TableCell>{o.city || '—'}</TableCell>
                  <TableCell>{ROLE_LABEL[o.role] || o.role}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={o.current || switcher.isPending}
                      onClick={() => switcher.mutate(o)}
                    >
                      {switcher.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {o.current ? 'You are here' : 'Switch'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {isOwner && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Group revenue rollup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!groupId && (
              <p className="text-sm text-muted-foreground">
                This outlet isn&apos;t part of an outlet group yet — create a second
                outlet and the consolidated rollup appears here.
              </p>
            )}

            {groupId && rollupLocked && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-4 text-sm">
                <div className="mb-1 flex items-center gap-2 font-semibold">
                  <Lock className="h-4 w-4" /> Multi-outlet is a Pro feature
                </div>
                <p className="text-muted-foreground">
                  Add the Multi-outlet add-on or upgrade
                  {rollupLocked.requiredTier ? ` to ${rollupLocked.requiredTier}` : ' your plan'} to
                  see consolidated revenue across every outlet.
                </p>
                <Button className="mt-3" size="sm" onClick={() => setUpsell({ open: true, requiredTier: rollupLocked.requiredTier })}>
                  See options
                </Button>
              </div>
            )}

            {groupId && !rollupLocked && (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <Label>From</Label>
                    <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="max-w-[180px]" />
                  </div>
                  <div>
                    <Label>To</Label>
                    <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="max-w-[180px]" />
                  </div>
                  <Button variant="outline" onClick={() => rollupQ.refetch()}>Refresh</Button>
                  <div className="ml-auto text-right">
                    <div className="text-xs text-muted-foreground">
                      Total revenue · {rollupQ.data?.totals?.orders ?? 0} orders
                    </div>
                    <div className="text-2xl font-bold">
                      {formatINR(rollupQ.data?.totals?.grossInr || 0)}
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Outlet</TableHead>
                        <TableHead className="text-right">Orders</TableHead>
                        <TableHead className="text-right">Revenue</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rollupQ.isLoading && (
                        <TableRow><TableCell colSpan={3} className="text-muted-foreground">Loading…</TableCell></TableRow>
                      )}
                      {rollupQ.isError && !rollupLocked && (
                        <TableRow><TableCell colSpan={3} className="text-muted-foreground">
                          Couldn&apos;t load the rollup. Try Refresh.
                        </TableCell></TableRow>
                      )}
                      {(rollupQ.data?.outlets || []).map((r) => (
                        <TableRow key={r.businessId}>
                          <TableCell className="font-medium">{r.outletLabel || r.name}</TableCell>
                          <TableCell className="text-right">{Number(r.metrics.orders) || 0}</TableCell>
                          <TableCell className="text-right">{formatINR(Number(r.metrics.gross) || 0)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <CreateOutletDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onLocked={(requiredTier) => setUpsell({ open: true, requiredTier })}
      />
      <OutletUpsellDialog
        open={upsell.open}
        onOpenChange={(v) => setUpsell((u) => ({ ...u, open: v }))}
        requiredTier={upsell.requiredTier}
      />
    </div>
  );
}
