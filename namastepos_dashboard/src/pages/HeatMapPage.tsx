// Heat-map of busy hours (F40)
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/api/client';
import { getBusinessCache } from '@/api/client';

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function HeatMapPage() {
  const { data: heat = [] } = useQuery({
    queryKey: ['heatmap'],
    queryFn: async () => {
      const b = getBusinessCache();
      // Reuse the reports endpoint pattern. For simplicity, use raw orders aggregate.
      const r = await api.get(`/businesses/${b.id}/reports/orders-by-hour`).catch(() => ({ data: { rows: [] } }));
      return r.data?.rows || [];
    },
  });

  const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const r of heat) {
    matrix[r.day_of_week][r.hour_of_day] = r.order_count;
    if (r.order_count > max) max = r.order_count;
  }
  const cellColor = (v: number) => {
    if (v === 0) return 'bg-muted';
    const intensity = Math.min(1, v / Math.max(1, max));
    if (intensity > 0.75) return 'bg-red-600 text-white';
    if (intensity > 0.5)  return 'bg-orange-500 text-white';
    if (intensity > 0.25) return 'bg-amber-300';
    return 'bg-emerald-200';
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="h-6 w-6 text-primary" /> Busy hours
        </h1>
        <p className="text-muted-foreground text-sm">When do orders peak? Plan staffing accordingly.</p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Orders by day × hour</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <div className="inline-grid" style={{ gridTemplateColumns: 'auto repeat(24, 24px)' }}>
            <div></div>
            {HOURS.map((h) => <div key={h} className="text-[10px] text-center text-muted-foreground">{h}</div>)}
            {DAYS.map((d, di) => (
              <>
                <div key={d} className="text-xs pr-2 text-muted-foreground">{d}</div>
                {HOURS.map((h) => (
                  <div key={`${di}-${h}`}
                    className={`h-6 text-[9px] text-center leading-6 border ${cellColor(matrix[di][h])}`}
                    title={`${d} ${h}:00 → ${matrix[di][h]} orders`}>
                    {matrix[di][h] > 0 ? matrix[di][h] : ''}
                  </div>
                ))}
              </>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
