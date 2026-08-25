// NamastePOS — shared Google "G" logo painter (2026-08-25).
// Extracted so both LoginScreen and RegisterScreen can render the same
// brand mark without duplicating the painter.

import 'package:flutter/material.dart';

class GoogleLogo extends StatelessWidget {
  final double size;
  const GoogleLogo({super.key, this.size = 22});

  @override
  Widget build(BuildContext context) =>
      SizedBox(width: size, height: size, child: CustomPaint(painter: _GooglePainter()));
}

class _GooglePainter extends CustomPainter {
  static const _blue = Color(0xFF4285F4);
  static const _green = Color(0xFF34A853);
  static const _yellow = Color(0xFFFBBC04);
  static const _red = Color(0xFFEA4335);

  @override
  void paint(Canvas canvas, Size size) {
    final r = size.width / 2;
    final c = Offset(r, r);
    final stroke = size.width * 0.18;
    final rect = Rect.fromCircle(center: c, radius: r - stroke / 2);
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.butt;
    p.color = _blue; canvas.drawArc(rect, -0.6, 1.6, false, p);
    p.color = _green; canvas.drawArc(rect, 1.0, 1.2, false, p);
    p.color = _yellow; canvas.drawArc(rect, 2.2, 1.4, false, p);
    p.color = _red; canvas.drawArc(rect, 3.6, 1.8, false, p);
    final bar = Paint()..color = _blue;
    canvas.drawRect(Rect.fromLTWH(
        c.dx, c.dy - size.height * 0.06, size.width * 0.45, size.height * 0.12), bar);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
