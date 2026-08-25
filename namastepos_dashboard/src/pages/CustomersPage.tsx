import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, Plus, Settings as SettingsIcon, Heart, Star, Award, Lock } from 'lucide-react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR, formatDate } from '@/lib/utils';
// Bug #7 (2026-08-25): port the mobile customer profile to the web —
// clicking a row opens this drawer (stats, membership, favourites,
// order history via GET /customer-history/:phone).
import { CustomerDetailDrawer, type CustomerListRow } from '@/components/CustomerDetailDrawer';

const TIER_COLORS: Record<string, any> = {
  bronze: 'muted', silver: 'secondary', gold: 'default',
};
const TIER_ICONS: Record<string, any> = {
  bronze: Award, silver: Star, gold: Award,
};

export function CustomersPage() {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'recent' | 'top_spender' | 'top_loyalty'>('recent');
  const [openSettings, setOpenSettings] = useState(false);
  const [addNew, setAddNew] = useState(false);
  // Bug #7 (2026-08-25): selected row → detail drawer (parity with mobile
  // customer_detail_screen.dart).
  const [selected, setSelected] = useState<CustomerListRow | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['customers-crm', search, sort],
    queryFn: () => ffApi.listCustomers({ search: search || undefined, sort }),
    retry: false,
  });

  // Detect "addon required" error so we can show the upsell
  const addonRequired = (() => {
    if (!error) return false;
    if (axios.isAxiosError(error)) {
      return error.response?.status === 402;
    }
    return false;
  })();

  if (addonRequired) {
    return (
      <Card className="border-primary">
        <CardContent className="p-10 text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-primary/10 text-primary mb-4">
            <Lock className="h-8 w-8" />
          </div>
          <h2 className="text-xl font-bold mb-2">Customer database is a paid add-on</h2>
          <p className="text-muted-foreground mb-6">
            Capture phone numbers, give loyalty points, send birthday rewards. Subscribe to the
            <strong> Loyalty & Cashback</strong> add-on to unlock this section.
          </p>
          <Button asChild>
            <a href="/marketplace">Open Marketplace</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Heart className="h-6 w-6 text-primary" /> Customers
          </h1>
          <p className="text-muted-foreground">{data?.total ?? 0} customers in your database</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setOpenSettings(true)}>
            <SettingsIcon className="mr-2 h-4 w-4" /> Loyalty settings
          </Button>
          <Button onClick={() => setAddNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add customer
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search by name, phone, email…" className="pl-9"
                     value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <select value={sort} onChange={(e) => setSort(e.target.value as any)}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <option value="recent">Most recent visit</option>
              <option value="top_spender">Top spenders</option>
              <option value="top_loyalty">Most loyal</option>
            </select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Customer</TableHead><TableHead>Tier</TableHead>
              <TableHead>Visits</TableHead>
              <TableHead className="text-right">Spent</TableHead>
              <TableHead className="text-right">Points</TableHead>
              <TableHead>Last visit</TableHead>
              <TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">Loading…</TableCell></TableRow>}
              {!isLoading && data?.customers.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">No customers yet. They'll appear here when phone numbers are captured at checkout.</TableCell></TableRow>
              )}
              {data?.customers.map((c: any) => {
                const TierIcon = TIER_ICONS[c.tier] || Award;
                return (
                  // Bug #7 (2026-08-25): whole row is clickable → drawer.
                  <TableRow
                    key={c.id}
                    className="cursor-pointer"
                    onClick={() => setSelected(c as CustomerListRow)}
                  >
                    <TableCell>
                      <div className="font-medium">{c.name || c.phone}</div>
                      <div className="text-xs text-muted-foreground">{c.phone}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={TIER_COLORS[c.tier]} className="capitalize">
                        <TierIcon className="mr-1 h-3 w-3" /> {c.tier}
                      </Badge>
                    </TableCell>
                    <TableCell>{c.visitCount}</TableCell>
                    <TableCell className="text-right font-medium">{formatINR(c.totalSpent)}</TableCell>
                    <TableCell className="text-right"><strong className="text-primary">{c.pointsBalance}</strong></TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.lastOrderAt ? formatDate(c.lastOrderAt) : '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {openSettings && <LoyaltySettingsDialog onClose={() => setOpenSettings(false)} />}
      {addNew && <AddCustomerDialog onClose={() => setAddNew(false)} />}
      {selected && (
        <CustomerDetailDrawer customer={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function LoyaltySettingsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['loyalty-settings'], queryFn: ffApi.getLoyaltySettings });
  const [form, setForm] = useState<any>(null);

  // P0-3 fix: initialise the form when settings load via useEffect so we don't
  // setState in render (was causing "Maximum update depth exceeded" infinite loop).
  useEffect(() => {
    if (settings && !form) {
      setForm({
        is_active: settings.isActive,
        earn_rate_paise: settings.earnRatePaise,
        redemption_value_paise: settings.redemptionValuePaise,
        min_redemption_points: settings.minRedemptionPoints,
        max_redemption_pct: settings.maxRedemptionPct,
        welcome_bonus: settings.welcomeBonus,
        birthday_bonus: settings.birthdayBonus,
        tier_silver_threshold: settings.tierSilverThreshold,
        tier_gold_threshold: settings.tierGoldThreshold,
      });
    }
  }, [settings, form]);

  const save = useMutation({
    mutationFn: () => ffApi.updateLoyaltySettings(form),
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['loyalty-settings'] }); onClose(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  if (!form) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent><DialogHeader><DialogTitle>Loyalty settings</DialogTitle></DialogHeader>
          <div className="py-6 text-muted-foreground">Loading…</div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Loyalty settings</DialogTitle>
          <CardDescription>
            How customers earn and redeem points. Changes apply to new orders only.
          </CardDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
            <span className="text-sm font-medium">Loyalty program is live</span>
          </label>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Earn rate</Label>
              <p className="text-xs text-muted-foreground mb-1">{formatINR(form.earn_rate_paise / 100)} spent = 1 point</p>
              <Input type="number" value={form.earn_rate_paise} onChange={(e) => set('earn_rate_paise', +e.target.value)} placeholder="1000" />
            </div>
            <div>
              <Label>Point value</Label>
              <p className="text-xs text-muted-foreground mb-1">1 point = {formatINR(form.redemption_value_paise / 100)} off</p>
              <Input type="number" value={form.redemption_value_paise} onChange={(e) => set('redemption_value_paise', +e.target.value)} placeholder="100" />
            </div>
            <div>
              <Label>Min redemption</Label>
              <Input type="number" value={form.min_redemption_points} onChange={(e) => set('min_redemption_points', +e.target.value)} />
            </div>
            <div>
              <Label>Max redeem % of bill</Label>
              <Input type="number" value={form.max_redemption_pct} onChange={(e) => set('max_redemption_pct', +e.target.value)} />
            </div>
            <div>
              <Label>Welcome bonus (points)</Label>
              <Input type="number" value={form.welcome_bonus} onChange={(e) => set('welcome_bonus', +e.target.value)} />
            </div>
            <div>
              <Label>Birthday bonus</Label>
              <Input type="number" value={form.birthday_bonus} onChange={(e) => set('birthday_bonus', +e.target.value)} />
            </div>
            <div>
              <Label>Silver tier at</Label>
              <Input type="number" value={form.tier_silver_threshold} onChange={(e) => set('tier_silver_threshold', +e.target.value)} />
            </div>
            <div>
              <Label>Gold tier at</Label>
              <Input type="number" value={form.tier_gold_threshold} onChange={(e) => set('tier_gold_threshold', +e.target.value)} />
            </div>
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

function AddCustomerDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ phone: '', name: '', email: '', birthday: '' });
  const create = useMutation({
    mutationFn: () => ffApi.upsertCustomer(form),
    onSuccess: () => { toast.success('Added'); qc.invalidateQueries({ queryKey: ['customers-crm'] }); onClose(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add customer</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Phone *</Label><Input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="9876543210" /></div>
          <div><Label>Name</Label><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><Label>Email</Label><Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
          <div><Label>Birthday</Label><Input type="date" value={form.birthday} onChange={(e) => set('birthday', e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!form.phone || create.isPending}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
