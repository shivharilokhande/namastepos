// Kitchen Display System (F38)
import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChefHat, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';

export function KdsPage() {
  const qc = useQueryClient();
  const { data: stations = [] } = useQuery({ queryKey: ['kot-stations'], queryFn: () => ffApi.listStations() });
  const [stationId, setStationId] = useState<string>('');
  useEffect(() => { if (!stationId && stations[0]) setStationId(stations[0].id); }, [stations, stationId]);

  const { data: tickets = [] } = useQuery({
    queryKey: ['kds', stationId],
    queryFn: () => stationId ? ffApi.pollKds(stationId) : Promise.resolve([]),
    enabled: !!stationId,
    refetchInterval: 5000,
  });

  const mark = useMutation({
    mutationFn: ({ id, status }: any) => ffApi.markKdsTicket(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kds'] }),
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ChefHat className="h-6 w-6 text-primary" /> Kitchen Display
          </h1>
          <p className="text-muted-foreground text-sm">Live ticket board for {stations.find((s: any) => s.id === stationId)?.name || 'kitchen'}.</p>
        </div>
        {stations.length > 0 && (
          <select value={stationId} onChange={(e) => setStationId(e.target.value)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            {stations.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {tickets.length === 0 && (
          <div className="col-span-full text-center text-muted-foreground p-12">
            ✅ All clear — no pending tickets.
          </div>
        )}
        {tickets.map((t: any) => {
          const elapsed = Math.round((Date.now() - new Date(t.created_at).getTime()) / 60000);
          const isLate = elapsed > 15;
          return (
            <Card key={t.id} className={isLate ? 'border-red-400 bg-red-50' : t.status === 'in_progress' ? 'border-amber-400 bg-amber-50' : ''}>
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <div className="font-extrabold text-2xl">#{t.order_no}</div>
                  <div className={`text-xs px-1.5 rounded ${isLate ? 'bg-red-600 text-white' : 'bg-muted'}`}>
                    {elapsed}m
                  </div>
                </div>
                <div className="text-xs text-muted-foreground capitalize">{t.source}{t.table_no ? ` · T${t.table_no}` : ''}</div>
                <ul className="mt-2 text-sm space-y-0.5">
                  {(t.items || []).map((it: any) => (
                    <li key={it.id}><strong>{it.qty}×</strong> {it.name}{it.note && <span className="block text-xs italic text-muted-foreground">"{it.note}"</span>}</li>
                  ))}
                </ul>
                <div className="mt-3 flex gap-2">
                  {t.status === 'pending' && (
                    <Button size="sm" variant="outline" className="flex-1"
                      onClick={() => mark.mutate({ id: t.id, status: 'in_progress' })}>
                      Start
                    </Button>
                  )}
                  <Button size="sm" className="flex-1"
                    onClick={() => mark.mutate({ id: t.id, status: 'done' })}>
                    <CheckCircle2 className="mr-1 h-3 w-3" /> Done
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
