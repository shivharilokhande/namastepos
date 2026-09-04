import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatDateTime } from '@/lib/utils';

const MODULES = ['', 'customers', 'plans', 'coupons', 'refunds', 'settings', 'admin-team', 'addons', 'menu'];

export function AuditPage() {
  const [module, setModule] = useState('');
  const { data: events = [], isError, error, refetch } = useQuery({
    queryKey: ['audit', module],
    queryFn: () => adminApi.auditLog({ module: module || undefined, limit: 200 }),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Audit log</h1>
        <p className="text-muted-foreground">
          Every action your admin team takes. Last 200 events. Refreshes every 10s.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <select value={module} onChange={(e) => setModule(e.target.value)}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              {MODULES.map((m) => <option key={m} value={m}>{m || 'All modules'}</option>)}
            </select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>When</TableHead><TableHead>Admin</TableHead>
              <TableHead>Module</TableHead><TableHead>Action</TableHead>
              <TableHead>Target</TableHead><TableHead>Business</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {isError && (
                // An empty audit log is a claim ("nobody did anything"). Never
                // make it on a failed fetch.
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10">
                    <div className="text-sm text-destructive">Couldn't load the audit log — {apiError(error)}</div>
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
                  </TableCell>
                </TableRow>
              )}
              {!isError && events.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">No events.</TableCell></TableRow>
              )}
              {events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-xs whitespace-nowrap">{formatDateTime(e.createdAt)}</TableCell>
                  <TableCell className="text-sm">{e.adminEmail || '—'}</TableCell>
                  <TableCell><Badge variant="muted">{e.module}</Badge></TableCell>
                  <TableCell className="font-mono text-xs">{e.action}</TableCell>
                  <TableCell className="text-xs">{e.entityType}{e.entityId ? `:${e.entityId.slice(0, 8)}` : ''}</TableCell>
                  <TableCell className="text-sm">{e.businessName || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
