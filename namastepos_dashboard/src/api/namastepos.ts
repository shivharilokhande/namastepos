// NamastePOS dashboard - business-scoped API helpers

import { api, getBusinessCache } from './client';

// Push 15d — trigger a save-as in the browser for a Blob (PDF/XLSX/CSV).
// axios is the auth path so the file is fetched WITH the Bearer token;
// once we have the blob in memory we synthesise an <a download> click
// and immediately revoke the object URL.
function _triggerBlobDownload(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const ffApi = {
  // Auth
  googleLogin: (idToken: string) =>
    api.post('/auth/google', { idToken }).then((r) => r.data),
  passwordLogin: (email: string, password: string) =>
    api.post('/auth/login', { email, password }).then((r) => r.data),
  register: (body: { email: string; password: string; name?: string; businessName?: string }) =>
    api.post('/auth/register', body).then((r) => r.data),
  me: () => api.get('/auth/me').then((r) => r.data),
  patchMe: (patch: any) => api.patch('/auth/me', patch).then((r) => r.data),

  // Image upload
  uploadImage: (file: File) => {
    const b = getBusinessCache();
    const fd = new FormData();
    fd.append('file', file);
    return api.post(`/businesses/${b.id}/uploads`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data);
  },

  // Menu
  listMenu: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/menu`).then((r) => r.data.items);
  },
  createMenuItem: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/menu`, body).then((r) => r.data.item);
  },
  updateMenuItem: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/menu/${id}`, body).then((r) => r.data.item);
  },
  deleteMenuItem: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/menu/${id}`).then((r) => r.data);
  },
  // FF-218: bulk CSV import for menu items. Body is [{name, price, category, ...}, ...].
  bulkImportMenu: (items: any[]) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/menu/bulk`, { items }).then((r) => r.data);
  },
  // FF-244 owner inbox
  actionCenter: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/action-center`).then((r) => r.data);
  },
  // FF-246 revenue leakage
  revenueLeakage: (from?: string, to?: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/leakage`,
      { params: { from, to } }).then((r) => r.data);
  },
  // 2026-08-23 — owner-facing refunds list, scoped to this business. Backs
  // the Refunds page so refund history is visible on the owner's own
  // dashboard (previously only on the platform admin panel).
  listRefunds: (params?: { status?: string; limit?: number }) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/refunds`, { params }).then((r) => r.data.refunds);
  },
  // FF-304 partial refund for an order
  refundOrder: (orderId: string, body: { itemIds?: string[]; amountInr?: number; reason?: string }) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/orders/${orderId}/refund`, body).then((r) => r.data);
  },

  // Orders
  listOrders: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/orders`, { params }).then((r) => r.data.orders);
  },
  // Walk-in / counter order from the web dashboard (mirrors the mobile POS).
  createOrder: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/orders`, body).then((r) => r.data.order);
  },
  updateOrderStatus: (orderId: string, status: string, reason?: string, reasonCode?: string) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/orders/${orderId}/status`,
      { status, reason, reasonCode }).then((r) => r.data);
  },
  // Sprint 1 — reprint, variants, modifiers, 86, cancel reasons, bill template
  reprintOrder: (orderId: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/orders/${orderId}/reprint`).then((r) => r.data);
  },
  listVariants: (itemId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/menu/${itemId}/variants`).then((r) => r.data.variants);
  },
  setVariants: (itemId: string, variants: any[]) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/menu/${itemId}/variants`, { variants }).then((r) => r.data);
  },
  listModifierGroups: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/modifier-groups`).then((r) => r.data.groups);
  },
  upsertModifierGroup: (body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/modifier-groups`, body).then((r) => r.data.groups);
  },
  setItemModifierGroups: (itemId: string, groupIds: string[]) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/menu/${itemId}/modifier-groups`, { groupIds }).then((r) => r.data);
  },
  getItemModifierGroups: (itemId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/menu/${itemId}/modifier-groups`).then((r) => r.data.groupIds || []);
  },
  toggleSoldOut: (itemId: string, until: string | null) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/menu/${itemId}/sold-out`, { until }).then((r) => r.data);
  },
  listCancelReasons: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/cancel-reasons`).then((r) => r.data.reasons);
  },
  getBillTemplate: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/bill-template`).then((r) => r.data.template);
  },
  updateBillTemplate: (body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/bill-template`, body).then((r) => r.data.template);
  },

  // ── Sprints 2-10 ────────────────────────────────────────────────────────
  // Aggregators
  listAggregators: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/aggregators`).then((r) => r.data.credentials); },
  saveAggregator: (body: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/aggregators`, body).then((r) => r.data.credentials); },
  listMappingIssues: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/aggregators/mapping-issues`).then((r) => r.data.issues); },
  setExternalSku: (itemId: string, provider: string, sku: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/aggregators/menu-items/${itemId}/sku`, { provider, sku }).then((r) => r.data); },
  // Daily closing
  previewClosing: (date?: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/daily-closings/preview`, { params: { date } }).then((r) => r.data.preview); },
  listClosings: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/daily-closings`).then((r) => r.data.closings); },
  closeDay: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/daily-closings`, body).then((r) => r.data.closing); },
  // Wastage
  wastageReport: (params?: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/wastage`, { params }).then((r) => r.data.report); },
  logWastage: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/wastage`, body).then((r) => r.data.entry); },
  // Reservations
  listReservations: (params?: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/reservations`, { params }).then((r) => r.data.reservations); },
  createReservation: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/reservations`, body).then((r) => r.data.reservation); },
  updateReservation: (id: string, patch: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/reservations/${id}`, patch).then((r) => r.data.reservation); },
  seatReservation: (id: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/reservations/${id}/seat`).then((r) => r.data.reservation); },
  listWaitList: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/wait-list`).then((r) => r.data.entries); },
  addToWaitList: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/wait-list`, body).then((r) => r.data.entry); },
  // Discount approvals
  approveDiscount: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/discount-approvals`, body).then((r) => r.data.approval); },
  setDiscountThreshold: (inr: number) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/discount-approvals/threshold`, { inr }).then((r) => r.data); },
  setMyDiscountPin: (pin: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/me/discount-pin`, { pin }).then((r) => r.data); },
  // Customer history
  customerProfile: (phone: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/customer-history/${phone}`).then((r) => r.data); },
  reorderSameAsLast: (customerId: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/customers/${customerId}/reorder-last`).then((r) => r.data.items); },
  // Memberships + gift cards
  listMemberships: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/memberships`).then((r) => r.data.memberships); },
  createMembership: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/memberships`, body).then((r) => r.data.membership); },
  updateMembership: (id: string, body: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/memberships/${id}`, body).then((r) => r.data.membership); },
  deleteMembership: (id: string) => { const b = getBusinessCache(); return api.delete(`/businesses/${b.id}/memberships/${id}`).then((r) => r.data); },
  membershipSubscribers: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/memberships/subscribers`).then((r) => r.data.subscribers); },
  listGiftCards: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/gift-cards`).then((r) => r.data.giftCards); },
  issueGiftCard: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/gift-cards`, body).then((r) => r.data.giftCard); },
  redeemGiftCard: (code: string, body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/gift-cards/${code}/redeem`, body).then((r) => r.data); },
  recordTip: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/tips`, body).then((r) => r.data.tip); },
  tipReport: (params?: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/tips/report`, { params }).then((r) => r.data.report); },
  // Printers
  listPrinters: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/printers`).then((r) => r.data.printers); },
  upsertPrinter: (body: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/printers`, body).then((r) => r.data.printer); },
  // Drivers
  listDrivers: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/drivers`).then((r) => r.data.drivers); },
  createDriver: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/drivers`, body).then((r) => r.data.driver); },
  assignDriver: (orderId: string, body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/orders/${orderId}/assign-driver`, body).then((r) => r.data.assignment); },
  liveDeliveries: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/delivery-assignments/live`).then((r) => r.data.assignments); },
  // Site + WhatsApp
  getSite: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/site`).then((r) => r.data.site); },
  updateSite: (body: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/site`, body).then((r) => r.data.site); },
  listCampaigns: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/wa/campaigns`).then((r) => r.data.campaigns); },
  createCampaign: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/wa/campaigns`, body).then((r) => r.data.campaign); },
  runCampaign: (id: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/wa/campaigns/${id}/run`).then((r) => r.data); },
  // Accounting exports
  exportTally: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/exports/tally`, body, { responseType: 'text' }).then((r) => r.data); },
  exportZoho: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/exports/zoho`, body, { responseType: 'text' }).then((r) => r.data); },
  generateEinvoice: (orderId: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/einvoice/${orderId}`).then((r) => r.data.irn); },
  // Multi-outlet
  listOutletGroups: () => api.get('/outlet-groups').then((r) => r.data.groups),
  createOutletGroup: (body: any) => api.post('/outlet-groups', body).then((r) => r.data.group),
  outletRollup: (groupId: string, params: any) => api.get(`/outlet-groups/${groupId}/rollup`, { params }).then((r) => r.data.rollup),
  // Retail
  listRetailItems: (params?: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/retail/items`, { params }).then((r) => r.data.items); },
  createRetailItem: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/items`, body).then((r) => r.data.item); },
  findRetailByBarcode: (barcode: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/retail/barcode/${barcode}`).then((r) => r.data.item); },
  bulkImportRetail: (rows: any[]) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/bulk-import`, { rows }).then((r) => r.data); },
  listVendors: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/retail/vendors`).then((r) => r.data.vendors); },
  createVendor: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/vendors`, body).then((r) => r.data.vendor); },
  createPO: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/purchase-orders`, body).then((r) => r.data.po); },
  receivePO: (poId: string, body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/purchase-orders/${poId}/receive`, body).then((r) => r.data.grn); },
  recordCheque: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/cheques`, body).then((r) => r.data.cheque); },

  // ── Final-100 endpoints ────────────────────────────────────────────────
  splitBill: (sessionId: string, body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/sessions/${sessionId}/split`, body).then((r) => r.data.split); },
  paySplitInvoice: (id: string, paymentMethod: string) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/bill-split-invoices/${id}/pay`, { paymentMethod }).then((r) => r.data.invoice); },
  listFoodCoupons: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/food-coupons`).then((r) => r.data.coupons); },
  applyFoodCoupon: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/food-coupons/apply`, body).then((r) => r.data); },
  listReviews: (params?: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/reviews`, { params }).then((r) => r.data.reviews); },
  reviewStats: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/reviews/stats`).then((r) => r.data.stats); },
  replyReview: (id: string, reply: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/reviews/${id}/reply`, { reply }).then((r) => r.data.review); },
  forecast: (date?: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/forecast`, { params: { date } }).then((r) => r.data.forecast); },
  refreshForecast: () => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/forecast/refresh`).then((r) => r.data); },
  upsellFor: (menuItemId: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/upsell/${menuItemId}`).then((r) => r.data.suggestions); },
  seedCoa: () => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/accounting/seed-coa`).then((r) => r.data); },
  trialBalance: (asOf?: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/accounting/trial-balance`, { params: { asOf } }).then((r) => r.data.tb); },
  profitAndLoss: (params: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/accounting/profit-loss`, { params }).then((r) => r.data.pnl); },
  balanceSheet: (asOf?: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/accounting/balance-sheet`, { params: { asOf } }).then((r) => r.data.bs); },
  listSurgeRules: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/surge/rules`).then((r) => r.data.rules); },
  createSurgeRule: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/surge/rules`, body).then((r) => r.data.rule); },
  updateSurgeRule: (id: string, body: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/surge/rules/${id}`, body).then((r) => r.data.rule); },
  deleteSurgeRule: (id: string) => { const b = getBusinessCache(); return api.delete(`/businesses/${b.id}/surge/rules/${id}`).then((r) => r.data); },
  pollKds: (stationId: string, since?: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/kds/${stationId}/poll`, { params: { since } }).then((r) => r.data.tickets); },
  markKdsTicket: (ticketId: string, status: string) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/kds/tickets/${ticketId}/status`, { status }).then((r) => r.data.ticket); },
  importBank: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/bank/import`, body).then((r) => r.data); },
  autoMatchBank: () => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/bank/auto-match`).then((r) => r.data); },
  unmatchedBank: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/bank/unmatched`).then((r) => r.data.rows); },

  // Expenses
  listExpenses: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/expenses`, { params }).then((r) => r.data.expenses);
  },
  createExpense: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/expenses`, body).then((r) => r.data.expense);
  },
  deleteExpense: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/expenses/${id}`).then((r) => r.data);
  },

  // Reports
  dailyReport: (date: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/daily`, { params: { date } }).then((r) => r.data.report);
  },
  monthlyReport: (month: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/monthly`, { params: { month } }).then((r) => r.data.report);
  },
  // Push 15 — Schedule III income statement (P&L) with exports
  incomeStatement: (startDate: string, endDate: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/income-statement`,
      { params: { startDate, endDate } }).then((r) => r.data.report);
  },
  // Download an export. Auth is via the same Bearer header axios adds, so
  // we go through axios instead of an <a href> (which wouldn't include
  // the token). Triggers a save-as in the browser via a blob URL.
  downloadIncomeStatement: async (format: 'pdf' | 'xlsx' | 'csv',
                                  startDate: string, endDate: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/reports/income-statement.${format}`,
      { params: { startDate, endDate }, responseType: 'blob' }
    );
    _triggerBlobDownload(r.data, `pnl_${startDate}_${endDate}.${format}`);
  },

  // Push 15h — register detail reports (Income / Expense / Invoices)
  incomeRegister: (startDate: string, endDate: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/income-register`,
      { params: { startDate, endDate } }).then((r) => r.data.report);
  },
  downloadIncomeRegister: async (format: 'pdf' | 'xlsx' | 'csv',
                                 startDate: string, endDate: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/reports/income-register.${format}`,
      { params: { startDate, endDate }, responseType: 'blob' }
    );
    _triggerBlobDownload(r.data, `income_register_${startDate}_${endDate}.${format}`);
  },
  expenseRegister: (startDate: string, endDate: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/expense-register`,
      { params: { startDate, endDate } }).then((r) => r.data.report);
  },
  downloadExpenseRegister: async (format: 'pdf' | 'xlsx' | 'csv',
                                  startDate: string, endDate: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/reports/expense-register.${format}`,
      { params: { startDate, endDate }, responseType: 'blob' }
    );
    _triggerBlobDownload(r.data, `expense_register_${startDate}_${endDate}.${format}`);
  },
  invoiceRegister: (startDate: string, endDate: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/invoice-register`,
      { params: { startDate, endDate } }).then((r) => r.data.report);
  },
  downloadInvoiceRegister: async (format: 'pdf' | 'xlsx' | 'csv',
                                  startDate: string, endDate: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/reports/invoice-register.${format}`,
      { params: { startDate, endDate }, responseType: 'blob' }
    );
    _triggerBlobDownload(r.data, `invoice_register_${startDate}_${endDate}.${format}`);
  },
  // Push 15c — Tax invoices (GST Rule 46)
  listTaxInvoices: (params: { startDate?: string; endDate?: string; status?: string } = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/tax-invoices`, { params })
      .then((r) => r.data.invoices);
  },
  issueTaxInvoice: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/tax-invoices`, body)
      .then((r) => r.data.invoice);
  },
  getTaxInvoice: (invoiceId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/tax-invoices/${invoiceId}`)
      .then((r) => r.data.invoice);
  },
  downloadTaxInvoicePdf: async (invoiceId: string, invoiceNo?: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/tax-invoices/${invoiceId}/pdf`,
      { responseType: 'blob' }
    );
    const safe = (invoiceNo || invoiceId).replace(/[\/\\]/g, '_');
    _triggerBlobDownload(r.data, `tax_invoice_${safe}.pdf`);
  },
  // Returns a blob URL the caller is responsible for revoking — useful
  // for opening a print preview in a new tab (window.open(url)).
  taxInvoicePrintBlobUrl: async (invoiceId: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/tax-invoices/${invoiceId}/pdf`,
      { responseType: 'blob' }
    );
    return URL.createObjectURL(r.data as Blob);
  },
  cancelTaxInvoice: (invoiceId: string, reason?: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/tax-invoices/${invoiceId}/cancel`, { reason })
      .then((r) => r.data.invoice);
  },

  // Staff
  listStaff: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/staff`).then((r) => r.data.members);
  },
  listInvites: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/staff/invites`).then((r) => r.data.invitations);
  },
  inviteStaff: (email: string, role: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/staff/invites`, { email, role }).then((r) => r.data);
  },
  removeStaff: (userId: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/staff/${userId}`).then((r) => r.data);
  },

  // Push 14a — direct PIN-based staff CRUD (no email invite required).
  listStaffPin: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/staff/pin`).then((r) => r.data.staff);
  },
  createStaffPin: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/staff/pin`, body).then((r) => r.data.staff);
  },
  updateStaffPin: (userId: string, patch: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/staff/pin/${userId}`, patch).then((r) => r.data.staff);
  },
  // Push 14e — auto-comply with plan limit. Deactivates excess non-owner
  // staff (newest hires) until active count matches plan.limits.staff.
  complyStaffLimit: () => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/staff/pin/comply-limit`).then((r) => r.data);
  },

  // Billing
  subscription: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/billing`).then((r) => r.data.subscription);
  },
  plans: () => api.get('/plans').then((r) => r.data.plans),
  // FF-402c — cadence is now a sibling arg (plan tier is one row that
  // carries both prices). Backend picks the right Razorpay plan id
  // and price based on billingPeriod.
  changePlan: (tier: string, billingPeriod?: 'monthly' | 'yearly') => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/billing/change`, { tier, billingPeriod }).then((r) => r.data);
  },
  cancelSubscription: () => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/billing/cancel`).then((r) => r.data);
  },
  invoices: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/billing/invoices`).then((r) => r.data.invoices);
  },
  // 2026-08-26 — GST-compliant subscription invoice PDF, generated on demand.
  subscriptionInvoicePdf: (invoiceId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/billing/invoices/${invoiceId}/pdf`,
      { responseType: 'blob' }).then((r) => r.data as Blob);
  },

  // Add-on marketplace
  catalogAddons: () => api.get('/addons').then((r) => r.data.addons),
  myAddons: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/addons`).then((r) => r.data);
  },
  subscribeAddon: (slug: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/addons/subscribe`, { slug }).then((r) => r.data);
  },
  cancelAddon: (slug: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/addons/${slug}/cancel`).then((r) => r.data);
  },
  resumeAddon: (slug: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/addons/${slug}/resume`).then((r) => r.data);
  },

  // ── Loyalty / CRM ──────────────────────────────────────────────────────
  listCustomers: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/customers`, { params }).then((r) => r.data);
  },
  customerDetail: (customerId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/customers/${customerId}`).then((r) => r.data);
  },
  lookupCustomer: (phone: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/customers/lookup`, { params: { phone } }).then((r) => r.data);
  },
  upsertCustomer: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/customers`, body).then((r) => r.data.customer);
  },
  updateCustomer: (customerId: string, patch: any) => {
    const b = getBusinessCache();
    return api.patch(`/businesses/${b.id}/customers/${customerId}`, patch).then((r) => r.data.customer);
  },
  adjustPoints: (customerId: string, points: number, note?: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/customers/${customerId}/points`, { points, note }).then((r) => r.data);
  },
  getLoyaltySettings: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/customers/_settings/loyalty`).then((r) => r.data.settings);
  },
  updateLoyaltySettings: (body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/customers/_settings/loyalty`, body).then((r) => r.data.settings);
  },

  // ── KOT + Tables (Sprint 2) ─────────────────────────────────────────────
  // Stations
  listStations: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/kot/stations`).then((r) => r.data.stations);
  },
  createStation: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ops/kot/stations`, body).then((r) => r.data.station);
  },
  updateStation: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ops/kot/stations/${id}`, body).then((r) => r.data.station);
  },
  deleteStation: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/ops/kot/stations/${id}`).then((r) => r.data);
  },
  // Tickets
  listTickets: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/kot/tickets`, { params }).then((r) => r.data.tickets);
  },
  updateTicketStatus: (id: string, status: string) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ops/kot/tickets/${id}/status`, { status }).then((r) => r.data.ticket);
  },
  // Floors
  listFloors: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/floors`).then((r) => r.data.floors);
  },
  createFloor: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ops/floors`, body).then((r) => r.data.floor);
  },
  updateFloor: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ops/floors/${id}`, body).then((r) => r.data.floor);
  },
  deleteFloor: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/ops/floors/${id}`).then((r) => r.data);
  },
  // Tables
  listOpsTables: (floorId?: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/tables`, { params: floorId ? { floorId } : {} }).then((r) => r.data.tables);
  },
  createOpsTable: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ops/tables`, body).then((r) => r.data.table);
  },
  updateOpsTable: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ops/tables/${id}`, body).then((r) => r.data.table);
  },
  deleteOpsTable: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/ops/tables/${id}`).then((r) => r.data);
  },
  // Sessions
  openSession: (tableId: string, body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ops/tables/${tableId}/sessions`, body).then((r) => r.data.session);
  },
  closeSession: (sessionId: string, paymentMethod?: string) => {
    const b = getBusinessCache();
    return api
      .post(`/businesses/${b.id}/ops/sessions/${sessionId}/close`, { paymentMethod })
      .then((r) => r.data.session);
  },
  // Push 22 — release a table whose customer left without ordering.
  // Refuses if any non-cancelled orders are attached.
  abandonSession: (sessionId: string) => {
    const b = getBusinessCache();
    return api
      .post(`/businesses/${b.id}/ops/sessions/${sessionId}/abandon`)
      .then((r) => r.data.session);
  },
  sessionDetail: (sessionId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/sessions/${sessionId}`).then((r) => r.data.session);
  },

  // ── QR ordering (Sprint 3) ─────────────────────────────────────────────
  qrSettings: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/qr/settings`).then((r) => r.data.settings);
  },
  updateQrSettings: (body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ops/qr/settings`, body).then((r) => r.data.settings);
  },
  qrTokenForTable: (tableId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/tables/${tableId}/qr`)
      .then((r) => {
        if (!r.data?.token) {
          // eslint-disable-next-line no-console
          console.warn('[qrTokenForTable] backend returned no token:', r.data);
          throw new Error('No QR token returned by server');
        }
        return r.data.token as string;
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[qrTokenForTable] failed for table', tableId, e?.response?.status, e?.response?.data || e?.message);
        throw e;
      });
  },
  rotateQrToken: (tableId: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ops/tables/${tableId}/qr/rotate`).then((r) => r.data.token);
  },

  // ── Ingredients & recipes (Sprint 4) ───────────────────────────────────
  listIngredients: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ingredients`, { params }).then((r) => r.data.ingredients);
  },
  createIngredient: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ingredients`, body).then((r) => r.data.ingredient);
  },
  updateIngredient: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.patch(`/businesses/${b.id}/ingredients/${id}`, body).then((r) => r.data.ingredient);
  },
  deleteIngredient: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/ingredients/${id}`).then((r) => r.data);
  },
  purchaseIngredient: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ingredients/${id}/purchase`, body).then((r) => r.data.ingredient);
  },
  adjustIngredient: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ingredients/${id}/adjust`, body).then((r) => r.data.ingredient);
  },
  getRecipe: (menuItemId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ingredients/_recipes/${menuItemId}`).then((r) => r.data.lines);
  },
  setRecipe: (menuItemId: string, lines: any[]) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ingredients/_recipes/${menuItemId}`, { lines }).then((r) => r.data.lines);
  },
  foodCostReport: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ingredients/_report/food-cost`, { params }).then((r) => r.data.report);
  },

  // ── DPDP compliance ────────────────────────────────────────────────
  // Append-only consent record. Backend writes a new consent_events
  // row every time; never updates an existing one.
  recordConsent: (body: {
    consentKey: string;
    granted: boolean;
    policyVersion?: string;
    source?: string;
    context?: Record<string, unknown>;
  }) => api.post('/me/consents', { source: 'dashboard', ...body }).then((r) => r.data),
  currentConsents: () => api.get('/me/consents').then((r) => r.data.consents),
  consentHistory: () => api.get('/me/consents/history').then((r) => r.data.history),
  fileDsr: (body: { requestType: string; details?: Record<string, unknown> }) =>
    api.post('/me/dsr', body).then((r) => r.data),
  listMyDsrs: () => api.get('/me/dsr').then((r) => r.data.requests),
  fileCorrection: (body: { field: string; newValue: unknown; reason?: string }) =>
    api.post('/me/correct', body).then((r) => r.data),
  exportMyData: () => api.get('/me/export').then((r) => r.data),
  eraseMyAccount: () => api.delete('/me/account').then((r) => r.data),

  // Public — no auth
  grievanceOfficer: () => api.get('/compliance/grievance-officer').then((r) => r.data),
  fileGrievance: (body: {
    businessId?: string;
    complainantName?: string;
    complainantEmail?: string;
    complainantPhone?: string;
    category?: string;
    subject: string;
    body: string;
  }) => api.post('/compliance/grievance', body).then((r) => r.data),
};
