import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatDateTime } from '@/lib/utils';
import { useCan } from '@/lib/rbac';

// X7 (2026-08-28) — support inbox. List tickets, open a thread, reply,
// change status, and raise a ticket on a tenant's behalf.

interface Ticket {
  id: string; businessId: string; businessName: string; subject: string;
  status: string; priority: string; lastReplyAt: string | null;
  createdAt: string; messageCount?: number;
}
interface Message { id: string; authorType: string; authorEmail: string | null; body: string; createdAt: string; }

const STATUS_VARIANT: Record<string, any> = {
  open: 'warning', pending: 'secondary', resolved: 'success', closed: 'muted',
};
const PRIORITY_VARIANT: Record<string, any> = {
  critical: 'destructive', high: 'destructive', normal: 'muted', low: 'muted',
};

export function SupportPage() {
  const { can } = useCan(); // F-10 — create/reply/status are customers.write
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // NP-143 — server-side pagination (same Prev/Next pager as CustomersPage).
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  const { data, isLoading, isError, error, refetch } = useQuery<{ tickets: Ticket[]; total: number }>({
    queryKey: ['support', status, page],
    queryFn: () => adminApi.supportTickets({
      status: status || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
    }),
  });
  const tickets = data?.tickets ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Support</h1>
          <p className="text-muted-foreground">{total} tickets</p>
        </div>
        <div className="flex gap-2">
          <select className="h-9 rounded-md border bg-background px-3 text-sm"
            value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          {can('customers.write') && <Button onClick={() => setCreating(true)}>New ticket</Button>}
        </div>
      </div>

      <div className="grid gap-3">
        {isError && (
          // "No tickets." on a 403/500 reads like an empty inbox. Say it failed.
          <Card><CardContent className="py-10 text-center">
            <div className="text-sm text-destructive">Couldn't load tickets — {apiError(error)}</div>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>Retry</Button>
          </CardContent></Card>
        )}
        {isLoading && !isError && (
          <Card><CardContent className="py-10 text-center text-muted-foreground">Loading…</CardContent></Card>
        )}
        {!isLoading && !isError && tickets.length === 0 && (
          <Card><CardContent className="py-10 text-center text-muted-foreground">No tickets.</CardContent></Card>
        )}
        {tickets.map((t) => (
          <Card key={t.id} className="cursor-pointer hover:border-primary/50" onClick={() => setOpenId(t.id)}>
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{t.subject}</span>
                  <Badge variant={PRIORITY_VARIANT[t.priority]}>{t.priority}</Badge>
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {t.businessName} · {t.messageCount ?? 0} messages · {formatDateTime(t.lastReplyAt || t.createdAt)}
                </div>
              </div>
              <Badge variant={STATUS_VARIANT[t.status] || 'muted'}>{t.status}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-2 text-sm">
          <span className="text-muted-foreground">
            {total === 0 ? 0 : page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Button>
            <span className="text-muted-foreground">Page {page + 1} / {pageCount}</span>
            <Button variant="outline" size="sm" disabled={page + 1 >= pageCount}
                    onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      {openId && <TicketDialog id={openId} onClose={() => setOpenId(null)} />}
      {creating && <NewTicketDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function TicketDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useCan();
  const canWrite = can('customers.write');
  const [reply, setReply] = useState('');
  const { data: ticket } = useQuery({ queryKey: ['support', id], queryFn: () => adminApi.supportTicket(id) });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['support', id] });
    qc.invalidateQueries({ queryKey: ['support'] });
  };
  const sendReply = useMutation({
    mutationFn: () => adminApi.supportReply(id, reply.trim()),
    onSuccess: () => { setReply(''); refresh(); toast.success('Reply sent'); },
    onError: (e) => toast.error(apiError(e)),
  });
  const setStatus = useMutation({
    mutationFn: (s: string) => adminApi.supportSetStatus(id, s),
    onSuccess: () => { refresh(); toast.success('Status updated'); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{ticket?.subject || 'Ticket'}</DialogTitle>
        </DialogHeader>
        {ticket && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>{ticket.businessName}</span>
              <Badge variant={PRIORITY_VARIANT[ticket.priority]}>{ticket.priority}</Badge>
              <Badge variant={STATUS_VARIANT[ticket.status] || 'muted'}>{ticket.status}</Badge>
            </div>
            <div className="max-h-72 overflow-y-auto space-y-3 border rounded-md p-3">
              {(ticket.messages as Message[]).map((m) => (
                <div key={m.id} className={m.authorType === 'admin' ? 'text-right' : ''}>
                  <div className={`inline-block rounded-lg px-3 py-2 text-sm ${m.authorType === 'admin' ? 'bg-primary/10' : 'bg-muted'}`}>
                    <div className="text-[11px] text-muted-foreground mb-0.5">
                      {m.authorType === 'admin' ? 'Support' : 'Customer'}{m.authorEmail ? ` · ${m.authorEmail}` : ''} · {formatDateTime(m.createdAt)}
                    </div>
                    {m.body}
                  </div>
                </div>
              ))}
            </div>
            <textarea className="w-full min-h-20 rounded-md border bg-background p-2 text-sm"
              placeholder="Type a reply…" value={reply} onChange={(e) => setReply(e.target.value)} />
          </div>
        )}
        <DialogFooter className="flex-wrap gap-2">
          {canWrite ? (
            <>
              <div className="mr-auto flex gap-1">
                {['pending', 'resolved', 'closed', 'open'].map((s) => (
                  <Button key={s} variant="ghost" size="sm" onClick={() => setStatus.mutate(s)}>Mark {s}</Button>
                ))}
              </div>
              <Button onClick={() => sendReply.mutate()} disabled={!reply.trim() || sendReply.isPending}>
                {sendReply.isPending ? 'Sending…' : 'Send reply'}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewTicketDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ businessId: '', subject: '', priority: 'normal', body: '' });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const create = useMutation({
    mutationFn: () => adminApi.supportCreateTicket({
      businessId: form.businessId.trim(), subject: form.subject.trim(),
      priority: form.priority, body: form.body.trim(),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['support'] }); toast.success('Ticket created'); onClose(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Raise a ticket for a tenant</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Business ID *</Label>
            <Input value={form.businessId} onChange={(e) => set('businessId', e.target.value)} placeholder="Tenant business UUID" />
          </div>
          <div>
            <Label>Subject *</Label>
            <Input value={form.subject} onChange={(e) => set('subject', e.target.value)} />
          </div>
          <div>
            <Label>Priority</Label>
            <select className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={form.priority} onChange={(e) => set('priority', e.target.value)}>
              <option value="low">Low</option><option value="normal">Normal</option>
              <option value="high">High</option><option value="critical">Critical</option>
            </select>
          </div>
          <div>
            <Label>Message *</Label>
            <textarea className="w-full min-h-20 rounded-md border bg-background p-2 text-sm"
              value={form.body} onChange={(e) => set('body', e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()}
            disabled={!form.businessId.trim() || !form.subject.trim() || !form.body.trim() || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create ticket'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
