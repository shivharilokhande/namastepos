// NamastePOS mobile — "how do I get my menu in?" (2026-09-05).
//
// THE WALL THIS REMOVES. Typing 30-80 dishes with prices ON A PHONE is 45-90
// minutes, and it sits between signup and the first bill. The activation audit
// (2026-09-04) called it the single thing most likely to end a 7-day trial on
// day one. The web dashboard got templates and paste-a-menu today; this is the
// mobile half, and mobile is the half that matters most — most owners arrive
// from a WhatsApp link on a phone and never open the dashboard at all.
//
// WHY ONE WIDGET FOR TWO PLACES. The three routes have to be offered where the
// owner actually is: in the setup wizard (before they have seen an empty menu)
// AND on the menu screen (after they have, and gave up). Two copies of this
// list would drift, and the funnel `source` values would drift with them.
//
// THE TIME ESTIMATES ARE HONEST, and they are the point. "2 minutes" for a
// template is the truth: the server holds up to 40 items and applying one is a
// single request. "5 minutes" for paste assumes the owner already has the text
// on their phone and will correct a few rows. "45+ minutes" for typing is not
// a scare tactic — it is the measured number that made this work necessary,
// and an owner who reads it before starting is an owner who takes a shortcut
// instead of abandoning on item nine.
//
// PHOTO OCR IS OUT OF SCOPE and says so on screen, exactly as the web dialog
// does. A half-working OCR over a phone photo of a laminated card produces
// confident WRONG prices, and a wrong price is worse than no menu.

import 'package:flutter/material.dart';

import '../../constants/colors.dart';

/// Which route the owner picked. Values match the `menu_ready.source` wire
/// vocabulary shared with the dashboard — do not rename one without renaming
/// it in namastepos_dashboard/src/lib/activation.ts too, or the funnel stops
/// joining.
enum MenuStartRoute { template, paste, manual }

/// The three routes, as tappable cards. Caller decides what each one does so
/// this widget stays free of navigation and of any API client.
class MenuStartRoutes extends StatelessWidget {
  const MenuStartRoutes({
    super.key,
    required this.onPick,
    this.dense = false,
    this.manualLabel = 'Type them myself',
    this.manualSubtitle = 'One at a time. Fine for a short menu.',
  });

  final void Function(MenuStartRoute route) onPick;

  /// Tighter padding for the setup wizard, where this sits under other fields.
  final bool dense;

  /// The manual route reads differently in the wizard (where rows are already
  /// on screen) than on an empty menu screen (where nothing is).
  final String manualLabel;
  final String manualSubtitle;

  @override
  Widget build(BuildContext context) {
    final gap = dense ? 8.0 : 10.0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _card(
          icon: Icons.auto_awesome,
          color: AppColors.primary,
          title: 'Start with a ready menu',
          subtitle: 'Pick the closest kind of kitchen. Items, categories and '
              'GST come pre-filled — change any price after.',
          time: 'about 2 minutes',
          onTap: () => onPick(MenuStartRoute.template),
          highlight: true,
        ),
        SizedBox(height: gap),
        _card(
          icon: Icons.content_paste,
          color: AppColors.info,
          title: 'Paste your menu as text',
          subtitle: 'A WhatsApp message, a typed list, a note on your phone. '
              'You check every row before it saves.',
          time: 'about 5 minutes',
          onTap: () => onPick(MenuStartRoute.paste),
        ),
        SizedBox(height: gap),
        _card(
          icon: Icons.edit_outlined,
          color: AppColors.textSecondary,
          title: manualLabel,
          subtitle: manualSubtitle,
          time: '45 minutes or more for a full menu',
          onTap: () => onPick(MenuStartRoute.manual),
        ),
        SizedBox(height: gap + 2),
        // Said out loud, in the same words as the web dialog. An owner who
        // photographs their menu card and waits for something to happen is an
        // owner we have lost for no reason.
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: const [
            Icon(Icons.info_outline, size: 14, color: AppColors.textHint),
            SizedBox(width: 6),
            Expanded(
              child: Text(
                'A photo of a menu card will not work — we do not read '
                'pictures. Type or paste the text instead.',
                style: TextStyle(fontSize: 11, color: AppColors.textHint),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _card({
    required IconData icon,
    required Color color,
    required String title,
    required String subtitle,
    required String time,
    required VoidCallback onTap,
    bool highlight = false,
  }) {
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Container(
          padding: EdgeInsets.all(dense ? 12 : 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: highlight ? AppColors.primary : AppColors.divider,
              width: highlight ? 1.4 : 1,
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Icon(icon, size: 19, color: color),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title,
                        style: const TextStyle(
                            fontWeight: FontWeight.w800, fontSize: 14)),
                    const SizedBox(height: 3),
                    Text(subtitle,
                        style: const TextStyle(
                            fontSize: 12, color: AppColors.textSecondary)),
                    const SizedBox(height: 5),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.schedule,
                            size: 12, color: AppColors.textHint),
                        const SizedBox(width: 4),
                        Text(time,
                            style: const TextStyle(
                                fontSize: 11, color: AppColors.textHint)),
                      ],
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right,
                  size: 18, color: AppColors.textHint),
            ],
          ),
        ),
      ),
    );
  }
}
