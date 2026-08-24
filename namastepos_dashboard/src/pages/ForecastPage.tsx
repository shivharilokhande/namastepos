// Inventory forecast (F45)
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { TrendingUp, RefreshCw, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';

export function ForecastPage() {
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ['forecast'], queryFn: () => ffApi.forecast() });
  const refresh = useMutation({
    mutationFn: () => ffApi.refreshForecast(),
    onSuccess: (r: any) => { toast.success(`Forecast refreshed (${r.updated} items)`); qc.invalidateQueries({ queryKey: ['forecast'] }); },
    onError: (e) => toast.error(apiError(e)),
  });
  const needReorder = rows.filter((r: any) => r.needsReorder);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-primary" /> Demand forecast
          </h1>
          <p className="text-muted-foreground text-sm">What you'll likely need tomorrow — based on the last 14 days.</p>
        </div>
        <Button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </div>

      {needReorder.length > 0 && (
        <Card className="border-amber-300 bg-amber-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-amber-900">
              <AlertTriangle className="h-5 w-5" /> {needReorder.length} ingredient(s) need reorder
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            {needReorder.slice(0, 10).map((r: any) => (
              <div key={r.ingredient_id} className="flex justify-between border-b py-1">
                <span><strong>{r.name}</strong> — need {(+r.expected_qty).toFixed(2)} {r.unit}, have {(+r.stock).toFixed(2)}</span>
                <span className="font-bold text-amber-700">Short {(+r.shortBy).toFixed(2)} {r.unit}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Full forecast</CardTitle><CardDescription>Sorted by expected qty.</CardDescription></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground border-b">
              <tr><th className="p-3">Ingredient</th><th>Expected</th><th>Stock</th><th>Status</th></tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={4} className="p-8 text-center text-muted-foreground">Loading…</td></tr>}
              {!isLoading && rows.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-muted-foreground">No forecast yet — click Refresh.</td></tr>}
              {rows.map((r: any) => (
                <tr key={r.ingredient_id} className="border-b">
                  <td className="p-3 font-medium">{r.name}</td>
                  <td>{(+r.expected_qty).toFixed(2)} {r.unit}</td>
                  <td>{(+r.stock).toFixed(2)} {r.unit}</td>
                  <td>{r.needsReorder ? <Badge variant="destructive">REORDER</Badge> : <Badge variant="success">OK</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
