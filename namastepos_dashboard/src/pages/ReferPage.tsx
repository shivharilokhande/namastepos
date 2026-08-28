// NamastePOS dashboard — Refer & earn (FF-333 tenant side).
// Shows the restaurant's referral code + share link and referral stats.
// "Refer a restaurant, both get 1 month free" (awarded after 30 active days).

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gift, Copy, Check, MessageCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ffApi } from '@/api/namastepos';

export function ReferPage() {
  const [copied, setCopied] = useState(false);
  const { data } = useQuery<{ code: string; stats: Record<string, number> }>({
    queryKey: ['referral'], queryFn: () => ffApi.referral(),
  });
  const code = data?.code || '';
  const shareUrl = code ? `https://app.namastepos.in/register?ref=${code}` : '';
  const stats = data?.stats || {};
  const msg = `I run my restaurant on NamastePOS — GST billing, KOT & reports, works offline. Sign up with my code ${code} and we both get 1 month free: ${shareUrl}`;

  const copy = () => {
    navigator.clipboard?.writeText(shareUrl);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Gift className="h-6 w-6" /> Refer &amp; earn</h1>
        <p className="text-muted-foreground">Invite another restaurant. When they stay active 30 days, you both get 1 month free.</p>
      </div>

      <Card>
        <CardContent className="p-6 space-y-4">
          <div>
            <div className="text-sm text-muted-foreground mb-1">Your referral code</div>
            <div className="text-3xl font-bold tracking-widest font-mono">{code || '…'}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={copy} disabled={!code}>
              {copied ? <><Check className="h-4 w-4 mr-1" /> Copied</> : <><Copy className="h-4 w-4 mr-1" /> Copy link</>}
            </Button>
            <a href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer">
              <Button disabled={!code}><MessageCircle className="h-4 w-4 mr-1" /> Share on WhatsApp</Button>
            </a>
          </div>
          {shareUrl && <div className="text-xs text-muted-foreground break-all">{shareUrl}</div>}
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Shared / pending" value={stats.pending || 0} />
        <StatCard label="Signed up" value={stats.signed_up || 0} />
        <StatCard label="Rewarded" value={stats.awarded || 0} />
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card><CardContent className="p-4 text-center">
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </CardContent></Card>
  );
}
