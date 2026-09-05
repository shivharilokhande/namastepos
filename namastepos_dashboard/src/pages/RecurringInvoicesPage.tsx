// Recurring invoices (R16)
//
// D-01 (2026-09-05): the previous placeholder told owners to "use the API"
// and POST to /retail/quotations "with frequency metadata" — no such API
// exists (no recurring-invoice route in the backend; the cron only logs due
// rows and bumps next_run_at, it issues nothing). Telling a paying Advanced
// owner to call a non-existent endpoint is worse than saying the truth:
// this feature is not available yet. No fake instructions here.
import { Repeat, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export function RecurringInvoicesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Repeat className="h-6 w-6 text-primary" /> Recurring invoices
        </h1>
        <p className="text-muted-foreground text-sm">Auto-generate invoices for regular B2B customers on a schedule.</p>
      </div>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Clock className="h-4 w-4 text-muted-foreground" /> Coming soon — not yet available</CardTitle>
          <CardDescription>
            Recurring invoices are still being built. There is nothing to set up here yet — no templates can be created
            from the dashboard, the app or the API, and no invoices are generated automatically today.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          When it ships you will define a template (customer, items, frequency) and NamastePOS will raise the
          invoice on schedule. Until then, raise B2B invoices manually from Retail.
        </CardContent>
      </Card>
    </div>
  );
}
