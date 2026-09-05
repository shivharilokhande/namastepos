import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';

// X4 (2026-08-28) — in-console tenant broadcast. Pick a segment, preview the
// audience, then email them (announcements, upsell, win-back) via Brevo.

const SEGMENTS = [
  { value: 'all', label: 'All tenants' },
  { value: 'active', label: 'Active subscriptions' },
  { value: 'trialing', label: 'On trial' },
  { value: 'trial_ending', label: 'Trial ending (7 days)' },
  { value: 'past_due', label: 'Past due' },
  // 2026-09-06: no `suspended` segment here on purpose — broadcastService
  // .resolveRecipients only accepts active|trialing|past_due|trial_ending|plan:*
  // and 400s on anything else. Add it there first, then list it here.
  { value: 'plan:free', label: 'On Starter (free)' },
  { value: 'plan:basic', label: 'On Growth' },
];

export function BroadcastPage() {
  const [segment, setSegment] = useState('all');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const { data: preview } = useQuery({
    queryKey: ['broadcast-preview', segment],
    queryFn: () => adminApi.broadcastPreview(segment),
  });

  const send = useMutation({
    mutationFn: () => adminApi.broadcastSend({ segment, subject: subject.trim(), body: body.trim() }),
    onSuccess: (r: any) => toast.success(`Sent to ${r.sent} tenant(s)${r.failed ? `, ${r.failed} failed` : ''}`),
    onError: (e) => toast.error(apiError(e)),
  });

  const count = preview?.count ?? 0;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Broadcast</h1>
        <p className="text-muted-foreground">Email a segment of tenants — announcements, upsell, win-back.</p>
      </div>

      <Card>
        <CardContent className="p-5 space-y-4">
          <div>
            <Label>Audience</Label>
            <select className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={segment} onChange={(e) => setSegment(e.target.value)}>
              {SEGMENTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              {count} recipient{count === 1 ? '' : 's'}
              {preview?.sample?.length ? ` · e.g. ${preview.sample.slice(0, 3).map((x: any) => x.name).join(', ')}` : ''}
            </p>
          </div>
          <div>
            <Label>Subject *</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. New: loyalty & wallet now on Growth" />
          </div>
          <div>
            <Label>Message *</Label>
            <textarea className="w-full min-h-40 rounded-md border bg-background p-2 text-sm"
              value={body} onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message. Line breaks become paragraphs." />
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => { if (confirm(`Send to ${count} tenant(s)?`)) send.mutate(); }}
              disabled={!subject.trim() || !body.trim() || count === 0 || send.isPending}>
              {send.isPending ? 'Sending…' : `Send to ${count}`}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
