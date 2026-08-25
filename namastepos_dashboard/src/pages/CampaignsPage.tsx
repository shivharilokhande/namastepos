// WhatsApp marketing campaigns (FF-1004)
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, MessageCircle, Plus, Send } from 'lucide-react';
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
  // WHY (2026-08-25): the backend stamps provider_configured on every campaign
  // row (deployment-level fact, same on all rows). `!== false` keeps older API
  // responses (field absent) from falsely showing the "not connected" banner.
  const providerConfigured = campaigns.length === 0 || campaigns[0].provider_configured !== false;
  const run = useMutation({
    mutationFn: (id: string) => ffApi.runCampaign(id),
    onSuccess: (r: any) => {
      // WHY (2026-08-25): without Twilio/Meta creds nothing is delivered — the
      // old "Sent to 0 customers" toast pretended success. Say "queued" honestly.
      if (r.providerConfigured === false) {
        toast.warning(`Queued ${r.queued} message${r.queued === 1 ? '' : 's'} — WhatsApp provider not connected, nothing was delivered yet`);
      } else {
        toast.success(`Sent to ${r.sent} customers`);
      }
      qc.invalidateQueries({ queryKey: ['wa-campaigns'] });
    },
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
      {/* WHY (2026-08-25): founder saw "sent 0/1" with no clue that outbound WA
          was never wired up in prod. Make the missing provider loud and amber. */}
      {!providerConfigured && (
        <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <div className="font-semibold">WhatsApp sending is not connected yet</div>
            <div>Messages will queue but not deliver. Connect a WhatsApp Business provider (Twilio/Meta) in backend settings.</div>
          </div>
        </div>
      )}
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
                {/* WHY (2026-08-25): "0 / 1" looked like a failure. With no
                    provider connected nothing was ever attempted — say so.
                    Covers legacy rows already marked 'done' with sent 0. */}
                <td>
                  {!providerConfigured && Number(c.sent_count) === 0 && Number(c.recipient_count) > 0
                    ? <span className="text-amber-700">queued, awaiting provider</span>
                    : <>{c.sent_count} / {c.recipient_count}</>}
                </td>
                {/* WHY (2026-08-25): legacy rows got marked 'done' with 0 sent when the
                    provider was missing — keep Send enabled for those so they can
                    actually go out once Twilio/Meta is connected. */}
                <td><Button size="sm" variant="outline" onClick={() => run.mutate(c.id)}
                  disabled={run.isPending || (c.status === 'done' && Number(c.sent_count) > 0)}>
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
