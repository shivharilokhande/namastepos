// Surge / time-of-day delivery pricing (F46)
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Zap, Plus, Pencil, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function minToHHMM(m: number) {
  const h = Math.floor(m / 60), mm = m % 60;
  return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}
function hhmmToMin(s: string) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function SurgePage() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any | null>(null); // 2026-08-23 — full CRUD
  const { data: rules = [] } = useQuery({ queryKey: ['surge-rules'], queryFn: ffApi.listSurgeRules });
  const del = useMutation({
    mutationFn: (id: string) => ffApi.deleteSurgeRule(id),
    onSuccess: () => { toast.success('Surge rule deleted'); qc.invalidateQueries({ queryKey: ['surge-rules'] }); },
    onError: (e) => toast.error(apiError(e)),
  });
  // Hardcode-audit fix (2026-08-24): removed a dead `surge-current` query
  // (enabled:false, result unused) that carried a literal '_' business id
  // and a hardcoded relative /v1 URL.
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Zap className="h-6 w-6 text-amber-500" /> Surge pricing
          </h1>
          <p className="text-muted-foreground text-sm">Multiply delivery fees during peak hours.</p>
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />New rule</Button>
      </div>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground border-b">
            <tr><th className="p-3">Name</th><th>Day</th><th>Window</th><th>Multiplier</th><th>Flat extra</th><th></th></tr>
          </thead>
          <tbody>
            {rules.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">No surge rules. Add one to start charging more during rush.</td></tr>}
            {rules.map((r: any) => (
              <tr key={r.id} className="border-b">
                <td className="p-3 font-medium">{r.name}</td>
                <td>{r.day_of_week === null ? 'Any' : DAYS[r.day_of_week]}</td>
                <td className="text-xs">{minToHHMM(r.start_minute)} → {minToHHMM(r.end_minute)}</td>
                <td><Badge variant="warning">×{r.multiplier}</Badge></td>
                <td>{r.flat_extra_paise ? formatINR(r.flat_extra_paise / 100) : '—'}</td>
                <td className="p-2 text-right whitespace-nowrap">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(r)} title="Edit">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Delete "${r.name}"?`)) del.mutate(r.id); }} title="Delete">
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      {adding && <NewSurge onClose={() => setAdding(false)} onCreated={() => { qc.invalidateQueries({ queryKey:['surge-rules'] }); setAdding(false); }} />}
      {editing && <NewSurge existing={editing} onClose={() => setEditing(null)} onCreated={() => { qc.invalidateQueries({ queryKey:['surge-rules'] }); setEditing(null); }} />}
    </div>
  );
}

function NewSurge({ onClose, onCreated, existing }: any) {
  const [f, setF] = useState(existing ? {
    name: existing.name,
    dayOfWeek: existing.day_of_week,
    startMinute: existing.start_minute,
    endMinute: existing.end_minute,
    multiplier: parseFloat(existing.multiplier),
    flatExtraInr: (existing.flat_extra_paise || 0) / 100,
  } : { name: 'Friday dinner rush', dayOfWeek: 5, startMinute: hhmmToMin('19:00'), endMinute: hhmmToMin('22:00'), multiplier: 1.5, flatExtraInr: 0 });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, flatExtraPaise: Math.round(f.flatExtraInr * 100) } as any;
      delete body.flatExtraInr;
      return existing
        ? ffApi.updateSurgeRule(existing.id, body)
        : ffApi.createSurgeRule(body);
    },
    onSuccess: () => { toast.success('Surge rule saved'); onCreated(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{existing ? 'Edit surge rule' : 'New surge rule'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid grid-cols-3 gap-2">
            <div><Label>Day</Label>
              <select value={f.dayOfWeek ?? -1} onChange={(e) => setF({ ...f, dayOfWeek: e.target.value === '-1' ? null as any : +e.target.value })}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value={-1}>Any</option>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </div>
            <div><Label>Start</Label><Input type="time" value={minToHHMM(f.startMinute)} onChange={(e) => setF({ ...f, startMinute: hhmmToMin(e.target.value) })} /></div>
            <div><Label>End</Label><Input type="time" value={minToHHMM(f.endMinute)} onChange={(e) => setF({ ...f, endMinute: hhmmToMin(e.target.value) })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Multiplier (×)</Label><Input type="number" step="0.1" value={f.multiplier} onChange={(e) => setF({ ...f, multiplier: +e.target.value })} /></div>
            <div><Label>Flat extra (₹)</Label><Input type="number" value={f.flatExtraInr} onChange={(e) => setF({ ...f, flatExtraInr: +e.target.value })} /></div>
          </div>
        </div>
        <DialogFooter><Button onClick={() => save.mutate()}>Save rule</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
