import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { UserPlus, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatDate } from '@/lib/utils';

export function AdminTeamPage() {
  const qc = useQueryClient();
  const { data: admins = [] } = useQuery({ queryKey: ['admin-team'], queryFn: adminApi.teamList });
  const [creating, setCreating] = useState(false);

  const deactivate = useMutation({
    mutationFn: adminApi.teamDeactivate,
    onSuccess: () => { toast.success('Deactivated'); qc.invalidateQueries({ queryKey: ['admin-team'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Admin team</h1>
          <p className="text-muted-foreground">
            {admins.length} admin{admins.length === 1 ? '' : 's'} · roles: super_admin, finance, support, sales
          </p>
        </div>
        <Button onClick={() => setCreating(true)}><UserPlus className="mr-2 h-4 w-4" /> Add admin</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Email</TableHead><TableHead>Name</TableHead>
              <TableHead>Role</TableHead><TableHead>Status</TableHead>
              <TableHead>Last login</TableHead><TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {admins.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.email}</TableCell>
                  <TableCell>{a.displayName || '—'}</TableCell>
                  <TableCell>
                    <Badge variant={a.role === 'super_admin' ? 'default' :
                                    a.role === 'finance' ? 'secondary' : 'muted'}
                           className="capitalize">{a.role.replace('_', ' ')}</Badge>
                  </TableCell>
                  <TableCell>
                    {a.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Disabled</Badge>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.lastLoginAt ? formatDate(a.lastLoginAt) : 'never'}
                  </TableCell>
                  <TableCell>
                    {a.isActive && (
                      <Button size="sm" variant="ghost" onClick={() => deactivate.mutate(a.id)}>
                        <X className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {creating && <CreateAdminDialog onClose={() => setCreating(false)}
        onCreated={() => { qc.invalidateQueries({ queryKey: ['admin-team'] }); setCreating(false); }} />}
    </div>
  );
}

function CreateAdminDialog({ onClose, onCreated }: any) {
  const [form, setForm] = useState({ email: '', password: '', displayName: '', role: 'support' });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () => adminApi.teamCreate(form),
    onSuccess: () => { toast.success('Admin created'); onCreated(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add admin</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Email *</Label><Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
          <div><Label>Password * (min 6 chars)</Label><Input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} /></div>
          <div><Label>Display name</Label><Input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} /></div>
          <div>
            <Label>Role *</Label>
            <select value={form.role} onChange={(e) => set('role', e.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="super_admin">Super admin — everything</option>
              <option value="finance">Finance — refunds, GST, invoices</option>
              <option value="support">Support — customer help + notes</option>
              <option value="sales">Sales — customers + coupons</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!form.email || form.password.length < 6 || create.isPending}>
            Create admin
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
