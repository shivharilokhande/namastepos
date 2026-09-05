// NamastePOS backend - ESC/POS-style plain-text token receipt formatter
//
// Returns a printable string that any 58 mm thermal printer can render
// (we leave the actual ESC/POS byte encoding to the mobile app, but the
// API returns this string so receipts can be re-rendered or e-mailed).

function padRight(s, n) { return (s + ' '.repeat(n)).slice(0, n); }
function padLeft(s, n) { return (' '.repeat(n) + s).slice(-n); }
function center(s, width = 32) {
  if (s.length >= width) return s.slice(0, width);
  const left = Math.floor((width - s.length) / 2);
  return ' '.repeat(left) + s;
}
function hr(width = 32) { return '-'.repeat(width); }

/**
 * Format an order into a 32-column receipt string.
 *
 * `opts.whiteLabel` (2026-09-06, CONTRACTS §4) is the resolved result of
 * whiteLabelService.effective(businessId) — resolved by the CALLER, because this
 * formatter is synchronous and the plan check is not. `poweredBy` is printed
 * verbatim as the attribution line; null prints no line. Absent → NamastePOS,
 * exactly as before.
 */
function formatToken(order, business, width = 32, opts = {}) {
  const lines = [];
  lines.push(center(business.name.toUpperCase(), width));
  if (business.address) lines.push(center(business.address, width));
  if (business.phone) lines.push(center(`Ph: ${business.phone}`, width));
  if (business.gstin) lines.push(center(`GSTIN: ${business.gstin}`, width));
  lines.push(hr(width));

  lines.push(`${padRight(`TOKEN #${order.orderNo}`, width - 8)}${padLeft(order.source.toUpperCase(), 8)}`);
  lines.push(new Date(order.createdAt).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }));
  if (order.tableNo) lines.push(`Table: ${order.tableNo}`);
  if (order.customerPhone) lines.push(`Customer: ${order.customerPhone}`);
  lines.push(hr(width));

  // Item table
  lines.push(`${padRight('ITEM', 18)}${padLeft('QTY', 5)}${padLeft('AMT', 9)}`);
  lines.push(hr(width));
  for (const it of order.items) {
    const qty = Number(it.qty) % 1 === 0 ? String(Number(it.qty)) : Number(it.qty).toFixed(2);
    const amt = `Rs.${(Number(it.price) * Number(it.qty)).toFixed(0)}`;
    lines.push(`${padRight(it.name, 18)}${padLeft(qty, 5)}${padLeft(amt, 9)}`);
    if (it.note) lines.push(`  (${it.note})`);
  }
  lines.push(hr(width));

  // Totals
  const t = (label, val) => `${padRight(label, width - 12)}${padLeft(`Rs.${Number(val).toFixed(2)}`, 12)}`;
  lines.push(t('Subtotal', order.subtotal));
  if (Number(order.tax) > 0) lines.push(t('Tax', order.tax));
  if (Number(order.discount) > 0) lines.push(t('Discount', -order.discount));
  lines.push(t('TOTAL', order.total));
  lines.push(hr(width));

  lines.push(center(`PAID by ${order.paymentMethod.toUpperCase()}`, width));
  lines.push('');
  lines.push(center('Thank you! Visit again.', width));
  if (business.upi_id) lines.push(center(`UPI: ${business.upi_id}`, width));
  const wl = opts && opts.whiteLabel;
  const poweredBy = wl && Object.prototype.hasOwnProperty.call(wl, 'poweredBy')
    ? wl.poweredBy
    : 'NamastePOS';
  if (poweredBy) lines.push(center(`-- Powered by ${poweredBy} --`, width));
  return lines.join('\n');
}

module.exports = { formatToken };
