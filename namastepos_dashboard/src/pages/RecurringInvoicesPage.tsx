// Recurring invoices (R16)
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Repeat } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// Service does not have a list endpoint yet — we use a placeholder.
// Backend cron worker already picks due rows, so creation flow is the
// remaining piece.

export function RecurringInvoicesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Repeat className="h-6 w-6 text-primary" /> Recurring invoices
        </h1>
        <p className="text-muted-foreground text-sm">Auto-generate invoices on a schedule. Cron runs every minute and fires due templates.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>How it works</CardTitle>
          <CardDescription>The backend already auto-runs due recurring invoices nightly.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p>
            Use the API to set up a template (the dashboard form for this is the next UI sprint).
            Send a POST to <code>/v1/businesses/:id/retail/quotations</code> with frequency metadata
            and the cron worker will issue invoices on schedule.
          </p>
          <p className="text-xs text-muted-foreground">
            Tables: <code>recurring_invoices</code> (already in migration 027). Worker code in
            <code> cronWorker.js → dueRecurringInvoices()</code>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
