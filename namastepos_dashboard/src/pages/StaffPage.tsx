import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { UserPlus, KeyRound, X, Pencil, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { usePlan } from '@/hooks/usePlan';

const ROLE_LABELS: Record<string, string> = {
  business_owner: 'Owner',
  staff_manager:  'Manager',
  staff_captain:  'Captain',
  staff_waiter:   'Waiter',
  staff_cashier:  'Cashier',
  staff_kitchen:  'Kitchen',
  staff_driver:   'Driver (delivery)', // 2026-08-23 — parity with mobile
};

const STAFF_ROLES = [
  'staff_manager', 'staff_captain', 'staff_waiter',
  'staff_cashier', 'staff_kitchen', 'staff_driver',
];

export function StaffPage() {
  const qc = useQueryClient();
  const { data: staff = [] } = useQuery({
    queryKey: ['staff-pin'],
    queryFn: ffApi.listStaffPin,
  });
  // Push 14d — read subscription so we can warn when active staff > plan cap.
  // Refetched every minute (catches admin tweaks) and on window focus.
  const { data: sub } = useQuery({
    queryKey: ['subscription'],
    queryFn: ffApi.subscription,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  const create = useMutation({
    mutationFn: ffApi.createStaffPin,
    onSuccess: () => {
      toast.success('Staff added');
      qc.invalidateQueries({ queryKey: ['staff-pin'] });
      setAdding(false);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const update = useMutation({
    mutationFn: ({ userId, patch }: { userId: string; patch: any }) =>
      ffApi.updateStaffPin(userId, patch),
    onSuccess: () => {
      toast.success('Updated');
      qc.invalidateQueries({ queryKey: ['staff-pin'] });
      setEditing(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const active = staff.filter((s: any) => s.isActive);
  const inactive = staff.filter((s: any) => !s.isActive);
  // Push 14e — owner does NOT count against plan.limits.staff.
  const nonOwnerActive = active.filter((s: any) => s.role !== 'business_owner');

  // Push 14d — derive over-limit state. cap < 0 means unlimited.
  const staffCap = sub?.plan?.limits?.staff;
  const overLimit = typeof staffCap === 'number' && staffCap >= 0 && nonOwnerActive.length > staffCap;

  // Push 14e — "Comply now" auto-prune
  const comply = useMutation({
    mutationFn: ffApi.complyStaffLimit,
    onSuccess: (r: any) => {
      toast.success(`Deactivated ${r.deactivated || 0} staff to fit plan`);
      qc.invalidateQueries({ queryKey: ['staff-pin'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Staff</h1>
          <p className="text-muted-foreground">
            Add captains, waiters, cooks, cashiers. Each gets a 4-digit PIN to sign in on shared devices.
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <UserPlus className="mr-2 h-4 w-4" /> Add staff
        </Button>
      </div>

      {overLimit && (
        <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-900 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
          <div className="text-sm flex-1">
            <div className="font-semibold">
              Over plan limit: {nonOwnerActive.length} / {staffCap} active staff
            </div>
            <div className="opacity-80">
              Your subscription tier allows {staffCap} staff. Auto-comply will keep the {staffCap} earliest hires
              and deactivate the rest (past orders are preserved). Or upgrade to keep everyone on.
            </div>
          </div>
          <Button size="sm" variant="outline"
              className="bg-amber-100 border-amber-400 hover:bg-amber-200"
              onClick={() => {
                if (confirm(`Auto-comply will deactivate ${nonOwnerActive.length - staffCap!} staff (newest hires). Continue?`)) {
                  comply.mutate();
                }
              }}
              disabled={comply.isPending}>
            Comply now
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Active ({active.length})</CardTitle>
          <CardDescription>Staff who can sign in right now</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>PIN</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {active.map((s: any) => (
                <TableRow key={s.userId}>
                  <TableCell className="font-medium">{s.displayName || '—'}</TableCell>
                  <TableCell>
                    <Badge variant="muted">{ROLE_LABELS[s.role] || s.role}</Badge>
                  </TableCell>
                  <TableCell>{s.phone || '—'}</TableCell>
                  <TableCell>{s.hasPin ? '••••' : 'not set'}</TableCell>
                  <TableCell className="text-right space-x-1">
                    {s.role !== 'business_owner' && (
                      <>
                        <Button size="sm" variant="ghost"
                            onClick={() => setEditing(s)}
                            title="Edit / reset PIN">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="ghost"
                            onClick={() => update.mutate({ userId: s.userId, patch: { isActive: false } })}
                            title="Remove">
                          <X className="h-4 w-4 text-destructive" />
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {inactive.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Inactive ({inactive.length})</CardTitle>
            <CardDescription>
              Re-add by phone to reactivate, or edit to change role / PIN
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inactive.map((s: any) => (
                  <TableRow key={s.userId} className="opacity-60">
                    <TableCell className="line-through">{s.displayName}</TableCell>
                    <TableCell>{ROLE_LABELS[s.role] || s.role}</TableCell>
                    <TableCell>{s.phone || '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost"
                          onClick={() => update.mutate({ userId: s.userId, patch: { isActive: true } })}>
                        Reactivate
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {(adding || editing) && (
        <StaffDialog
          existing={editing}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onSubmit={(body) => {
            if (editing) update.mutate({ userId: editing.userId, patch: body });
            else create.mutate(body);
          }}
          submitting={create.isPending || update.isPending}
        />
      )}
    </div>
  );
}

// Push 16a — split each report into its own permission key so owners
// can grant P&L / registers / tax-invoices independently. `memberships`
// removed (Push 16b). `auto_whatsapp_order` added (Push 16h).
const PERMISSION_KEYS = [
  'home', 'pos', 'orders', 'tables', 'reports',
  'pnl_statement', 'income_register', 'expense_register',
  'invoice_register', 'tax_invoices',
  'menu_editor', 'modifier_groups',
  'customers', 'reservations',
  'wastage', 'daily_closing',
  'kds', 'captain', 'driver',
  'surge', 'qr_codes',
  'bill_template', 'thermal_printer', 'aggregators',
  'whatsapp_marketing', 'auto_whatsapp_order',
];
const PERMISSION_FEATURE: Record<string, string | null> = {
  home: null, pos: null, orders: null, tables: null,
  bill_template: null, thermal_printer: null, menu_editor: null,
  customers: null,
  reports: 'reports_basic',
  pnl_statement: 'reports_basic',
  income_register: 'reports_basic',
  expense_register: 'reports_basic',
  invoice_register: 'reports_basic',
  tax_invoices: 'invoice_basic',
  modifier_groups: 'menu_variants_modifiers',
  reservations: 'reservations',
  wastage: 'wastage',
  daily_closing: 'daily_closing',
  kds: 'kds',
  captain: 'captain_mode',
  driver: 'driver_mode',
  surge: 'surge_pricing',
  qr_codes: 'qr_ordering',
  aggregators: 'aggregators',
  whatsapp_marketing: 'whatsapp_marketing',
  auto_whatsapp_order: 'auto_whatsapp_order',
};
const PERMISSION_LABELS: Record<string, string> = {
  home: 'Home dashboard',
  pos: 'POS / new order',
  orders: 'Orders list',
  tables: 'Tables / floor',
  reports: 'Reports (daily/monthly)',
  pnl_statement: 'P&L statement',
  income_register: 'Income register',
  expense_register: 'Expense register',
  invoice_register: 'Invoice register',
  tax_invoices: 'Tax invoices',
  menu_editor: 'Menu editor',
  modifier_groups: 'Modifier groups',
  customers: 'Customers',
  reservations: 'Reservations',
  wastage: 'Log wastage',
  daily_closing: 'Daily closing',
  kds: 'Kitchen (KDS)',
  captain: 'Captain view',
  driver: 'Driver / delivery',
  surge: 'Surge pricing',
  qr_codes: 'QR codes',
  bill_template: 'Bill template',
  thermal_printer: 'Thermal printer',
  aggregators: 'Aggregators (Zomato/Swiggy)',
  whatsapp_marketing: 'WhatsApp marketing',
  auto_whatsapp_order: 'Auto WhatsApp on order',
};
const DEFAULTS_BY_ROLE: Record<string, string[]> = {
  staff_manager: [
    'home', 'pos', 'orders', 'tables', 'reports',
    'pnl_statement', 'income_register', 'expense_register',
    'invoice_register', 'tax_invoices',
    'menu_editor', 'modifier_groups',
    'customers', 'reservations',
    'wastage', 'daily_closing',
    'kds', 'captain', 'driver',
    'surge', 'qr_codes',
    'bill_template', 'thermal_printer', 'aggregators',
    'whatsapp_marketing', 'auto_whatsapp_order',
  ],
  staff_captain: ['home', 'pos', 'orders', 'tables', 'customers', 'captain'],
  staff_waiter:  ['home', 'pos', 'tables', 'captain'],
  staff_cashier: [
    'home', 'pos', 'orders', 'reports',
    'tax_invoices', 'invoice_register',
    'customers', 'bill_template',
  ],
  staff_kitchen: ['home', 'kds'],
  staff_driver:  ['home', 'driver'], // 2026-08-23 — parity with mobile
};

function StaffDialog({
  existing, onCancel, onSubmit, submitting,
}: {
  existing: any | null;
  onCancel: () => void;
  onSubmit: (body: any) => void;
  submitting: boolean;
}) {
  const plan = usePlan();
  const [name, setName] = useState(existing?.displayName || '');
  const [role, setRole] = useState(existing?.role || 'staff_captain');
  const [phone, setPhone] = useState(existing?.phone || '');
  const [pin, setPin] = useState('');
  const [perms, setPerms] = useState<Set<string>>(
    new Set<string>(existing?.permissions || DEFAULTS_BY_ROLE[existing?.role || 'staff_captain'] || []),
  );

  const submit = () => {
    if (!name.trim()) return toast.error('Name required');
    if (!existing && !phone.trim()) return toast.error('Phone required');
    if (!existing && !/^\d{4}$/.test(pin)) return toast.error('PIN must be 4 digits');
    if (existing && pin && !/^\d{4}$/.test(pin)) return toast.error('PIN must be 4 digits');
    const body: any = {
      displayName: name.trim(),
      role,
      permissions: Array.from(perms),
    };
    if (phone.trim()) body.phone = phone.trim();
    if (pin) body.pin = pin;
    onSubmit(body);
  };

  const onRoleChange = (newRole: string) => {
    setRole(newRole);
    // Reset checkboxes to the new role's defaults
    setPerms(new Set(DEFAULTS_BY_ROLE[newRole] || []));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${existing.displayName}` : 'Add staff'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Arun" />
          </div>
          <div>
            <Label>Role *</Label>
            <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={role} onChange={(e) => onRoleChange(e.target.value)}>
              {STAFF_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Phone {existing ? '' : '*'}</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder="9876543210"
                disabled={!!existing} />
            {!existing && (
              <p className="text-xs text-muted-foreground mt-1">
                Used as the unique key. Re-adding the same phone reactivates a removed staff.
              </p>
            )}
          </div>
          <div>
            <Label>
              <KeyRound className="inline h-3.5 w-3.5 mr-1" />
              {existing ? 'New PIN (leave blank to keep current)' : '4-digit PIN *'}
            </Label>
            <Input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="1234" inputMode="numeric" maxLength={4} type="password" />
          </div>
          {/* Push 14c — per-staff permission checkboxes */}
          <div>
            <Label>Access permissions</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Pick which app areas this staff can use. Changing the role above resets these to that role's defaults.
            </p>
            <div className="border rounded-md max-h-64 overflow-y-auto">
              {PERMISSION_KEYS.map((k) => {
                const on = perms.has(k);
                // Push 14c.4 — gate by active plan. If the feature this
                // permission maps to isn't in the current plan, the
                // checkbox is disabled with an UPGRADE badge.
                const featKey = PERMISSION_FEATURE[k];
                const available = featKey === null || plan.has(featKey);
                return (
                  <label key={k}
                      className={`flex items-center gap-2 px-3 py-1.5 text-sm
                        ${available ? 'hover:bg-muted/50 cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}>
                    <input type="checkbox"
                        checked={available && on}
                        disabled={!available}
                        onChange={(e) => {
                          if (!available) return;
                          const next = new Set(perms);
                          if (e.target.checked) next.add(k); else next.delete(k);
                          setPerms(next);
                        }} />
                    <span className="flex-1">{PERMISSION_LABELS[k] || k}</span>
                    {!available && (
                      <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-wider bg-primary/10 text-primary">
                        Upgrade
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? 'Saving…' : (existing ? 'Save changes' : 'Add to team')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
