// Reviews aggregation (FF-1001) — dashboard parity with mobile reviews_screen.dart (H13).
// 2026-08-25: Upgraded to match mobile flow: stats header (average rating, review
// count, per-source cards, rating-distribution bars), rating/replied/source filters,
// inline reply with per-review save state and reply editing (mobile has "Edit reply").
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Star, RefreshCw, MessageSquare, Pencil, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';

// Shapes verified against namastepos_backend/src/services/reviewsService.js (2026-08-25):
// - GET /reviews          → reviews.listReviews(businessId, { source, limit }) → rows of `reviews` table
// - GET /reviews/stats    → { sources: [{ source, n, avg_rating }], overall: { avg, n } }
// - POST /reviews/:id/reply { reply } → updated review row
interface Review {
  id: string;
  source: string;
  rating: number | null;
  reviewer_name: string | null;
  body: string | null;
  posted_at: string | null;
  reply: string | null;
  reply_at: string | null;
}
interface SourceStat { source: string; n: number; avg_rating: number | null }
interface ReviewStats { sources: SourceStat[]; overall: { avg: number | null; n: number } }

type RepliedFilter = 'all' | 'awaiting' | 'replied';

// 2026-08-25: filters are client-side by design — the backend list endpoint only
// supports `source`/`limit` (see reviewsService.listReviews). Fetching once and
// filtering locally keeps the distribution bars stable while the user filters.
export function ReviewsPage() {
  const qc = useQueryClient();
  const { data: reviews = [], isLoading, isFetching } = useQuery<Review[]>({
    queryKey: ['reviews'],
    queryFn: () => ffApi.listReviews(),
  });
  const { data: stats } = useQuery<ReviewStats>({ queryKey: ['review-stats'], queryFn: ffApi.reviewStats });

  const [ratingFilter, setRatingFilter] = useState<number | null>(null);
  const [repliedFilter, setRepliedFilter] = useState<RepliedFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  // 2026-08-25: mobile lets owners edit an existing reply; track which reviews
  // are in edit mode so the saved reply stays read-only until "Edit" is tapped.
  const [editing, setEditing] = useState<Record<string, boolean>>({});

  const reply = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => ffApi.replyReview(id, text),
    onSuccess: (_review, vars) => {
      toast.success('Reply posted');
      setEditing((e) => ({ ...e, [vars.id]: false }));
      setReplyDraft((d) => { const next = { ...d }; delete next[vars.id]; return next; });
      qc.invalidateQueries({ queryKey: ['reviews'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['reviews'] });
    qc.invalidateQueries({ queryKey: ['review-stats'] });
  };

  // 2026-08-25: distribution is computed from the loaded list because the stats
  // endpoint only returns per-source averages, not a star histogram.
  const distribution = useMemo(() => {
    const counts = [0, 0, 0, 0, 0]; // index 0 → 1★ … index 4 → 5★
    for (const r of reviews) {
      const star = Math.round(r.rating ?? 0);
      if (star >= 1 && star <= 5) counts[star - 1] += 1;
    }
    return counts;
  }, [reviews]);
  const maxCount = Math.max(1, ...distribution);
  const awaitingCount = useMemo(() => reviews.filter((r) => !r.reply).length, [reviews]);

  const filtered = useMemo(() => reviews.filter((r) => {
    if (ratingFilter !== null && Math.round(r.rating ?? 0) !== ratingFilter) return false;
    if (repliedFilter === 'awaiting' && r.reply) return false;
    if (repliedFilter === 'replied' && !r.reply) return false;
    if (sourceFilter !== null && r.source !== sourceFilter) return false;
    return true;
  }), [reviews, ratingFilter, repliedFilter, sourceFilter]);

  const savingId = reply.isPending ? reply.variables?.id : undefined;

  const stars = (n: number | null) => {
    const v = Math.round(n ?? 0);
    return '★'.repeat(v) + '☆'.repeat(Math.max(0, 5 - v));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Star className="h-6 w-6 text-amber-500" /> Reviews
          </h1>
          <p className="text-muted-foreground text-sm">All reviews from Google, Zomato, Swiggy + post-meal NPS, in one inbox.</p>
        </div>
        {/* 2026-08-25: mobile app bar has a refresh action — mirror it here. */}
        <Button variant="outline" size="sm" onClick={refresh} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {/* Stats header: overall + awaiting + per-source cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">Overall</div>
          <div className="text-2xl font-bold">★ {(stats?.overall?.avg ?? 0).toFixed(1)}</div>
          <div className="text-xs text-muted-foreground">{stats?.overall?.n ?? 0} reviews</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">Awaiting reply</div>
          <div className="text-2xl font-bold">{awaitingCount}</div>
          <div className="text-xs text-muted-foreground">of {reviews.length} loaded</div>
        </CardContent></Card>
        {(stats?.sources ?? []).map((s) => (
          <Card key={s.source}><CardContent className="p-4">
            <div className="text-xs text-muted-foreground capitalize">{s.source}</div>
            <div className="text-2xl font-bold">★ {(s.avg_rating ?? 0).toFixed(1)}</div>
            <div className="text-xs text-muted-foreground">{s.n} reviews</div>
          </CardContent></Card>
        ))}
      </div>

      {/* Rating distribution bars (5★ on top, Indian aggregator convention) */}
      {reviews.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-1.5">
            <div className="text-sm font-medium mb-2">Rating distribution</div>
            {[5, 4, 3, 2, 1].map((star) => {
              const count = distribution[star - 1];
              const active = ratingFilter === star;
              return (
                <button
                  key={star}
                  type="button"
                  // 2026-08-25: bars double as rating filters — one less control row.
                  onClick={() => setRatingFilter(active ? null : star)}
                  className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-accent ${active ? 'bg-accent' : ''}`}
                >
                  <span className="w-8 text-xs text-amber-600 font-medium">{star} ★</span>
                  <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-amber-400"
                      style={{ width: `${(count / maxCount) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-xs text-muted-foreground">{count}</span>
                </button>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Filters: replied state + source pills */}
      <div className="flex flex-wrap items-center gap-2">
        {([
          ['all', 'All'],
          ['awaiting', 'Awaiting reply'],
          ['replied', 'Replied'],
        ] as [RepliedFilter, string][]).map(([key, label]) => (
          <Button
            key={key}
            variant={repliedFilter === key ? 'default' : 'outline'}
            size="sm"
            onClick={() => setRepliedFilter(key)}
          >
            {label}
          </Button>
        ))}
        {(stats?.sources ?? []).length > 1 && (
          <>
            <span className="mx-1 h-5 w-px bg-border" />
            {(stats?.sources ?? []).map((s) => (
              <Button
                key={s.source}
                variant={sourceFilter === s.source ? 'default' : 'outline'}
                size="sm"
                className="capitalize"
                onClick={() => setSourceFilter(sourceFilter === s.source ? null : s.source)}
              >
                {s.source}
              </Button>
            ))}
          </>
        )}
        {ratingFilter !== null && (
          <Badge variant="warning" className="cursor-pointer" onClick={() => setRatingFilter(null)}>
            {ratingFilter}★ only — clear
          </Badge>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading && <div className="p-8 text-center text-muted-foreground">Loading reviews…</div>}
          {!isLoading && reviews.length === 0 && (
            // 2026-08-25: empty state mirrors mobile EmptyState copy (ask for reviews,
            // point at aggregator linking) instead of a bare "No reviews yet."
            <div className="p-10 text-center space-y-2">
              <MessageSquare className="h-8 w-8 mx-auto text-muted-foreground" />
              <div className="font-medium">No reviews yet — good time to ask</div>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Reviews start showing up here from Google, Zomato and Swiggy once linked
                (Settings → Aggregators). Send a WhatsApp thank-you after each order and
                watch the ratings roll in.
              </p>
              <Button variant="outline" size="sm" onClick={refresh}>
                <RefreshCw className="h-4 w-4 mr-2" /> Refresh
              </Button>
            </div>
          )}
          {!isLoading && reviews.length > 0 && filtered.length === 0 && (
            <div className="p-8 text-center text-muted-foreground">No reviews match the current filters.</div>
          )}
          {filtered.map((r) => {
            const isEditing = !!editing[r.id];
            const showReplyBox = !r.reply || isEditing;
            const draft = replyDraft[r.id] ?? (isEditing ? r.reply ?? '' : '');
            const saving = savingId === r.id;
            return (
              <div key={r.id} className="border-b p-4 last:border-b-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <Badge variant="muted" className="capitalize">{r.source}</Badge>
                    <span className="ml-2 font-medium">{r.reviewer_name || 'Anonymous'}</span>
                    <span className="ml-2 text-amber-500">{stars(r.rating)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground shrink-0">
                    {r.posted_at && new Date(r.posted_at).toLocaleDateString()}
                  </div>
                </div>
                {r.body && <div className="mt-2 text-sm">{r.body}</div>}
                {r.reply && !isEditing && (
                  <div className="mt-2 ml-4 flex items-start justify-between gap-2 rounded bg-muted/40 p-2 text-sm">
                    <div>↳ <strong>Owner:</strong> {r.reply}</div>
                    {/* 2026-08-25: parity with mobile "Edit reply" action. */}
                    <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0" onClick={() => setEditing((e) => ({ ...e, [r.id]: true }))}>
                      <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                    </Button>
                  </div>
                )}
                {showReplyBox && (
                  <div className="mt-2 flex gap-2">
                    <Input
                      value={draft}
                      maxLength={2000} // 2026-08-25: backend Joi caps reply at 2000 chars
                      onChange={(e) => setReplyDraft((d) => ({ ...d, [r.id]: e.target.value }))}
                      placeholder="Write a reply…"
                      disabled={saving}
                    />
                    <Button size="sm" className="h-10" onClick={() => reply.mutate({ id: r.id, text: draft.trim() })} disabled={!draft.trim() || saving}>
                      {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                      {saving ? 'Posting…' : r.reply ? 'Save' : 'Reply'}
                    </Button>
                    {isEditing && (
                      <Button variant="ghost" size="sm" className="h-10" disabled={saving} onClick={() => {
                        setEditing((e) => ({ ...e, [r.id]: false }));
                        setReplyDraft((d) => { const next = { ...d }; delete next[r.id]; return next; });
                      }}>
                        Cancel
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
