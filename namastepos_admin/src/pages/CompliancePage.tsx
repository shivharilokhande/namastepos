import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi, Dsr, Grievance, Breach } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatDateTime } from '@/lib/utils';

type Tab = 'dsr' | 'grievances' | 'breaches' | 'retention' | 'settings';

// DPDP compliance console (2026-08-28). Wires the pre-existing backend
// (/admin/compliance/*) that had no admin UI: DSR queue, grievance queue,
// breach register, and grievance-officer/DPO settings.

const TABS: { key: Tab; label: string }[] = [
  { key: 'dsr', label: 'Data requests' },
  { key: 'grievances', label: 'Grievances' },
  { key: 'breaches', label: 'Breach register' },
  { key: 'retention', label: 'Retention' },
  { key: 'settings', label: 'Officer & settings' },
];

export function CompliancePage() {
  const [tab, setTab] = useState<Tab>('dsr');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Compliance</h1>
        <p className="text-muted-foreground">DPDP data-subject requests, grievances, breaches & officer settings</p>
      </div>

      <div className="flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'dsr' && <DsrTab />}
      {tab === 'grievances' && <GrievanceTab />}
      {tab === 'breaches' && <BreachTab />}
      {tab === 'retention' && <RetentionTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
}

// ── DSR queue ───────────────────────────────────────────────────────────
const DSR_STATUS: Record<string, any> = {
  pending: 'warning', in_review: 'secondary', completed: 'success', rejected: 'muted', partial: 'secondary',
};
const DSR_TYPE_LABEL: Record<string, string> = {
  access: 'Access', correction: 'Correction', erasure: 'Erasure',
  portability: 'Portability', withdraw_consent: 'Withdraw consent',
};

function overdue(due: string | null, closed: string | null) {
  return !!due && !closed && new Date(due).getTime() < Date.now();
}

function DsrTab() {
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<Dsr | null>(null);
  const { data: rows = [] } = useQuery<Dsr[]>({
    queryKey: ['compliance-dsr', status],
    queryFn: () => adminApi.complianceDsr({ status: status || undefined }),
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{rows.length} requests</p>
        <select className="h-9 rounded-md border bg-background px-3 text-sm"
          value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['pending', 'in_review', 'completed', 'rejected', 'partial'].map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
      </div>
      {rows.length === 0 && (
        <Card><CardContent className="py-10 text-center text-muted-foreground">No data-subject requests.</CardContent></Card>
      )}
      <div className="grid gap-3">
        {rows.map((r) => (
          <Card key={r.id} className="cursor-pointer hover:border-primary/50" onClick={() => setOpen(r)}>
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{DSR_TYPE_LABEL[r.requestType] || r.requestType}</span>
                  {overdue(r.slaDueAt, r.closedAt) && <Badge variant="destructive">SLA overdue</Badge>}
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {r.contactEmail || r.guestPhone || r.userId || '—'} · {r.source} · {formatDateTime(r.createdAt)}
                  {r.slaDueAt ? ` · due ${formatDateTime(r.slaDueAt)}` : ''}
                </div>
              </div>
              <Badge variant={DSR_STATUS[r.status] || 'muted'}>{r.status.replace('_', ' ')}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>
      {open && <DsrDialog row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function DsrDialog({ row, onClose }: { row: Dsr; onClose: () => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState(row.status);
  const [note, setNote] = useState('');
  const [proofHash, setProofHash] = useState(row.proofHash || '');
  const save = useMutation({
    mutationFn: () => adminApi.updateDsr(row.id, { status, note: note.trim() || undefined, proofHash: proofHash.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['compliance-dsr'] });
      toast.success('Request updated'); onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{DSR_TYPE_LABEL[row.requestType] || row.requestType} request</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="text-muted-foreground">
            {row.contactEmail || row.guestPhone || row.userId || '—'} · filed {formatDateTime(row.createdAt)}
            {row.slaDueAt ? ` · SLA due ${formatDateTime(row.slaDueAt)}` : ''}
          </div>
          {row.details && Object.keys(row.details).length > 0 && (
            <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(row.details, null, 2)}</pre>
          )}
          <div>
            <Label>Status</Label>
            <select className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={status} onChange={(e) => setStatus(e.target.value as Dsr['status'])}>
              {['pending', 'in_review', 'completed', 'rejected', 'partial'].map((s) => (
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Note (recorded in the request's event log)</Label>
            <textarea className="w-full min-h-16 rounded-md border bg-background p-2 text-sm"
              value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done / evidence reference…" />
          </div>
          <div>
            <Label>Proof hash (optional)</Label>
            <Input value={proofHash} onChange={(e) => setProofHash(e.target.value)} placeholder="SHA-256 of the export / erasure receipt" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Grievances ──────────────────────────────────────────────────────────
const GRV_STATUS: Record<string, any> = {
  received: 'warning', acknowledged: 'secondary', resolved: 'success', rejected: 'muted', escalated: 'destructive',
};

function GrievanceTab() {
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<Grievance | null>(null);
  const { data: rows = [] } = useQuery<Grievance[]>({
    queryKey: ['compliance-grv', status],
    queryFn: () => adminApi.complianceGrievances({ status: status || undefined }),
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{rows.length} grievances</p>
        <select className="h-9 rounded-md border bg-background px-3 text-sm"
          value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['received', 'acknowledged', 'resolved', 'rejected', 'escalated'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      {rows.length === 0 && (
        <Card><CardContent className="py-10 text-center text-muted-foreground">No grievances.</CardContent></Card>
      )}
      <div className="grid gap-3">
        {rows.map((g) => (
          <Card key={g.id} className="cursor-pointer hover:border-primary/50" onClick={() => setOpen(g)}>
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{g.subject}</span>
                  <Badge variant="muted">{g.category}</Badge>
                  {overdue(g.ackDueAt, g.acknowledgedAt) && <Badge variant="destructive">Ack overdue</Badge>}
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {g.complainantName || g.complainantEmail || g.complainantPhone || '—'} · {formatDateTime(g.createdAt)}
                </div>
              </div>
              <Badge variant={GRV_STATUS[g.status] || 'muted'}>{g.status}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>
      {open && <GrievanceDialog row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function GrievanceDialog({ row, onClose }: { row: Grievance; onClose: () => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState(row.status);
  const [resolutionNote, setResolutionNote] = useState(row.resolutionNote || '');
  const save = useMutation({
    mutationFn: () => adminApi.updateGrievance(row.id, { status, resolutionNote: resolutionNote.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['compliance-grv'] });
      toast.success('Grievance updated'); onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{row.subject}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="text-muted-foreground">
            {row.complainantName || '—'}{row.complainantEmail ? ` · ${row.complainantEmail}` : ''}
            {row.complainantPhone ? ` · ${row.complainantPhone}` : ''} · {row.category}
          </div>
          <div className="text-muted-foreground text-xs">
            Filed {formatDateTime(row.createdAt)}
            {row.ackDueAt ? ` · ack due ${formatDateTime(row.ackDueAt)}` : ''}
            {row.resolveDueAt ? ` · resolve due ${formatDateTime(row.resolveDueAt)}` : ''}
          </div>
          <div className="rounded-md border bg-muted/40 p-3 whitespace-pre-wrap">{row.body}</div>
          <div>
            <Label>Status</Label>
            <select className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={status} onChange={(e) => setStatus(e.target.value as Grievance['status'])}>
              {['received', 'acknowledged', 'resolved', 'rejected', 'escalated'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Resolution note</Label>
            <textarea className="w-full min-h-16 rounded-md border bg-background p-2 text-sm"
              value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Breach register ─────────────────────────────────────────────────────
const SEV_VARIANT: Record<string, any> = {
  low: 'muted', medium: 'secondary', high: 'warning', critical: 'destructive',
};
const BREACH_STATUS: Record<string, any> = {
  detected: 'warning', triaging: 'secondary', contained: 'secondary', notified: 'secondary', closed: 'success',
};

function BreachTab() {
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<Breach | null>(null);
  const [creating, setCreating] = useState(false);
  const { data: rows = [] } = useQuery<Breach[]>({
    queryKey: ['compliance-breach', status],
    queryFn: () => adminApi.complianceBreaches({ status: status || undefined }),
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{rows.length} incidents</p>
        <div className="flex gap-2">
          <select className="h-9 rounded-md border bg-background px-3 text-sm"
            value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['detected', 'triaging', 'contained', 'notified', 'closed'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <Button onClick={() => setCreating(true)}>Log breach</Button>
        </div>
      </div>
      {rows.length === 0 && (
        <Card><CardContent className="py-10 text-center text-muted-foreground">No breach incidents logged.</CardContent></Card>
      )}
      <div className="grid gap-3">
        {rows.map((b) => (
          <Card key={b.id} className="cursor-pointer hover:border-primary/50" onClick={() => setOpen(b)}>
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{b.summary}</span>
                  <Badge variant={SEV_VARIANT[b.severity]}>{b.severity}</Badge>
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {b.category} · {b.scope}{b.affected_count != null ? ` · ${b.affected_count} affected` : ''} · detected {formatDateTime(b.detected_at)}
                </div>
              </div>
              <Badge variant={BREACH_STATUS[b.status] || 'muted'}>{b.status}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>
      {open && <BreachDialog row={open} onClose={() => setOpen(null)} />}
      {creating && <NewBreachDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function BreachDialog({ row, onClose }: { row: Breach; onClose: () => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState(row.status);
  const [remediation, setRemediation] = useState(row.remediation || '');
  const [dpb, setDpb] = useState(!!row.dpb_notified_at);
  const [certIn, setCertIn] = useState(!!row.cert_in_notified_at);
  const [users, setUsers] = useState(!!row.users_notified_at);
  const save = useMutation({
    mutationFn: () => {
      const fields: Record<string, any> = { remediation: remediation.trim() || null };
      if (dpb && !row.dpb_notified_at) fields.dpb_notified_at = new Date().toISOString();
      if (certIn && !row.cert_in_notified_at) fields.cert_in_notified_at = new Date().toISOString();
      if (users && !row.users_notified_at) fields.users_notified_at = new Date().toISOString();
      return adminApi.updateBreach(row.id, { status, fields });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['compliance-breach'] });
      toast.success('Incident updated'); onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Breach incident</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="rounded-md border bg-muted/40 p-3 whitespace-pre-wrap">{row.summary}</div>
          <div className="text-muted-foreground text-xs">
            {row.category} · {row.scope} · severity {row.severity}
            {row.affected_count != null ? ` · ${row.affected_count} affected` : ''}
            {row.data_categories?.length ? ` · ${row.data_categories.join(', ')}` : ''}
          </div>
          {row.root_cause && <div><span className="font-medium">Root cause: </span>{row.root_cause}</div>}
          <div>
            <Label>Status</Label>
            <select className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={status} onChange={(e) => setStatus(e.target.value as Breach['status'])}>
              {['detected', 'triaging', 'contained', 'notified', 'closed'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Remediation</Label>
            <textarea className="w-full min-h-16 rounded-md border bg-background p-2 text-sm"
              value={remediation} onChange={(e) => setRemediation(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Notifications</Label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={dpb} onChange={(e) => setDpb(e.target.checked)} disabled={!!row.dpb_notified_at} /> Data Protection Board notified{row.dpb_notified_at ? ` (${formatDateTime(row.dpb_notified_at)})` : ''}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={certIn} onChange={(e) => setCertIn(e.target.checked)} disabled={!!row.cert_in_notified_at} /> CERT-In notified{row.cert_in_notified_at ? ` (${formatDateTime(row.cert_in_notified_at)})` : ''}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={users} onChange={(e) => setUsers(e.target.checked)} disabled={!!row.users_notified_at} /> Affected users notified{row.users_notified_at ? ` (${formatDateTime(row.users_notified_at)})` : ''}</label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewBreachDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    scope: 'platform', category: '', severity: 'medium', summary: '',
    affectedCount: '', dataCategories: '', occurredAt: '', rootCause: '', remediation: '',
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const create = useMutation({
    mutationFn: () => adminApi.logBreach({
      scope: form.scope,
      category: form.category.trim(),
      severity: form.severity,
      summary: form.summary.trim(),
      affectedCount: form.affectedCount ? parseInt(form.affectedCount, 10) : null,
      dataCategories: form.dataCategories.split(',').map((s) => s.trim()).filter(Boolean),
      occurredAt: form.occurredAt || null,
      rootCause: form.rootCause.trim() || undefined,
      remediation: form.remediation.trim() || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['compliance-breach'] });
      toast.success('Breach logged'); onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Log a breach incident</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Scope</Label>
              <select className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.scope} onChange={(e) => set('scope', e.target.value)}>
                <option value="platform">Platform</option><option value="business">Business</option>
              </select>
            </div>
            <div>
              <Label>Severity</Label>
              <select className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.severity} onChange={(e) => set('severity', e.target.value)}>
                {['low', 'medium', 'high', 'critical'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div>
            <Label>Category *</Label>
            <Input value={form.category} onChange={(e) => set('category', e.target.value)} placeholder="e.g. unauthorized_access, data_leak" />
          </div>
          <div>
            <Label>Summary *</Label>
            <textarea className="w-full min-h-16 rounded-md border bg-background p-2 text-sm"
              value={form.summary} onChange={(e) => set('summary', e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Affected count</Label>
              <Input type="number" value={form.affectedCount} onChange={(e) => set('affectedCount', e.target.value)} />
            </div>
            <div>
              <Label>Occurred at</Label>
              <Input type="datetime-local" value={form.occurredAt} onChange={(e) => set('occurredAt', e.target.value)} />
            </div>
          </div>
          <div>
            <Label>Data categories (comma-separated)</Label>
            <Input value={form.dataCategories} onChange={(e) => set('dataCategories', e.target.value)} placeholder="phone, email, order_history" />
          </div>
          <div>
            <Label>Root cause</Label>
            <textarea className="w-full min-h-14 rounded-md border bg-background p-2 text-sm"
              value={form.rootCause} onChange={(e) => set('rootCause', e.target.value)} />
          </div>
          <div>
            <Label>Remediation</Label>
            <textarea className="w-full min-h-14 rounded-md border bg-background p-2 text-sm"
              value={form.remediation} onChange={(e) => set('remediation', e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()}
            disabled={!form.category.trim() || !form.summary.trim() || create.isPending}>
            {create.isPending ? 'Logging…' : 'Log breach'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Data retention ──────────────────────────────────────────────────────
function RetentionTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['compliance-retention'], queryFn: () => adminApi.retentionConfig() });
  const [form, setForm] = useState<Record<string, number>>({});
  const num = (k: 'deletedBusinessDays' | 'auditLogDays' | 'cookieConsentDays', fallback: number) =>
    (form[k] !== undefined ? form[k] : fallback);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: Math.max(0, parseInt(v || '0', 10) || 0) }));

  const save = useMutation({
    mutationFn: () => adminApi.saveRetention(form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['compliance-retention'] }); setForm({}); toast.success('Retention windows saved'); },
    onError: (e) => toast.error(apiError(e)),
  });
  const run = useMutation({
    mutationFn: () => adminApi.runRetention(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['compliance-retention'] });
      toast.success(`Sweep done — ${r.businessesPurged} tenants, ${r.auditRowsPruned} audit, ${r.consentRowsPruned} consent rows`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (!data) return <Card><CardContent className="py-10 text-center text-muted-foreground">Loading…</CardContent></Card>;

  const ROWS: { key: 'deletedBusinessDays' | 'auditLogDays' | 'cookieConsentDays'; label: string; hint: string }[] = [
    { key: 'deletedBusinessDays', label: 'Purge deleted tenants after', hint: 'Permanently delete a business (and all its data) this many days after it was soft-deleted.' },
    { key: 'auditLogDays', label: 'Prune audit log after', hint: 'Delete platform admin audit-log entries older than this.' },
    { key: 'cookieConsentDays', label: 'Prune anonymous cookie consents after', hint: 'Delete anonymous cookie-banner consent records (no user/phone) older than this. User & guest consent evidence is kept.' },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5 space-y-4">
          <div>
            <h3 className="font-semibold">Data-retention windows</h3>
            <p className="text-sm text-muted-foreground">
              DPDP data minimisation. Set a number of days, or 0 to disable. The sweep runs automatically each night (02:00 IST); disabled windows are skipped. <span className="font-medium text-amber-600">Deletions are permanent.</span>
            </p>
          </div>
          {ROWS.map((r) => (
            <div key={r.key} className="flex items-start justify-between gap-4 border-t pt-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{r.label}</div>
                <div className="text-xs text-muted-foreground">{r.hint}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Input type="number" min={0} className="w-24 text-right"
                  value={String(num(r.key, data[r.key]))}
                  onChange={(e) => set(r.key, e.target.value)} />
                <span className="text-sm text-muted-foreground w-16">
                  {num(r.key, data[r.key]) === 0 ? 'off' : 'days'}
                </span>
              </div>
            </div>
          ))}
          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} disabled={Object.keys(form).length === 0 || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save windows'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Run sweep now</div>
            <div className="text-xs text-muted-foreground">
              {data.lastRun
                ? `Last run ${formatDateTime(data.lastRun.ranAt)} — ${data.lastRun.businessesPurged} tenants, ${data.lastRun.auditRowsPruned} audit, ${data.lastRun.consentRowsPruned} consent rows.`
                : 'Never run yet.'}
            </div>
          </div>
          <Button variant="outline" onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? 'Running…' : 'Run now'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Officer & settings ──────────────────────────────────────────────────
function SettingsTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['compliance-settings'], queryFn: () => adminApi.complianceSettings() });
  const [form, setForm] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Seed the form once settings load.
  const v = (k: string, fallback?: string) => (form[k] !== undefined ? form[k] : (fallback ?? ''));

  const save = useMutation({
    mutationFn: () => adminApi.saveComplianceSettings(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['compliance-settings'] });
      setForm({});
      toast.success('Compliance settings saved');
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (!data) return <Card><CardContent className="py-10 text-center text-muted-foreground">Loading…</CardContent></Card>;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="font-semibold">Grievance Officer <span className="text-xs font-normal text-muted-foreground">(published on the public site — DPDP requirement)</span></h3>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Name</Label><Input value={v('grievanceOfficerName', data.grievanceOfficer.name)} onChange={(e) => set('grievanceOfficerName', e.target.value)} /></div>
            <div><Label>Email</Label><Input value={v('grievanceOfficerEmail', data.grievanceOfficer.email)} onChange={(e) => set('grievanceOfficerEmail', e.target.value)} /></div>
            <div><Label>Phone</Label><Input value={v('grievanceOfficerPhone', data.grievanceOfficer.phone)} onChange={(e) => set('grievanceOfficerPhone', e.target.value)} /></div>
            <div><Label>Address</Label><Input value={v('grievanceOfficerAddress', data.grievanceOfficer.address)} onChange={(e) => set('grievanceOfficerAddress', e.target.value)} /></div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="font-semibold">Data Protection Officer</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Name</Label><Input value={v('dpoName', data.dataProtectionOfficer.name)} onChange={(e) => set('dpoName', e.target.value)} /></div>
            <div><Label>Email</Label><Input value={v('dpoEmail', data.dataProtectionOfficer.email)} onChange={(e) => set('dpoEmail', e.target.value)} /></div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="font-semibold">Legal entity & policy versions</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Legal entity name</Label><Input value={v('legalEntityName', data.legalEntity.name)} onChange={(e) => set('legalEntityName', e.target.value)} /></div>
            <div><Label>Registered address</Label><Input value={v('legalEntityAddress', data.legalEntity.address)} onChange={(e) => set('legalEntityAddress', e.target.value)} /></div>
            <div><Label>CIN</Label><Input value={v('legalEntityCin', data.legalEntity.cin)} onChange={(e) => set('legalEntityCin', e.target.value)} /></div>
            <div><Label>GSTIN</Label><Input value={v('legalEntityGstin', data.legalEntity.gstin)} onChange={(e) => set('legalEntityGstin', e.target.value)} /></div>
            <div><Label>Privacy policy version</Label><Input value={v('privacyPolicyVersion', data.privacyPolicyVersion)} onChange={(e) => set('privacyPolicyVersion', e.target.value)} /></div>
            <div><Label>Terms version</Label><Input value={v('termsOfServiceVersion', data.termsOfServiceVersion)} onChange={(e) => set('termsOfServiceVersion', e.target.value)} /></div>
          </div>
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={Object.keys(form).length === 0 || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  );
}
