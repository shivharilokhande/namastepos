import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileSpreadsheet, FileCode2, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function AccountingPage() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(monthAgo);
  const [endDate, setEndDate] = useState(today);

  const tally = useMutation({
    mutationFn: () => ffApi.exportTally({ startDate, endDate }),
    onSuccess: (xml: any) => {
      downloadFile(`tally-${startDate}-to-${endDate}.xml`, xml, 'application/xml');
      toast.success('Tally XML downloaded');
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const zoho = useMutation({
    mutationFn: () => ffApi.exportZoho({ startDate, endDate }),
    onSuccess: (csv: any) => {
      downloadFile(`zoho-${startDate}-to-${endDate}.csv`, csv, 'text/csv');
      toast.success('Zoho CSV downloaded');
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <FileSpreadsheet className="h-6 w-6 text-primary" /> Accounting exports
        </h1>
        <p className="text-muted-foreground text-sm">
          Push sales into Tally, Zoho Books, or QuickBooks. E-invoice + E-way bill from the order page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Date range</CardTitle>
          <CardDescription>Both exports use the same window.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div><Label>From</Label><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
          <div><Label>To</Label><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileCode2 className="h-5 w-5" /> Tally</CardTitle>
            <CardDescription>XML envelope for Tally Import Data.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => tally.mutate()} disabled={tally.isPending}>
              <Download className="mr-2 h-4 w-4" /> {tally.isPending ? 'Exporting…' : 'Download Tally XML'}
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileSpreadsheet className="h-5 w-5" /> Zoho Books / QuickBooks</CardTitle>
            <CardDescription>CSV with all invoices in the window.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => zoho.mutate()} disabled={zoho.isPending}>
              <Download className="mr-2 h-4 w-4" /> {zoho.isPending ? 'Exporting…' : 'Download CSV'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
