// Reviews aggregation (FF-1001)
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Star, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';

export function ReviewsPage() {
  const qc = useQueryClient();
  const { data: reviews = [] } = useQuery({ queryKey: ['reviews'], queryFn: () => ffApi.listReviews() });
  const { data: stats } = useQuery({ queryKey: ['review-stats'], queryFn: ffApi.reviewStats });
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});

  const reply = useMutation({
    mutationFn: ({ id, text }: any) => ffApi.replyReview(id, text),
    onSuccess: () => { toast.success('Reply posted'); qc.invalidateQueries({ queryKey: ['reviews'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Star className="h-6 w-6 text-amber-500" /> Reviews
        </h1>
        <p className="text-muted-foreground text-sm">All reviews from Google, Zomato, Swiggy + post-meal NPS, in one inbox.</p>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Overall</div>
            <div className="text-2xl font-bold">★ {(+stats.overall?.avg || 0).toFixed(1)}</div>
            <div className="text-xs">{stats.overall?.n || 0} reviews</div>
          </CardContent></Card>
          {(stats.sources || []).map((s: any) => (
            <Card key={s.source}><CardContent className="p-4">
              <div className="text-xs text-muted-foreground capitalize">{s.source}</div>
              <div className="text-2xl font-bold">★ {(+s.avg_rating).toFixed(1)}</div>
              <div className="text-xs">{s.n} reviews</div>
            </CardContent></Card>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {reviews.length === 0 && <div className="p-8 text-center text-muted-foreground">No reviews yet.</div>}
          {reviews.map((r: any) => (
            <div key={r.id} className="border-b p-4">
              <div className="flex items-center justify-between">
                <div>
                  <Badge variant="muted" className="capitalize">{r.source}</Badge>
                  <span className="ml-2 font-medium">{r.reviewer_name || 'Anonymous'}</span>
                  <span className="ml-2 text-amber-500">{'★'.repeat(r.rating || 0)}{'☆'.repeat(5-(r.rating||0))}</span>
                </div>
                <div className="text-xs text-muted-foreground">{r.posted_at && new Date(r.posted_at).toLocaleDateString()}</div>
              </div>
              {r.body && <div className="mt-2 text-sm">{r.body}</div>}
              {r.reply && <div className="mt-2 ml-4 text-sm bg-muted/40 p-2 rounded">↳ <strong>Owner:</strong> {r.reply}</div>}
              {!r.reply && (
                <div className="flex gap-2 mt-2">
                  <Input value={replyDraft[r.id] || ''} onChange={(e) => setReplyDraft({ ...replyDraft, [r.id]: e.target.value })} placeholder="Write a reply…" />
                  <Button size="sm" onClick={() => reply.mutate({ id: r.id, text: replyDraft[r.id] })} disabled={!replyDraft[r.id]}>
                    Reply
                  </Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
