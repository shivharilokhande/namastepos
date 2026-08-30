// NamastePOS — Mobile Reviews (H13).
//
// Pulls Google reviews from the backend and
// lets the owner reply inline. Replies post to /reviews/:id/reply.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/empty_state.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class ReviewsScreen extends StatefulWidget {
  const ReviewsScreen({super.key});

  @override
  State<ReviewsScreen> createState() => _ReviewsScreenState();
}

class _ReviewsScreenState extends State<ReviewsScreen> {
  List<dynamic> _list = [];
  bool _loading = true;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loading = false); return; }
    try {
      _list = await ApiService.instance.listReviews(biz.id);
    } catch (_) {/* swallow */}
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _reply(Map<String, dynamic> r) async {
    final ctl = TextEditingController(text: r['reply'] as String? ?? '');
    final ans = await showDialog<String?>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Reply to review'),
        content: TextField(
          controller: ctl, autofocus: true, maxLines: 3,
          decoration: const InputDecoration(hintText: 'Type your reply'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, null), child: const Text('Cancel')),
          ElevatedButton(
              onPressed: () => Navigator.pop(context, ctl.text.trim()),
              child: const Text('Post')),
        ],
      ),
    );
    if (ans == null || ans.isEmpty || !mounted) return;
    final biz = context.read<AuthProvider>().business!;
    try {
      await ApiService.instance.replyReview(biz.id, r['id'] as String, ans);
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanizeError(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Reviews'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _list.isEmpty
              ? EmptyState(
                  icon: Icons.reviews_outlined,
                  title: 'No reviews yet — good time to ask',
                  // Parity with the web dashboard (2026-08-30): Google reviews
                  // only. Zomato/Swiggy review linking isn't a feature, so we
                  // no longer advertise it here.
                  hint: 'Google reviews show up here once your Google Business Profile is linked. Send a WhatsApp thank-you after each order and ask happy customers to leave a review.',
                  ctaLabel: 'Refresh',
                  onCta: _load,
                )
              : ListView.separated(
                  padding: const EdgeInsets.all(12),
                  itemCount: _list.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 8),
                  itemBuilder: (_, i) => _card(_list[i] as Map<String, dynamic>),
                ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _card(Map<String, dynamic> r) {
    final stars = (r['rating'] as num?)?.toInt() ?? 0;
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.divider),
        borderRadius: BorderRadius.circular(10),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text((r['reviewer_name'] as String?) ?? 'Anonymous',
                  style: const TextStyle(fontWeight: FontWeight.w800)),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text((r['source'] as String? ?? '?').toUpperCase(),
                    style: const TextStyle(
                        fontSize: 10, fontWeight: FontWeight.w800,
                        color: AppColors.primary)),
              ),
              const Spacer(),
              ...List.generate(
                5,
                (i) => Icon(
                  i < stars ? Icons.star : Icons.star_border,
                  color: AppColors.warning, size: 16,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text((r['body'] as String?) ?? '',
              style: const TextStyle(fontSize: 13)),
          if (r['reply'] != null && (r['reply'] as String).isNotEmpty)
            Container(
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: AppColors.primary.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text('You replied: "${r['reply']}"',
                  style: const TextStyle(fontSize: 12)),
            ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: () => _reply(r),
              child: Text(r['reply'] == null ? 'Reply' : 'Edit reply'),
            ),
          ),
        ],
      ),
    );
  }
}
