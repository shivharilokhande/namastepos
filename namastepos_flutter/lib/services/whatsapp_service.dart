// NamastePOS - WhatsApp notifications
//
// We open the WhatsApp deep link with prefilled text. This avoids needing
// WhatsApp Business API approval upfront — owners just tap "Send" once.

import 'package:url_launcher/url_launcher.dart';

import '../models/business.dart';
import '../models/order.dart';

class WhatsAppService {
  WhatsAppService._();
  static final WhatsAppService instance = WhatsAppService._();

  /// Builds an "order ready" message and opens WhatsApp chat with the customer.
  Future<bool> notifyOrderReady(Order order, Business biz) async {
    if (order.customerPhone == null || order.customerPhone!.isEmpty) return false;
    final cleanPhone = _normalize(order.customerPhone!);
    final msg = StringBuffer()
      ..writeln('Hi! Your order from *${biz.name}* is ready for pickup. ')
      ..writeln('')
      ..writeln('Token: #${order.orderNo}')
      ..writeln('Items: ${order.items.map((e) => '${e.name} x${e.qty.toInt()}').join(', ')}')
      ..writeln('Total: Rs. ${order.total.toStringAsFixed(2)}')
      ..writeln('')
      ..writeln('Thank you! - ${biz.name}');
    return _open(cleanPhone, msg.toString());
  }

  /// Builds a generic order confirmation message.
  Future<bool> notifyOrderConfirmed(Order order, Business biz) async {
    if (order.customerPhone == null || order.customerPhone!.isEmpty) return false;
    final cleanPhone = _normalize(order.customerPhone!);
    final msg = StringBuffer()
      ..writeln('Order confirmed at *${biz.name}*!')
      ..writeln('Token: #${order.orderNo}')
      ..writeln('Items: ${order.items.map((e) => '${e.name} x${e.qty.toInt()}').join(', ')}')
      ..writeln('Total: Rs. ${order.total.toStringAsFixed(2)}')
      ..writeln('Estimated ready: 10–15 mins');
    return _open(cleanPhone, msg.toString());
  }

  Future<bool> _open(String phone, String message) async {
    final uri = Uri.parse(
        'https://wa.me/$phone?text=${Uri.encodeComponent(message)}');
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      return false;
    }
  }

  String _normalize(String raw) {
    final digits = raw.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.length == 10) return '91$digits';      // assume India
    return digits;
  }
}
