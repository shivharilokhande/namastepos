import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';

// ── Platform health (2026-09-03, extracted to its own page 2026-09-04) ──
// Read-only ops panel. Everything here comes from something that already
// existed — a DB round trip for latency, the _migrations bookkeeping table,
// webhook_events, and the cron worker's in-process last-run map. No new
// tables, no new pollers.
//
// It used to be inlined in SettingsPage, which is settings.write-only — so
// support/finance/sales could never see it even though GET
// /admin/health/platform only needs reports.read. It now lives at /health
// (nav gated on reports.read) and is still rendered at the bottom of
// Platform settings so nothing an admin already knows disappears.
export function PlatformHealthCard() {
  const { data: h, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['platform-health'],
    queryFn: adminApi.platformHealth,
    refetchInterval: 30_000,
  });

  const dot = (ok: boolean) =>
    `inline-block h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`;

  const jobs = Object.entries(h?.cron.jobs || {})
    .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));

  // The cron worker's memory is per-process. On a multi-instance deploy this
  // panel reports the instance that served THIS request, which is why the
  // note below says so rather than implying a cluster-wide view.
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" /> Platform health
        </CardTitle>
        <CardDescription>
          Live status of the API instance serving this request. Read-only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading && <div className="text-sm text-muted-foreground">Checking…</div>}
        {isError && (
          // A silent blank panel reads as "nothing to report". Say the probe
          // itself failed — that is itself a health signal.
          <div>
            <div className="text-sm text-destructive">
              Couldn't reach the health probe — {apiError(error)}
            </div>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        )}
        {h && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">API</div>
                <div className="flex items-center gap-2 font-medium">
                  <span className={dot(h.api.ok)} /> {h.api.env}
                </div>
                <div className="text-xs text-muted-foreground">
                  up {Math.floor(h.api.uptimeSec / 3600)}h {Math.floor((h.api.uptimeSec % 3600) / 60)}m
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Database</div>
                <div className="flex items-center gap-2 font-medium">
                  <span className={dot(h.db.ok)} />
                  {h.db.latencyMs !== null ? `${h.db.latencyMs} ms` : 'unknown'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {h.db.connections !== null ? `${h.db.connections} connections` : ''}
                  {h.db.error ? h.db.error : ''}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Redis (feature cache)</div>
                <div className="flex items-center gap-2 font-medium">
                  <span className={dot(h.redis.configured ? h.redis.ready : true)} />
                  {h.redis.configured ? (h.redis.ready ? 'connected' : 'configured, not ready') : 'off'}
                </div>
                <div className="text-xs text-muted-foreground">{h.redis.mode}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Migrations applied</div>
                <div className="font-medium">{h.migrations.applied ?? '—'}</div>
                <div className="text-xs text-muted-foreground">
                  {h.migrations.lastAppliedAt
                    ? `last ${new Date(h.migrations.lastAppliedAt).toLocaleDateString('en-IN')}`
                    : ''}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-t pt-4 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Webhooks · 24h</div>
                <div className="font-medium">{h.webhooks.received24h ?? '—'} received</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Webhook errors · 24h</div>
                <div className={`font-medium ${(h.webhooks.errored24h || 0) > 0 ? 'text-destructive' : ''}`}>
                  {h.webhooks.errored24h ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Unprocessed · 24h</div>
                <div className={`font-medium ${(h.webhooks.unprocessed24h || 0) > 0 ? 'text-amber-600' : ''}`}>
                  {h.webhooks.unprocessed24h ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cron worker</div>
                <div className="flex items-center gap-2 font-medium">
                  <span className={dot(h.cron.running)} />
                  {h.cron.running ? 'running' : 'not running here'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {h.cron.lastTickAt
                    ? `last tick ${new Date(h.cron.lastTickAt).toLocaleTimeString('en-IN')} · ${h.cron.lastTickMs}ms`
                    : 'no tick yet'}
                </div>
              </div>
            </div>

            <div className="border-t pt-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Last run per job
              </div>
              {jobs.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No job has run on this instance yet (the worker runs on one instance,
                  and its history resets on deploy).
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
                  {jobs.map(([name, j]) => (
                    <div key={name} className="flex items-center justify-between border-b py-1 text-sm last:border-0">
                      <span className="flex items-center gap-2">
                        <span className={dot(j.ok)} />
                        <span className="font-mono text-xs">{name}</span>
                      </span>
                      <span className="text-xs text-muted-foreground" title={j.error || ''}>
                        {new Date(j.at).toLocaleTimeString('en-IN')} · {j.ms}ms
                        {!j.ok && ' · failed'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function HealthPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Platform health</h1>
        <p className="text-muted-foreground">
          API, database, cache, migrations, webhooks and the cron worker — refreshed every 30s.
        </p>
      </div>
      <PlatformHealthCard />
    </div>
  );
}
