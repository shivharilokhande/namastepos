// Captain / waiter mode (F37) — simplified POS for floor staff with tablet.
// Picks a table, adds items, sends KOT. No bill-settle here — that's at counter.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, ChefHat } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NewOrderDialog } from '@/components/NewOrderDialog';
import { ffApi } from '@/api/namastepos';
import { formatINR } from '@/lib/utils';

export function CaptainPage() {
  const { data: tables = [] } = useQuery({
    queryKey: ['ops-tables'], queryFn: () => ffApi.listOpsTables(), refetchInterval: 5000,
  });
  const [orderingFor, setOrderingFor] = useState<any | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ChefHat className="h-6 w-6 text-primary" /> Captain mode
        </h1>
        <p className="text-muted-foreground text-sm">Quick tablet view — tap a table to take or extend an order.</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {tables.map((t: any) => {
          const occupied = t.status === 'occupied';
          return (
            <Card key={t.id} className={occupied ? 'border-amber-400 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}>
              <CardContent className="p-4 text-center">
                <div className="text-3xl font-extrabold">{t.label}</div>
                <div className="text-xs flex items-center justify-center gap-1"><Users className="h-3 w-3" />{t.seats}</div>
                <Badge variant="muted" className="text-[10px] capitalize my-2">{t.status}</Badge>
                {occupied && t.sessionTotalInr != null && (
                  <div className="text-sm font-bold text-amber-700">{formatINR(+t.sessionTotalInr)}</div>
                )}
                <Button size="sm" className="w-full mt-2"
                  onClick={() => setOrderingFor(t)}>
                  {occupied ? 'Add items' : 'Open table'}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {orderingFor && (
        <NewOrderDialog
          onClose={() => setOrderingFor(null)}
          existingSession={orderingFor.currentSessionId ? {
            id: orderingFor.currentSessionId,
            tableId: orderingFor.id,
            tableLabel: orderingFor.label,
          } : null as any}
        />
      )}
    </div>
  );
}
