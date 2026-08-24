// NamastePOS dashboard — In-app help center (FF-302).
//
// 15 short articles that answer the questions cafe owners actually
// ask in the first week. Kept as an in-memory array (no CMS, no MDX,
// no fetch) so it works offline and ships with the bundle. When we
// have more than 30 articles we'll move to a real docs site.
//
// Search is a case-insensitive substring match against title + body.

import { useState, useMemo } from 'react';
import { HelpCircle, Search, MessageCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface Article {
  id: string;
  category: 'setup' | 'orders' | 'payments' | 'staff' | 'compliance' | 'plans';
  title: string;
  body: string;
}

const ARTICLES: Article[] = [
  {
    id: 'setup-first-order',
    category: 'setup',
    title: 'How do I place my first order?',
    body:
      'Open the mobile app on your phone or tablet, tap the POS tab, tap a menu item to add it to the cart, then Review & Pay → Place Order. If you have a Bluetooth thermal printer paired, the token prints automatically. Nothing to configure — the setup wizard already added a starter menu.',
  },
  {
    id: 'setup-printer',
    category: 'setup',
    title: 'How do I connect a Bluetooth thermal printer?',
    body:
      "Turn on the printer, put your phone into Settings → Bluetooth, pair the printer once. Back in the NamastePOS app go to Settings → Printers → Scan. Tap the printer you just paired and hit Test print. The app will remember it across restarts.",
  },
  {
    id: 'setup-tables',
    category: 'setup',
    title: 'How do I add tables?',
    body:
      "Dashboard → Tables → + Add table. Give each table a label (like '1', 'A2', or 'window-3'), a seat count, and optionally drag it onto the floor plan. On mobile, Captain view shows exactly what you laid out here.",
  },
  {
    id: 'setup-menu-csv',
    category: 'setup',
    title: 'Can I import my whole menu from Excel?',
    body:
      "Yes. Dashboard → Menu → Bulk import CSV. Download the sample CSV to see the columns (Name, Price are required; Category, Description, Veg, GST, HSN are optional). Fill it in Excel, save as CSV, upload. You can preview before committing.",
  },
  {
    id: 'orders-cancel',
    category: 'orders',
    title: 'How do I cancel an order?',
    body:
      "Open the order (Orders tab → tap the card). If the KOT hasn't printed yet, use the cross icon on the order card in the Orders list. Once KOT is printed, a manager PIN is required. Add a cancel reason — it shows up in the Revenue Leakage report.",
  },
  {
    id: 'orders-refund',
    category: 'orders',
    title: 'How do I refund a customer?',
    body:
      "Open the order → Refund → choose either specific items to refund or a custom rupee amount. The refund goes back to the same payment method (Razorpay for UPI/card). Cash refunds are recorded but not processed automatically — you hand back the cash and mark it done.",
  },
  {
    id: 'orders-mark-ready',
    category: 'orders',
    title: 'How does the kitchen know an order is ready?',
    body:
      "The Kitchen Display (KDS) shows every pending KOT. When the dish is done, tap Mark Ready on that ticket. The Orders queue immediately updates, and if the customer left a phone number and WhatsApp auto-notify is on, a message goes out automatically.",
  },
  {
    id: 'orders-online',
    category: 'orders',
    title: 'Where do Zomato / Swiggy orders show up?',
    body:
      "In the same Orders queue, tagged with the aggregator's badge. Enable the Online Orders add-on from Marketplace and configure the webhook URLs on the aggregator's dashboard (Aggregators tab in NamastePOS → copy the URLs). Each order shows a 'last synced' badge under the integration once webhooks start arriving.",
  },
  {
    id: 'payments-methods',
    category: 'payments',
    title: 'Which payment methods do you support?',
    body:
      'Cash, UPI (any app via Razorpay), all major credit/debit cards, and wallets. UPI + card require the Razorpay add-on active — start on any paid plan, works out of the box. Cash is always available regardless of plan.',
  },
  {
    id: 'payments-daily-closing',
    category: 'payments',
    title: 'How do I close the day?',
    body:
      "Dashboard → Daily closing. It shows expected cash (all cash orders today), you enter counted cash, the app computes variance. Sign the report as cashier, add any notes, lock the day. Once locked you can't edit orders from that day without a manager PIN — this is your audit trail.",
  },
  {
    id: 'staff-add',
    category: 'staff',
    title: 'How do I add a captain / cashier?',
    body:
      "Dashboard → Staff → + Add staff. Fill in name + phone + role (Captain / Cashier / Manager / Kitchen). Set a 4-digit PIN. They sign into the mobile app by tapping 'Sign in as staff' on the login screen, picking their name, and entering the PIN. PINs can be reset from the same screen if forgotten.",
  },
  {
    id: 'staff-permissions',
    category: 'staff',
    title: 'Can I limit what staff can see?',
    body:
      "Yes. Staff → tap a person → Permissions. You can toggle which screens they see (Home, POS, Orders, Reports, Settings) and specific actions (cancel orders, apply discounts, refund). Kitchen role gets locked to just the KDS by default.",
  },
  {
    id: 'compliance-gst',
    category: 'compliance',
    title: 'How do I set up GST invoices?',
    body:
      "Dashboard → Settings → put in your GSTIN. Then Receipt template → make sure 'Show tax breakdown' is on. Every order with a customer phone auto-generates a GST-compliant Rule 46 tax invoice sequentially numbered per financial year. Find them under Tax Invoices.",
  },
  {
    id: 'compliance-dpdp',
    category: 'compliance',
    title: 'What does DPDP compliance mean for me?',
    body:
      'DPDP Act 2023 requires you to let customers request their data or ask you to delete it. NamastePOS handles this automatically — customers use the /privacy page to download their data or delete their account, and you (the owner) see any pending Data Subject Requests in Privacy → Requests.',
  },
  {
    id: 'plans-upgrade',
    category: 'plans',
    title: "What's included in each plan?",
    // Hardcode-audit fix (2026-08-24): removed hardcoded prices/limits —
    // they had drifted from the backend plan catalog (and referenced an
    // "Advanced" tier that doesn't exist). Billing → Compare plans is the
    // single source of truth, fed live from /v1/plans.
    body:
      'Starter covers POS + orders + basic menu + reports for a single cafe. Pro adds KDS, Zomato/Swiggy, captain mode, and unlimited menu. Enterprise adds multi-outlet + accounting exports. For current prices, staff limits, and the full feature grid, see Billing → Compare plans — it always shows live pricing.',
  },
];

const CATEGORIES: Record<Article['category'], string> = {
  setup: 'Getting started',
  orders: 'Taking orders',
  payments: 'Payments & money',
  staff: 'Your team',
  compliance: 'GST & DPDP',
  plans: 'Plans & billing',
};

export function HelpCenterPage() {
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    if (!q.trim()) return ARTICLES;
    const s = q.toLowerCase();
    return ARTICLES.filter((a) =>
      a.title.toLowerCase().includes(s) || a.body.toLowerCase().includes(s));
  }, [q]);
  const grouped: Record<string, Article[]> = {};
  for (const a of results) {
    (grouped[a.category] ??= []).push(a);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <HelpCircle className="h-6 w-6 text-primary" /> Help center
        </h1>
        <p className="text-muted-foreground text-sm">
          Answers to the questions cafe owners ask most.
        </p>
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search — e.g. 'printer', 'refund', 'staff PIN'…"
              className="pl-9" />
          </div>
        </CardContent>
      </Card>

      {Object.keys(grouped).length === 0 && (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <div className="text-muted-foreground">Nothing found for &ldquo;{q}&rdquo;.</div>
            <Button variant="outline" size="sm" onClick={() => {
              // Prompt Crisp if it's loaded, otherwise deep-link WhatsApp support.
              if ((window as any).$crisp) {
                (window as any).$crisp.push(['do', 'chat:open']);
                (window as any).$crisp.push(['do', 'message:send', ['text', q]]);
              } else if (import.meta.env.VITE_SUPPORT_WHATSAPP) {
                window.open(`https://wa.me/${import.meta.env.VITE_SUPPORT_WHATSAPP}?text=${encodeURIComponent('Help needed: ' + q)}`, '_blank');
              }
            }}>
              <MessageCircle className="h-3.5 w-3.5 mr-1" /> Ask a human
            </Button>
          </CardContent>
        </Card>
      )}

      {Object.entries(grouped).map(([cat, arts]) => (
        <Card key={cat}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{CATEGORIES[cat as Article['category']]}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {arts.map((a) => (
              <details key={a.id} className="border rounded-md p-3 open:bg-muted/30">
                <summary className="cursor-pointer font-medium">{a.title}</summary>
                <p className="pt-2 text-sm text-muted-foreground leading-relaxed">
                  {a.body}
                </p>
              </details>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
