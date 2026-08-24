// WhatsApp marketing campaigns (FF-1004)
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MessageCircle, Plus, Send } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';

export function CampaignsPage() {
  const qc = useQueryClient();
  const { data: campaigns = [] } = useQuery({ queryKey: ['wa-campaigns'], queryFn: ffApi.listCampaigns });
  const [adding, setAdding] = useState(false);
  const run = useMutation({
    mutationFn: (id: string) => ffApi.runCampaign(id),
    onSuccess: (r: any) => { toast.success(`Sent to ${r.sent} customers`); qc.invalidateQueries({ queryKey: ['wa-campaigns'] }); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <MessageCircle className="h-6 w-6 text-green-600" /> WhatsApp campaigns
          </h1>
          <p className="text-muted-foreground text-sm">Broadcast promos to your customer database. Tokens: <code>{`{name}`}</code></p>
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />New campaign</Button>
      </div>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground border-b">
            <tr><th className="p-3">Name</th><th>Status</th><th>Audience</th><th>Sent</th><th></th></tr>
          </thead>
          <tbody>
            {campaigns.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">No campaigns yet.</td></tr>}
            {campaigns.map((c: any) => (
              <tr key={c.id} className="border-b">
                <td className="p-3 font-medium">{c.name}</td>
                <td><Badge variant={c.status === 'done' ? 'success' : c.status === 'running' ? 'warning' : 'muted'}>{c.status}</Badge></td>
                <td>{c.recipient_count}</td>
                <td>{c.sent_count} / {c.recipient_count}</td>
                <td><Button size="sm" variant="outline" onClick={() => run.mutate(c.id)} disabled={c.status === 'done'}>
                  <Send className="mr-1 h-3 w-3" />Send</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      {adding && <NewCampaign onClose={() => setAdding(false)} onCreated={() => { qc.invalidateQueries({ queryKey:['wa-campaigns'] }); setAdding(false); }} />}
    </div>
  );
}

function NewCampaign({ onClose, onCreated }: any) {
  const [f, setF] = useState({ name: '', templateBody: 'Hi {name}, special offer just for you — 20% off this weekend!' });
  const save = useMutation({
    mutationFn: () => ffApi.createCampaign(f),
    onSuccess: () => { toast.success('Campaign scheduled'); onCreated(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New WhatsApp campaign</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Campaign name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><Label>Message body</Label>
            <textarea value={f.templateBody} onChange={(e) => setF({ ...f, templateBody: e.target.value })}
              rows={6} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            <div className="text-xs text-muted-foreground mt-1">Audience: all customers with marketing-optin = true</div>
          </div>
        </div>
        <DialogFooter><Button onClick={() => save.mutate()} disabled={!f.name || !f.templateBody}>Schedule</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
