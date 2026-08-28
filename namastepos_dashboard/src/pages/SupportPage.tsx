// NamastePOS dashboard — tenant support / ticketing (X7 tenant side).
// Raise a ticket and read replies from the NamastePOS support team.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy, Plus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ffApi } from '@/api/namastepos';

interface Ticket {
  id: string; subject: string; status: string; priority: string;
  lastReplyAt: string | null; createdAt: string; messageCount?: number;
}
interface Message { id: string; authorType: string; body: string; createdAt: string; }

const STATUS_COLOR: Record<string, string> = {
  open: 'bg-amber-100 text-amber-800', pending: 'bg-blue-100 text-blue-800',
  resolved: 'bg-green-100 text-green-800', closed: 'bg-gray-100 text-gray-600',
};

function fmt(d: string | null) {
  return d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

export function SupportPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { data: tickets = [] } = useQuery<Ticket[]>({ queryKey: ['support'], queryFn: () => ffApi.supportTickets() });

  if (openId) return <TicketThread id={openId} onBack={() => setOpenId(null)} />;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><LifeBuoy className="h-6 w-6" /> Support</h1>
          <p className="text-muted-foreground">Raise a ticket and our team will reply here.</p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" /> New ticket</Button>
      </div>

      {tickets.length === 0 && !creating && (
        <Card><CardContent className="py-12 text-center text-muted-foreground">
          No tickets yet. Tap “New ticket” if you need help.
        </CardContent></Card>
      )}

      <div className="space-y-3">
        {tickets.map((t) => (
          <Card key={t.id} className="cursor-pointer hover:border-primary/50" onClick={() => setOpenId(t.id)}>
            <CardContent className="p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium truncate">{t.subject}</div>
                <div className="text-sm text-muted-foreground">{t.messageCount ?? 0} messages · {fmt(t.lastReplyAt || t.createdAt)}</div>
              </div>
              <span className={`text-xs px-2 py-1 rounded-full ${STATUS_COLOR[t.status] || 'bg-gray-100'}`}>{t.status}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      {creating && <NewTicket onClose={(id) => { setCreating(false); if (id) setOpenId(id); }} />}
    </div>
  );
}

function NewTicket({ onClose }: { onClose: (id?: string) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ subject: '', priority: 'normal', body: '' });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const create = useMutation({
    mutationFn: () => ffApi.createSupportTicket({ subject: form.subject.trim(), priority: form.priority, body: form.body.trim() }),
    onSuccess: (t: any) => { qc.invalidateQueries({ queryKey: ['support'] }); onClose(t.id); },
  });
  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="font-semibold">New ticket</div>
        <Input placeholder="Subject" value={form.subject} onChange={(e) => set('subject', e.target.value)} />
        <select className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={form.priority} onChange={(e) => set('priority', e.target.value)}>
          <option value="low">Low</option><option value="normal">Normal</option>
          <option value="high">High</option><option value="critical">Critical — service down</option>
        </select>
        <textarea className="w-full min-h-28 rounded-md border bg-background p-2 text-sm"
          placeholder="Describe the issue…" value={form.body} onChange={(e) => set('body', e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onClose()}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!form.subject.trim() || !form.body.trim() || create.isPending}>
            {create.isPending ? 'Submitting…' : 'Submit ticket'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TicketThread({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const [reply, setReply] = useState('');
  const { data: ticket } = useQuery({ queryKey: ['support', id], queryFn: () => ffApi.supportTicket(id) });
  const send = useMutation({
    mutationFn: () => ffApi.replySupportTicket(id, reply.trim()),
    onSuccess: () => { setReply(''); qc.invalidateQueries({ queryKey: ['support', id] }); qc.invalidateQueries({ queryKey: ['support'] }); },
  });
  return (
    <div className="space-y-4 max-w-3xl">
      <Button variant="ghost" onClick={onBack}>← Back to tickets</Button>
      {ticket && (
        <Card><CardContent className="p-5 space-y-4">
          <div>
            <div className="text-lg font-semibold">{ticket.subject}</div>
            <div className="text-sm text-muted-foreground">Status: {ticket.status} · Priority: {ticket.priority}</div>
          </div>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {(ticket.messages as Message[]).map((m) => (
              <div key={m.id} className={m.authorType === 'tenant' ? 'text-right' : ''}>
                <div className={`inline-block rounded-lg px-3 py-2 text-sm ${m.authorType === 'tenant' ? 'bg-primary/10' : 'bg-muted'}`}>
                  <div className="text-[11px] text-muted-foreground mb-0.5">
                    {m.authorType === 'tenant' ? 'You' : 'NamastePOS support'} · {fmt(m.createdAt)}
                  </div>
                  {m.body}
                </div>
              </div>
            ))}
          </div>
          {ticket.status !== 'closed' && (
            <div className="space-y-2">
              <textarea className="w-full min-h-20 rounded-md border bg-background p-2 text-sm"
                placeholder="Type a reply…" value={reply} onChange={(e) => setReply(e.target.value)} />
              <div className="flex justify-end">
                <Button onClick={() => send.mutate()} disabled={!reply.trim() || send.isPending}>
                  {send.isPending ? 'Sending…' : 'Send reply'}
                </Button>
              </div>
            </div>
          )}
        </CardContent></Card>
      )}
    </div>
  );
}
