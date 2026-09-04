import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatDateTime } from '@/lib/utils';

export function WebhooksPage() {
  const { data: events = [], isError, error, refetch } = useQuery({
    queryKey: ['webhook-events'], queryFn: adminApi.webhookEvents,
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Webhook events</h1>
        <p className="text-muted-foreground">
          Razorpay deliveries. Last 200. Refreshes every 15s. Errored events show their failure reason.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>When</TableHead><TableHead>Provider</TableHead>
              <TableHead>Event</TableHead><TableHead>External ID</TableHead>
              <TableHead>Status</TableHead><TableHead>Error</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {isError && (
                // "No webhook events yet" on a failed fetch reads as a healthy
                // integration. Say the load failed instead.
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10">
                    <div className="text-sm text-destructive">Couldn't load webhook events — {apiError(error)}</div>
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
                  </TableCell>
                </TableRow>
              )}
              {!isError && events.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">No webhook events yet.</TableCell></TableRow>
              )}
              {events.map((e: any) => (
                <TableRow key={e.id}>
                  <TableCell className="text-xs whitespace-nowrap">{formatDateTime(e.created_at)}</TableCell>
                  <TableCell><Badge variant="muted">{e.provider}</Badge></TableCell>
                  <TableCell className="font-mono text-xs">{e.event_type}</TableCell>
                  <TableCell className="font-mono text-xs">{e.external_id?.slice(0, 24)}</TableCell>
                  <TableCell>
                    {e.error ? <Badge variant="destructive">failed</Badge>
                      : e.processed_at ? <Badge variant="success">processed</Badge>
                      : <Badge variant="warning">pending</Badge>}
                  </TableCell>
                  <TableCell className="text-xs text-destructive max-w-md truncate">{e.error || ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
