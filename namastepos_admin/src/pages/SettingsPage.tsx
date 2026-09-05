import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Save } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
// Platform health now lives at /health (reports.read) so support/finance/sales
// can reach it; it stays rendered here too so settings admins lose nothing.
import { PlatformHealthCard } from './HealthPage';

interface SettingMeta { key: string; label: string; description?: string; type?: 'string' | 'number' | 'boolean'; group: string; }

const FIELDS: SettingMeta[] = [
  // Brand
  { key: 'brand.name',           label: 'Brand name',          group: 'Brand' },
  { key: 'brand.support_email',  label: 'Support email',       group: 'Brand' },
  // Platform / tax
  { key: 'platform.legal_name',  label: 'Legal entity name',   group: 'Tax (GST)' },
  { key: 'platform.gstin',       label: 'Platform GSTIN',      group: 'Tax (GST)', description: '15-char GST number, e.g. 27AAAAA0000A1Z5' },
  { key: 'platform.hsn',         label: 'HSN/SAC code',        group: 'Tax (GST)', description: 'Default 998314 for SaaS' },
  { key: 'platform.tax_pct',     label: 'GST percentage',      group: 'Tax (GST)', type: 'number' },
  { key: 'platform.address',     label: 'Registered address',  group: 'Tax (GST)' },
  // Features
  { key: 'feature.maintenance_mode', label: 'Maintenance mode (block customer logins)', group: 'Feature flags', type: 'boolean' },
  { key: 'feature.new_signups_open', label: 'New signups open',                          group: 'Feature flags', type: 'boolean' },
  // Security
  { key: 'security.enforce_admin_2fa', label: 'Require 2FA for all admins', group: 'Security', type: 'boolean',
    description: 'When on, any admin who signs in without 2FA is forced to set it up before they can do anything.' },
];

export function SettingsPage() {
  const qc = useQueryClient();
  const { data: settings = [] } = useQuery({ queryKey: ['settings'], queryFn: adminApi.listSettings });
  const [draft, setDraft] = useState<Record<string, any>>({});

  useEffect(() => {
    if (settings.length > 0) {
      const m: Record<string, any> = {};
      for (const s of settings) m[s.key] = s.value;
      setDraft(m);
    }
  }, [settings]);

  const set = (k: string, v: any) => setDraft((d) => ({ ...d, [k]: v }));

  const save = useMutation({
    mutationFn: () => adminApi.saveSettings(draft),
    onSuccess: () => { toast.success('Settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  const groups: Record<string, SettingMeta[]> = {};
  for (const f of FIELDS) { (groups[f.group] ||= []).push(f); }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Platform settings</h1>
        <p className="text-muted-foreground">
          Brand, tax info, feature flags. Changes apply immediately for new requests.
        </p>
      </div>

      {Object.entries(groups).map(([group, fields]) => (
        <Card key={group}>
          <CardHeader>
            <CardTitle>{group}</CardTitle>
            {group === 'Tax (GST)' && (
              <CardDescription>Used on tax invoices and GSTR-1 exports. Set this BEFORE you go live.</CardDescription>
            )}
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {fields.map((f) => (
              <div key={f.key} className={f.type === 'boolean' ? 'md:col-span-2' : ''}>
                <Label className="text-sm">{f.label}</Label>
                {f.description && <p className="text-xs text-muted-foreground mb-1">{f.description}</p>}
                {f.type === 'boolean'
                  ? <select value={String(draft[f.key] ?? false)}
                            onChange={(e) => set(f.key, e.target.value === 'true')}
                            className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  : <Input type={f.type === 'number' ? 'number' : 'text'}
                           value={draft[f.key] !== undefined ? String(draft[f.key]).replace(/^"|"$/g, '') : ''}
                           onChange={(e) => set(f.key, f.type === 'number' ? +e.target.value : e.target.value)} />
                }
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          <Save className="mr-2 h-4 w-4" /> Save all settings
        </Button>
      </div>

      <PlatformHealthCard />
      {/* F-11 (2026-09-06): the 2FA card moved to /account so every role can
          self-enrol — this page is settings.write-gated (super_admin only). */}
      <p className="text-xs text-muted-foreground">
        Looking for two-factor authentication? It is under{' '}
        <Link to="/account" className="text-primary hover:underline">My account</Link>.
      </p>
    </div>
  );
}
