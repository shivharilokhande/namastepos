# Graph Report - PetPooja Clone  (2026-09-01)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 5977 nodes · 11987 edges · 273 communities (208 shown, 26 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 643 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ce184d30`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104
- Community 105
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112
- Community 113
- Community 114
- Community 115
- Community 116
- Community 117
- Community 118
- Community 119
- Community 120
- Community 121
- Community 122
- Community 123
- Community 124
- Community 125
- Community 126
- Community 127
- Community 128
- Community 129
- Community 130
- Community 131
- Community 132
- Community 133
- Community 134
- Community 135
- Community 136
- Community 137
- Community 138
- Community 139
- Community 140
- Community 141
- Community 142
- Community 143
- Community 144
- Community 145
- Community 146
- Community 147
- Community 148
- Community 149
- Community 150
- Community 151
- Community 152
- Community 153
- Community 154
- Community 155
- Community 156
- Community 157
- Community 158
- Community 159
- Community 160
- Community 161
- Community 162
- Community 163
- Community 164
- Community 165
- Community 166
- Community 167
- Community 168
- Community 169
- Community 170
- Community 171
- Community 172
- Community 173
- Community 174
- Community 175
- Community 176
- Community 177
- Community 178
- Community 179
- Community 180
- Community 181
- Community 182
- Community 183
- Community 184
- Community 185
- Community 186
- Community 187
- Community 188
- Community 189
- Community 190
- Community 191
- Community 192
- Community 193
- Community 194
- Community 195
- Community 196
- Community 197
- Community 198
- Community 199
- Community 200
- Community 201
- Community 202
- Community 203
- Community 204
- Community 205
- Community 206
- Community 207
- Community 208
- Community 209
- Community 210
- Community 211
- Community 212
- Community 213
- Community 214
- Community 215
- Community 216
- Community 217
- Community 218
- Community 219
- Community 220
- Community 221
- Community 222
- Community 223
- Community 224
- Community 225
- Community 232
- Community 233
- Community 234
- Community 235
- Community 236
- Community 237
- Community 238
- Community 259

## God Nodes (most connected - your core abstractions)
1. `query()` - 572 edges
2. `AuthProvider` - 233 edges
3. `NotFound` - 166 edges
4. `BadRequest` - 154 edges
5. `apiError()` - 125 edges
6. `formatINR()` - 94 edges
7. `withTransaction()` - 88 edges
8. `_` - 78 edges
9. `Button` - 60 edges
10. `ffApi` - 57 edges

## Surprising Connections (you probably didn't know these)
- `verify()` --calls--> `Forbidden`  [EXTRACTED]
  namastepos_backend/src/middleware/csrf.js → namastepos_backend/src/utils/errors.js
- `verifyIdToken()` --calls--> `Unauthorized`  [EXTRACTED]
  namastepos_backend/src/services/googleService.js → namastepos_backend/src/utils/errors.js
- `validate()` --calls--> `BadRequest`  [EXTRACTED]
  namastepos_backend/src/middleware/validate.js → namastepos_backend/src/utils/errors.js
- `recordUse()` --calls--> `BadRequest`  [EXTRACTED]
  namastepos_backend/src/services/foodCouponService.js → namastepos_backend/src/utils/errors.js
- `main()` --calls--> `query()`  [EXTRACTED]
  namastepos_backend/scripts/rotate-super-admin.js → namastepos_backend/src/config/db.js

## Import Cycles
- 2-file cycle: `namastepos_backend/src/services/addonService.js -> namastepos_backend/src/services/razorpayService.js -> namastepos_backend/src/services/addonService.js`
- 2-file cycle: `namastepos_backend/src/services/npsService.js -> namastepos_backend/src/services/whatsappService.js -> namastepos_backend/src/services/npsService.js`

## Communities (273 total, 26 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.02
Nodes (152): env, logger, query(), fetch(), { query }, getCustomer(), { issueAccessToken }, listCustomers() (+144 more)

### Community 1 - "Community 1"
Cohesion: 0.01
Nodes (143): Dio get, Future, adjustStock, ApiService, applyFoodCoupon, _authInterceptor, baseUrl, bulkImportMenu (+135 more)

### Community 2 - "Community 2"
Cohesion: 0.03
Nodes (110): withTransaction(), createCheckoutOrder, paySession, { BadRequest, NotFound }, listForSession(), paySplit(), { query, withTransaction }, splitSession() (+102 more)

### Community 3 - "Community 3"
Cohesion: 0.02
Nodes (120): addActivityCtrl, addNote, addNoteBody, ADMIN_COOKIE_CLEAR_OPTS, ADMIN_COOKIE_OPTS, adminCust, adminLegacy, adminTeam (+112 more)

### Community 4 - "Community 4"
Cohesion: 0.03
Nodes (85): api, bootstrapAuth(), exitImpersonation(), getToken(), isImpersonating(), setBusinessCache(), setSession(), AccountingPage (+77 more)

### Community 5 - "Community 5"
Cohesion: 0.03
Nodes (88): ../billing/billing_screen.dart, ../billing/trial_expired_screen.dart, ChangeNotifier, dashboard_screen.dart, ../driver/driver_screen.dart, GlobalKey, ../inventory/inventory_screen.dart, ../invoices/tax_invoices_screen.dart (+80 more)

### Community 6 - "Community 6"
Cohesion: 0.03
Nodes (84): apiError(), getBusinessCache(), TablesPage, ActiveSubscription, AddMembershipDialog(), CancelMembershipDialog(), CancelRefund, CustomerDetailDrawer() (+76 more)

### Community 7 - "Community 7"
Cohesion: 0.06
Nodes (70): IngredientsPage, DateInput, DateInputProps, _toDisplay(), _toISO(), Dialog, DialogContent, DialogDescription (+62 more)

### Community 8 - "Community 8"
Cohesion: 0.03
Nodes (81): ../constants/strings.dart, MaterialPageRoute, members_screen.dart, AuthProvider, _afterAuth, _blue, build, createState (+73 more)

### Community 9 - "Community 9"
Cohesion: 0.03
Nodes (79): _Kind, _FloorPlan, _KotPaidChip, _Tile, _CaptainTab, _KitchenTab, _MinimalMoreTab, _WelcomeFallback (+71 more)

### Community 10 - "Community 10"
Cohesion: 0.04
Nodes (70): addons, { HttpError }, requireAddon(), bcrypt, complete2faLogin(), create(), deactivate(), ensureBootstrap() (+62 more)

### Community 11 - "Community 11"
Cohesion: 0.13
Nodes (38): ffApi, WastagePage, Props, autoMatch(), normalise(), Pair, parseInput(), Props (+30 more)

### Community 12 - "Community 12"
Cohesion: 0.04
Nodes (70): edit_item_screen.dart, item_detail_screen.dart, Map, ../models/inventory_transaction.dart, MenuItem, adjust, _history, InventoryProvider (+62 more)

### Community 13 - "Community 13"
Cohesion: 0.04
Nodes (71): OrdersScreen, _OrdersScreenState, _IncomeDetailSheet, _IncomeDetailSheetState, RegisterReportsScreen, _RegisterReportsScreenState, _action, _body (+63 more)

### Community 14 - "Community 14"
Cohesion: 0.04
Nodes (62): deductForOrder(), deductOne(), { query }, { BadRequest, Conflict }, create(), list(), { query }, serialize() (+54 more)

### Community 15 - "Community 15"
Cohesion: 0.03
Nodes (64): accountingExport, actionCenter, aggregator, aggregatorLink, asyncHandler, auditSvc, customerHistory, dailyClosing (+56 more)

### Community 16 - "Community 16"
Cohesion: 0.06
Nodes (61): create(), disable(), getByCode(), getById(), list(), listRedemptions(), markRedeemed(), { NotFound, BadRequest, Conflict } (+53 more)

### Community 17 - "Community 17"
Cohesion: 0.04
Nodes (56): _adminActive(), _adminActiveCache, _currentRole(), _decode(), requireAuth(), requireBusinessOwnership(), requireRole(), requireSuperAdmin() (+48 more)

### Community 18 - "Community 18"
Cohesion: 0.04
Nodes (59): customer_detail_screen.dart, List, ../../models/customer.dart, _businessId, _error, _floors, load, _loading (+51 more)

### Community 19 - "Community 19"
Cohesion: 0.04
Nodes (54): Color, ../config/app_config.dart, ../constants/colors.dart, IconData, build, SplashScreen, AddonLocked, build (+46 more)

### Community 20 - "Community 20"
Cohesion: 0.04
Nodes (56): billing_screen.dart, TrialExpiredScreen, build, _confirmDeactivate, CouponsScreen, _CouponsScreenState, createState, _error (+48 more)

### Community 21 - "Community 21"
Cohesion: 0.05
Nodes (47): baseURL, guest, guestApi, GuestMenu, DashboardPage, GuestMenuPage, ReportsPage, BillSplitDialog() (+39 more)

### Community 22 - "Community 22"
Cohesion: 0.03
Nodes (60): _addFloor, _addTable, autoX, autoY, _bizId, build, _canvasHeight, _canvasMode (+52 more)

### Community 23 - "Community 23"
Cohesion: 0.04
Nodes (57): _appliedCoupon, _applyingCoupon, _applyWallet, _balance, billInr, _boundTableId, _coupon, _couponDiscount (+49 more)

### Community 24 - "Community 24"
Cohesion: 0.04
Nodes (55): GoogleSignIn get, _api, AuthService, bumpMpinFails, cachedBusiness, cachedPermissions, cachedPlan, cachedRole (+47 more)

### Community 25 - "Community 25"
Cohesion: 0.04
Nodes (52): ../home/home_screen.dart, build, _category, _city, _continue, createState, dispose, _form (+44 more)

### Community 26 - "Community 26"
Cohesion: 0.04
Nodes (50): dart:typed_data, build, _buildPdf, createState, _error, _guestUrl, initState, _load (+42 more)

### Community 27 - "Community 27"
Cohesion: 0.04
Nodes (51): businessId, cancelReason, cgst, collectedAt, copyWith, createdAt, customerName, customerPhone (+43 more)

### Community 28 - "Community 28"
Cohesion: 0.05
Nodes (49): devDependencies, autoprefixer, eslint-plugin-react-hooks, eslint-plugin-react-refresh, postcss, @reticlehq/react, @reticlehq/vite-plugin, tailwindcss (+41 more)

### Community 29 - "Community 29"
Cohesion: 0.05
Nodes (43): getClient(), anomaly, autoRestock86(), bankReconcile, drainOutboundWaMessages(), drainScheduledMessages(), dueRecurringInvoices(), forecast (+35 more)

### Community 30 - "Community 30"
Cohesion: 0.04
Nodes (48): _allGroups, _attachedGroupIds, _availabilityChip, _category, _costPrice, createState, _description, _displayOrder (+40 more)

### Community 31 - "Community 31"
Cohesion: 0.06
Nodes (45): aggregators_screen.dart, business_info_screen.dart, ../customers/customers_screen.dart, ../expenses/expenses_screen.dart, ../menu/menu_editor_screen.dart, Order, OrderStatus, OrdersProvider (+37 more)

### Community 32 - "Community 32"
Cohesion: 0.04
Nodes (45): compilerOptions, allowImportingTsExtensions, baseUrl, isolatedModules, jsx, lib, module, moduleResolution (+37 more)

### Community 33 - "Community 33"
Cohesion: 0.05
Nodes (44): addonRoutes, adminRoutes, aggregatorWebhookRoutes, authRoutes, billingController, billingRoutes, buildApp(), complianceRoutes (+36 more)

### Community 34 - "Community 34"
Cohesion: 0.04
Nodes (43): adminGetRetention, adminGetSettings, adminListBreaches, adminListDSRs, adminListGrievances, adminLogBreach, adminLogBreachSchema, adminPreviewRetention (+35 more)

### Community 35 - "Community 35"
Cohesion: 0.05
Nodes (41): ../captain/captain_screen.dart, ../expenses/add_expense_screen.dart, income_statement_screen.dart, ../models/business.dart, ../models/expense.dart, ../models/order.dart, monthly_report.dart, _emptyState (+33 more)

### Community 36 - "Community 36"
Cohesion: 0.06
Nodes (39): devFmt, env, logger, winston, checkAfterHours(), checkStockOut(), checkVoidSpike(), logger (+31 more)

### Community 37 - "Community 37"
Cohesion: 0.08
Nodes (41): cancel(), confirmPayment(), createAddon(), detach(), env, forceActivate(), getById(), getBySlug() (+33 more)

### Community 38 - "Community 38"
Cohesion: 0.05
Nodes (42): AuthStatus get, Business? get, ../models/plan_info.dart, AuthStatus, _bootstrap, bumpMpinFails, _business, canDo (+34 more)

### Community 39 - "Community 39"
Cohesion: 0.05
Nodes (40): _advance, _bootstrap, build, businessId, createState, dispose, initState, KdsScreen (+32 more)

### Community 40 - "Community 40"
Cohesion: 0.07
Nodes (33): ActionCenterPage, CaptainPage, OrdersPage, Props, STATUS_COLORS, TableRow, CartLine, customerWalletApi() (+25 more)

### Community 41 - "Community 41"
Cohesion: 0.05
Nodes (35): adjustBody, asyncHandler, customers, Joi, listQuery, loyalty, updateBody, upsertBody (+27 more)

### Community 42 - "Community 42"
Cohesion: 0.09
Nodes (24): Bluetooth, BluetoothCharacteristicProperties, BluetoothDevice, BluetoothRemoteGATTCharacteristic, BluetoothRemoteGATTServer, BluetoothRemoteGATTService, BtPrinter, buildReceiptLines() (+16 more)

### Community 43 - "Community 43"
Cohesion: 0.05
Nodes (39): _abandonSession, _autoGrid, build, businessId, CaptainScreen, _CaptainScreenState, clearPendingCaptainSession, createState (+31 more)

### Community 44 - "Community 44"
Cohesion: 0.05
Nodes (37): abandonSession, asyncHandler, closeSession, createFloor, createStation, createTable, deleteFloor, deleteStation (+29 more)

### Community 45 - "Community 45"
Cohesion: 0.10
Nodes (33): apiError(), formatDate(), formatINR(), AddonCard(), AddonDialog(), AdminTeamPage(), CreateAdminDialog(), BroadcastPage() (+25 more)

### Community 46 - "Community 46"
Cohesion: 0.08
Nodes (35): isAuthed(), RequireAuth(), formatDateTime(), AddonsPage(), AuditPage(), BREACH_STATUS, BreachDialog(), BreachTab() (+27 more)

### Community 47 - "Community 47"
Cohesion: 0.11
Nodes (24): Button, ButtonProps, buttonVariants, Card, CardContent, CardDescription, CardFooter, CardHeader (+16 more)

### Community 48 - "Community 48"
Cohesion: 0.05
Nodes (36): appName, AppStrings, cancelled, card, cash, collected, confirmOrder, dashboard (+28 more)

### Community 49 - "Community 49"
Cohesion: 0.11
Nodes (8): ADMIN, loginAsSuperAdmin(), adminAuthFile, ownerAuthFile, apiAs(), ENV, getBusinessId(), loginAsOwner()

### Community 50 - "Community 50"
Cohesion: 0.06
Nodes (35): _body, build, _busy, _categories, _category, _city, createState, dispose (+27 more)

### Community 51 - "Community 51"
Cohesion: 0.06
Nodes (34): build, createState, dispose, _emptyState, _error, _errorState, fromJson, group (+26 more)

### Community 52 - "Community 52"
Cohesion: 0.06
Nodes (32): colors.dart, accent, AppColors, background, border, card, chartPalette, darkBackground (+24 more)

### Community 53 - "Community 53"
Cohesion: 0.06
Nodes (34): date-fns, lucide-react, @radix-ui/react-separator, react-dom, react-router-dom, tailwind-merge, @tanstack/react-query, date-fns (+26 more)

### Community 54 - "Community 54"
Cohesion: 0.21
Nodes (22): Badge(), BadgeProps, badgeVariants, Dialog, DialogContent, DialogDescription, DialogFooter(), DialogHeader() (+14 more)

### Community 55 - "Community 55"
Cohesion: 0.06
Nodes (32): build, _code, _codeSent, createState, dispose, OtpScreen, _OtpScreenState, _phone (+24 more)

### Community 56 - "Community 56"
Cohesion: 0.06
Nodes (33): _allKeys, build, _confirmAndAutoPrune, _confirmRemove, createState, _defaultsByRole, _defaultsFor, dispose (+25 more)

### Community 57 - "Community 57"
Cohesion: 0.06
Nodes (32): address, _buildReceipt, connect, disconnect, _ensureConnected, fromBluetoothInfo, hasSelectedPrinter, instance (+24 more)

### Community 58 - "Community 58"
Cohesion: 0.07
Nodes (31): _Mode, _amount, amountInr, createState, _details, dispose, _effectiveAmount, _fetchById (+23 more)

### Community 59 - "Community 59"
Cohesion: 0.08
Nodes (28): Addon, Admin, AuditEvent, Breach, ComplianceSettings, Coupon, Customer, Dsr (+20 more)

### Community 60 - "Community 60"
Cohesion: 0.06
Nodes (31): _back, build, businessId, _choose, createState, dispose, _error, _errorState (+23 more)

### Community 61 - "Community 61"
Cohesion: 0.07
Nodes (31): build, createState, _endDate, _error, fmt, _fmtDate, initState, _inv (+23 more)

### Community 62 - "Community 62"
Cohesion: 0.06
Nodes (31): bcrypt, bcryptjs, compression, cookie-parser, cors, exceljs, express-rate-limit, joi (+23 more)

### Community 63 - "Community 63"
Cohesion: 0.06
Nodes (31): dependencies, axios, clsx, @radix-ui/react-avatar, @radix-ui/react-dialog, @radix-ui/react-label, @radix-ui/react-select, @radix-ui/react-tabs (+23 more)

### Community 64 - "Community 64"
Cohesion: 0.07
Nodes (30): AggregatorsScreen, _AggregatorsScreenState, _apiKey, build, _busy, _code, color, createState (+22 more)

### Community 65 - "Community 65"
Cohesion: 0.07
Nodes (23): env, c, env, express, rateLimit, NOTE: /request-otp and /verify-otp are placeholders for a future, { requireAuth }, router (+15 more)

### Community 66 - "Community 66"
Cohesion: 0.07
Nodes (28): addons, adminActivationsForCustomer, adminAttachToCustomer, adminCreate, adminCreateBody, adminDetachFromCustomer, adminList, adminSyncRazorpay (+20 more)

### Community 67 - "Community 67"
Cohesion: 0.07
Nodes (26): asyncHandler, { BadRequest }, benefitCheck, benefitVerify, confirmPayment, confirmSessionPayment, crypto, env (+18 more)

### Community 68 - "Community 68"
Cohesion: 0.07
Nodes (29): adjust, byId, cacheAll, categories, create, delete, ExpenseRepo, history (+21 more)

### Community 69 - "Community 69"
Cohesion: 0.07
Nodes (28): Customer, _addMembership, build, _cancelBusy, _cancelMembership, _createMembershipPlan, createState, customer (+20 more)

### Community 70 - "Community 70"
Cohesion: 0.07
Nodes (23): asyncHandler, cancelBody, exporters, issueBody, Joi, listQuery, svc, validate (+15 more)

### Community 71 - "Community 71"
Cohesion: 0.15
Nodes (21): _csvEscape(), _csvLine(), ExcelJS, _letterheadLines(), _money(), PDFDocument, _pdfFooter(), _pdfHeader() (+13 more)

### Community 72 - "Community 72"
Cohesion: 0.07
Nodes (28): businessId, category, copyWith, costPrice, createdAt, description, fromBackend, fromMap (+20 more)

### Community 73 - "Community 73"
Cohesion: 0.07
Nodes (27): database_service.dart, Dio, activePendingCount, _api, _connSub, _db, deadLetterCount, deadLetters (+19 more)

### Community 74 - "Community 74"
Cohesion: 0.08
Nodes (23): can(), { Forbidden }, _liveRole(), PERMISSIONS, { query }, requirePermission(), _roleCache, addonController (+15 more)

### Community 75 - "Community 75"
Cohesion: 0.10
Nodes (27): acceptInvite(), bcrypt, createStaffWithPin(), crypto, DEFAULT_PERMS_BY_ROLE, featuresSvc, hashToken(), invite() (+19 more)

### Community 76 - "Community 76"
Cohesion: 0.19
Nodes (16): adminApi, getAdminToken(), Table, TableBody, TableCell, TableHead, TableHeader, TableRow (+8 more)

### Community 77 - "Community 77"
Cohesion: 0.10
Nodes (24): { BadRequest }, bcrypt, changePassword(), createBusinessForUser(), env, findOrCreateUser(), getBusinessById(), getMembership() (+16 more)

### Community 78 - "Community 78"
Cohesion: 0.07
Nodes (26): addToCart, _businessId, _cart, cartItemCount, cartSubtotal, clearCart, createOrderFromCart, decrementCart (+18 more)

### Community 79 - "Community 79"
Cohesion: 0.08
Nodes (25): asyncHandler, auth, changePassword, changePasswordSchema, COOKIE_CLEAR_OPTS, COOKIE_OPTS, devLoginSchema, google (+17 more)

### Community 80 - "Community 80"
Cohesion: 0.09
Nodes (22): ALLOWED_MIME, asyncHandler, diskStorage, express, fs, MIME_EXT, multer, path (+14 more)

### Community 81 - "Community 81"
Cohesion: 0.08
Nodes (25): DailyReport, date, dineInRevenue, fuelExpense, ingredientsExpense, itemId, laborExpense, marginPct (+17 more)

### Community 82 - "Community 82"
Cohesion: 0.10
Nodes (23): add_expense_screen.dart, FormState, Expense, ExpensesProvider, AddExpenseScreen, _AddExpenseScreenState, _amount, build (+15 more)

### Community 83 - "Community 83"
Cohesion: 0.10
Nodes (22): asyncHandler, changeBody, features, Joi, { query }, razorpay, sub, subInvoice (+14 more)

### Community 84 - "Community 84"
Cohesion: 0.15
Nodes (22): BillingPage, InvoicesPage, escapeHtml(), formatIstDateTime(), money(), printReceipt(), ReceiptLine, ReceiptTotals (+14 more)

### Community 85 - "Community 85"
Cohesion: 0.08
Nodes (24): AddonActivation, cancelAtPeriodEnd, category, currentPeriodEnd, features, fromActive, fromMap, icon (+16 more)

### Community 86 - "Community 86"
Cohesion: 0.08
Nodes (24): _bluetoothOn, _bootstrap, build, _connect, _connectedCard, createState, _disconnect, _emptyPaired (+16 more)

### Community 87 - "Community 87"
Cohesion: 0.08
Nodes (23): env, es2022, jest, node, extends, parserOptions, ecmaVersion, sourceType (+15 more)

### Community 88 - "Community 88"
Cohesion: 0.11
Nodes (19): MenuPage, StaffPage, PlanState, STARTER_DEFAULT, usePlan(), fullImageUrl(), EditDialog(), ItemCard() (+11 more)

### Community 89 - "Community 89"
Cohesion: 0.09
Nodes (22): dart:convert, _bar, _bootstrap, build, child, ConnectivityBanner, _ConnectivityBannerState, createState (+14 more)

### Community 90 - "Community 90"
Cohesion: 0.11
Nodes (17): env, logger, PROVIDERS, { query }, syncItemAvailability(), getItemModifierGroups(), listGroups(), listVariants() (+9 more)

### Community 91 - "Community 91"
Cohesion: 0.09
Nodes (22): BillSplitScreen, _BillSplitScreenState, build, businessId, _busy, _configBody, createState, _customSum (+14 more)

### Community 92 - "Community 92"
Cohesion: 0.10
Nodes (21): CartItem, confirm_order_screen.dart, item_config_sheet.dart, ../models/cart_item.dart, build, _CartLineRow, _CartPanel, _CartPanelState (+13 more)

### Community 93 - "Community 93"
Cohesion: 0.10
Nodes (21): _agreePolicy, build, _businessName, _confirm, createState, dispose, _email, _googleSignUp (+13 more)

### Community 94 - "Community 94"
Cohesion: 0.11
Nodes (16): c, express, optionalAuth(), router, { verifyAccessToken }, crypto, env, jwt (+8 more)

### Community 95 - "Community 95"
Cohesion: 0.10
Nodes (20): build, createState, _groupBlock, _groups, initState, item, ItemConfigSheet, _ItemConfigSheetState (+12 more)

### Community 96 - "Community 96"
Cohesion: 0.10
Nodes (19): @pragma, api_service.dart, FlutterLocalNotificationsPlugin, _fcmBackgroundHandler, init, initPush, instance, lowStock (+11 more)

### Community 97 - "Community 97"
Cohesion: 0.10
Nodes (19): int get, _autoWhatsAppOnReady, _load, _notifyOnLowStock, _notifyOnNewOrder, _paperWidthMm, _printerAddress, _printerEnabled (+11 more)

### Community 98 - "Community 98"
Cohesion: 0.13
Nodes (17): crypto, getCredentials(), listCredentials(), listMappingIssues(), logger, _normaliseSwiggy(), _normaliseZomato(), orderService (+9 more)

### Community 99 - "Community 99"
Cohesion: 0.12
Nodes (14): buildApp, request, { resetDb, closePool }, buildApp, request, { resetDb, closePool }, buildApp, request (+6 more)

### Community 100 - "Community 100"
Cohesion: 0.10
Nodes (19): Customer, earnRatePaise, email, fromMap, id, isActive, lifetimePoints, LoyaltySettingsLite (+11 more)

### Community 101 - "Community 101"
Cohesion: 0.11
Nodes (19): build, createState, entityAddress, entityName, _h, initState, kind, _li (+11 more)

### Community 102 - "Community 102"
Cohesion: 0.11
Nodes (18): dart:async, bootstrap, capture, _framework, install, _reBearer, _reEmail, _reJwt (+10 more)

### Community 103 - "Community 103"
Cohesion: 0.11
Nodes (18): double?, menu_item.dart, CartItem, groupId, groupLabel, item, lineTotal, ModifierLine (+10 more)

### Community 104 - "Community 104"
Cohesion: 0.11
Nodes (19): eslint-config-airbnb-base, eslint-plugin-import, eslint-plugin-jest, jest, eslint, eslint, devDependencies, eslint (+11 more)

### Community 105 - "Community 105"
Cohesion: 0.11
Nodes (19): scripts, audit:idor, dev, docker:down, docker:logs, docker:up, lint, lint:fix (+11 more)

### Community 106 - "Community 106"
Cohesion: 0.15
Nodes (17): me, cache, clearAllCaches(), clearCache(), env, featuresFor(), hasFeature(), listFeatureCatalog() (+9 more)

### Community 107 - "Community 107"
Cohesion: 0.14
Nodes (16): asyncHandler, auth, createBody, { formatToken }, Joi, listQuery, order, orderItem (+8 more)

### Community 108 - "Community 108"
Cohesion: 0.11
Nodes (18): asyncHandler, bankRecon, billSplit, express, foodCoupons, forecast, fx, Joi (+10 more)

### Community 109 - "Community 109"
Cohesion: 0.20
Nodes (18): _appendInbound(), createCampaign(), _drive(), env, handleInbound(), isMetaConfigured(), isProviderConfigured(), isTwilioConfigured() (+10 more)

### Community 110 - "Community 110"
Cohesion: 0.12
Nodes (17): BulkImportPage, MenuCsvImportDialog(), parseCsv(), BulkImportPage(), CsvRow, downloadCsv(), EXPENSE_MAP, IMPORT_TYPES (+9 more)

### Community 111 - "Community 111"
Cohesion: 0.11
Nodes (18): address, bankAccount, bankIfsc, Business, category, city, copyWith, createdAt (+10 more)

### Community 112 - "Community 112"
Cohesion: 0.11
Nodes (18): build, _busy, _cash, createState, DailyClosingScreen, _DailyClosingScreenState, dispose, initState (+10 more)

### Community 113 - "Community 113"
Cohesion: 0.11
Nodes (17): connectivity_plus, file_selector_macos, firebase_core, firebase_messaging, flutter_local_notifications, flutter_secure_storage_darwin, Foundation, geolocator_apple (+9 more)

### Community 114 - "Community 114"
Cohesion: 0.12
Nodes (17): int?, body, build, createState, FeatureTour, _FeatureTourState, _finish, _go (+9 more)

### Community 115 - "Community 115"
Cohesion: 0.11
Nodes (16): ../models/subscription.dart, Subscription, _addons, clear, _error, hasAddon, isPaused, isTrialing (+8 more)

### Community 116 - "Community 116"
Cohesion: 0.11
Nodes (17): @playwright/test, @types/node, @playwright/test, @types/node, devDependencies, @playwright/test, @types/node, @playwright/test (+9 more)

### Community 117 - "Community 117"
Cohesion: 0.18
Nodes (17): complyStaffLimit(), cancelAtPeriodEnd(), changePlan(), computeProrationPaise(), createPlan(), deletePlan(), enforceLimit(), { Forbidden, NotFound } (+9 more)

### Community 118 - "Community 118"
Cohesion: 0.11
Nodes (17): AppFmt, _date, dateShort, _dateTime, inr2, isISTToday, _ist, _money (+9 more)

### Community 119 - "Community 119"
Cohesion: 0.12
Nodes (16): constants/theme.dart, build, createState, _decide, initState, NamastePOSApp, _OnboardingGate, _OnboardingGateState (+8 more)

### Community 120 - "Community 120"
Cohesion: 0.12
Nodes (14): dart:io, _forStatus, humanizeError, _lowLevelFallback, null, s, main, main (+6 more)

### Community 121 - "Community 121"
Cohesion: 0.12
Nodes (17): global, branches, functions, lines, statements, jest, collectCoverageFrom, coverageThreshold (+9 more)

### Community 122 - "Community 122"
Cohesion: 0.13
Nodes (15): _dailySeries(), EXPENSE_CATEGORIES, EXPENSE_LABELS, incomeStatement(), { query }, REVENUE_SOURCE_LABELS, balanceSheet(), DEFAULT_COA (+7 more)

### Community 123 - "Community 123"
Cohesion: 0.15
Nodes (16): crypto, ensureGuestSession(), _ensureQrColumns(), env, getSettings(), guestMenu(), guestOrderStatus(), issueTokenForTable() (+8 more)

### Community 124 - "Community 124"
Cohesion: 0.13
Nodes (12): BIZ_GETS, buildApp, request, { resetDb, makeBusiness, tokenFor, closePool }, buildApp, request, { resetDb, makeBusiness, tokenFor, closePool }, buildApp (+4 more)

### Community 125 - "Community 125"
Cohesion: 0.12
Nodes (15): Database?, clearAll, DatabaseService, _db, _dbName, _dbVersion, init, instance (+7 more)

### Community 126 - "Community 126"
Cohesion: 0.12
Nodes (15): DateTime, balanceAfter, businessId, createdAt, fromMap, id, InventoryReason, inventoryReasonFromString (+7 more)

### Community 127 - "Community 127"
Cohesion: 0.14
Nodes (12): appliedSet(), ensureMigrationsTable(), fs, logger, path, { pool, query, withTransaction }, run(), bcrypt (+4 more)

### Community 128 - "Community 128"
Cohesion: 0.12
Nodes (14): acceptBody, ALL_STAFF_ROLES, asyncHandler, createPinBody, inviteBody, Joi, staff, updatePinBody (+6 more)

### Community 129 - "Community 129"
Cohesion: 0.14
Nodes (14): impersonate(), issueAccessToken(), adminTokenFor(), buildApp, { issueAccessToken }, request, { resetDb, makeBusiness, tokenFor, closePool }, adminToken() (+6 more)

### Community 130 - "Community 130"
Cohesion: 0.13
Nodes (15): amount, businessId, category, createdAt, date, description, ExpenseCategory, expenseCategoryFromString (+7 more)

### Community 131 - "Community 131"
Cohesion: 0.13
Nodes (14): app.dart, flag, main, _migrateKeychainScheme, _restoreLocaleOverride, runGuarded, storage, package:flutter_secure_storage/flutter_secure_storage.dart (+6 more)

### Community 132 - "Community 132"
Cohesion: 0.13
Nodes (14): E? get, Iterable, ../models/menu_item.dart, available, _FirstOrNull, init, instance, listen (+6 more)

### Community 133 - "Community 133"
Cohesion: 0.18
Nodes (12): awardWelcomeBonus(), earn(), getSettings(), listTransactions(), manualAdjust(), { NotFound, BadRequest }, pointsEarnedFor(), { query, withTransaction } (+4 more)

### Community 134 - "Community 134"
Cohesion: 0.21
Nodes (12): dispatchStage(), email, env, logger, { query }, runScheduler(), sendWelcome(), startScheduler() (+4 more)

### Community 135 - "Community 135"
Cohesion: 0.14
Nodes (14): _activate, _activeSlugs, _addonCard, build, _busySlug, _cancel, _catalog, createState (+6 more)

### Community 136 - "Community 136"
Cohesion: 0.14
Nodes (14): build, createState, _end, _error, initState, _load, _loading, _num (+6 more)

### Community 137 - "Community 137"
Cohesion: 0.14
Nodes (13): CustomPainter, _GooglePainter, _GridPainter, _blue, build, GoogleLogo, _GooglePainter, _green (+5 more)

### Community 138 - "Community 138"
Cohesion: 0.20
Nodes (13): createStation(), deleteStation(), generateTickets(), listStations(), listTickets(), markPrinted(), nextTicketNo(), { NotFound, Conflict, BadRequest } (+5 more)

### Community 139 - "Community 139"
Cohesion: 0.23
Nodes (13): _days(), getConfig(), KEYS, logger, preview(), _pruneAuditLog(), _pruneCookieConsents(), _purgeDeletedBusinesses() (+5 more)

### Community 140 - "Community 140"
Cohesion: 0.14
Nodes (13): _businessId, byId, _error, _items, load, _loading, lowStockItems, refresh (+5 more)

### Community 141 - "Community 141"
Cohesion: 0.15
Nodes (12): dart:ui, containsKey, currentLocale, device, _dict, loadLocaleOverride, loc, _override (+4 more)

### Community 142 - "Community 142"
Cohesion: 0.15
Nodes (11): assertOwnsBusiness(), asyncHandler, express, { Forbidden }, Joi, multiOutlet, { query }, { requireAuth } (+3 more)

### Community 143 - "Community 143"
Cohesion: 0.17
Nodes (12): { BadRequest }, crypto, env, generateEwayBill(), generateIrn(), listExports(), listIrns(), logger (+4 more)

### Community 144 - "Community 144"
Cohesion: 0.26
Nodes (12): completeTask(), computeHealth(), createTask(), ensureUpsellTask(), listActivities(), listTasks(), logActivity(), { query } (+4 more)

### Community 145 - "Community 145"
Cohesion: 0.29
Nodes (12): byId(), byPhone(), linkToOrder(), list(), normalizePhone(), { NotFound, Conflict, BadRequest }, { query }, recentOrders() (+4 more)

### Community 146 - "Community 146"
Cohesion: 0.26
Nodes (12): adjustStock(), byId(), create(), list(), { NotFound, Conflict, BadRequest }, { query, withTransaction }, recordPurchase(), serialize() (+4 more)

### Community 147 - "Community 147"
Cohesion: 0.21
Nodes (12): env, extractPlaceIdFromUrl(), fetchAllProviders(), https, ingestReview(), listReviews(), logger, _placeIdFromNameAndCoords() (+4 more)

### Community 148 - "Community 148"
Cohesion: 0.17
Nodes (11): bool get, double get, add, _businessId, delete, _expenses, load, _loading (+3 more)

### Community 149 - "Community 149"
Cohesion: 0.26
Nodes (8): App(), beforeSend(), initSentry(), MinimalSentry, scrubString(), scrubTree(), SENSITIVE_KEYS, queryClient

### Community 150 - "Community 150"
Cohesion: 0.24
Nodes (8): beforeSend(), env, init(), installRequestHandler(), scrubString(), scrubTree(), SENSITIVE_KEYS, sentry

### Community 151 - "Community 151"
Cohesion: 0.17
Nodes (10): asyncHandler, createBody, expense, Joi, listQuery, validate, c, express (+2 more)

### Community 152 - "Community 152"
Cohesion: 0.17
Nodes (11): asyncHandler, bulkImportBody, comboLine, itemBody, Joi, listQuery, menu, stockBody (+3 more)

### Community 153 - "Community 153"
Cohesion: 0.27
Nodes (11): addMessage(), createTicket(), getTicket(), listTickets(), { NotFound, BadRequest }, PRIORITIES, { query }, serializeMessage() (+3 more)

### Community 154 - "Community 154"
Cohesion: 0.18
Nodes (8): axios, fs, http, net, path, pollOnce(), transports, wrapText()

### Community 155 - "Community 155"
Cohesion: 0.18
Nodes (5): errorRate, options, readTime, scenarios, totalWeight

### Community 156 - "Community 156"
Cohesion: 0.18
Nodes (10): name, private, scripts, build, dev, lint, preview, test:e2e (+2 more)

### Community 157 - "Community 157"
Cohesion: 0.18
Nodes (10): adjustBody, asyncHandler, ingredientBody, ingredientPatch, ingredients, Joi, purchaseBody, recipes (+2 more)

### Community 158 - "Community 158"
Cohesion: 0.24
Nodes (7): csvEscape(), gstr1Csv(), gstrSummary(), paiseToInr(), { query }, rowsToCsv(), settings

### Community 159 - "Community 159"
Cohesion: 0.27
Nodes (9): computeTax(), fmtDate(), inr(), loadInvoice(), { NotFound }, PDFDocument, { query }, renderPdf() (+1 more)

### Community 160 - "Community 160"
Cohesion: 0.18
Nodes (7): buildApp, request, { resetDb, makeBusiness, tokenFor, closePool }, fs, { issueAccessToken }, path, { pool, query }

### Community 161 - "Community 161"
Cohesion: 0.18
Nodes (9): adminRbac, adminTeam, menuService, { query }, reservationService, { resetDb, makeBusiness, closePool }, tableService, taxInvoiceService (+1 more)

### Community 162 - "Community 162"
Cohesion: 0.18
Nodes (10): name, private, scripts, build, dev, lint, preview, test:e2e (+2 more)

### Community 163 - "Community 163"
Cohesion: 0.29
Nodes (7): beforeSend(), initSentry(), MinimalSentry, scrubString(), scrubTree(), SENSITIVE_KEYS, queryClient

### Community 164 - "Community 164"
Cohesion: 0.20
Nodes (8): app, buildApp, cronWorker, env, logger, onboardingEmail, { pool }, server

### Community 165 - "Community 165"
Cohesion: 0.31
Nodes (9): ensureTransporter(), env, _isConnError(), logger, _parseAddr(), { query }, _resetTransporter(), sendMail() (+1 more)

### Community 166 - "Community 166"
Cohesion: 0.27
Nodes (9): dailyTick(), _dayStats(), email, env, logger, { query }, rupee(), wa (+1 more)

### Community 167 - "Community 167"
Cohesion: 0.25
Nodes (7): asyncHandler, esc(), express, { query }, router, safeUrl(), site

### Community 168 - "Community 168"
Cohesion: 0.25
Nodes (8): { BadRequest, NotFound }, completeLinkFromWebhook(), listSessions(), otp, { query }, startLink(), SUPPORTED_PROVIDERS, verifyLink()

### Community 169 - "Community 169"
Cohesion: 0.22
Nodes (7): legs(), menuService, orderService, { query }, { resetDb, makeBusiness, closePool }, seedMember(), walletBal()

### Community 170 - "Community 170"
Cohesion: 0.22
Nodes (6): buildApp, crypto, env, request, { resetDb, makeBusiness, closePool }, whatsapp

### Community 171 - "Community 171"
Cohesion: 0.28
Nodes (7): SupportPage, fmt(), Message, STATUS_COLOR, SupportPage(), Ticket, TicketThread()

### Community 172 - "Community 172"
Cohesion: 0.39
Nodes (8): friendlyError(), PrivacyPage(), onErase(), onExport(), onFileCorrection(), onFileGrievance(), reload(), toggleConsent()

### Community 173 - "Community 173"
Cohesion: 0.22
Nodes (8): features, fromMap, has, PlanInfo, starterDefault, tierKind, toMap, Set

### Community 174 - "Community 174"
Cohesion: 0.22
Nodes (8): description, main, name, private, scripts, dev, start, version

### Community 175 - "Community 175"
Cohesion: 0.25
Nodes (6): Any, FlutterImplicitEngineBridge, FlutterImplicitEngineDelegate, AppDelegate, Bool, UIApplication

### Community 176 - "Community 176"
Cohesion: 0.32
Nodes (5): Cocoa, FlutterMacOS, MainFlutterWindow, NSWindow, XCTest

### Community 177 - "Community 177"
Cohesion: 0.36
Nodes (7): email, _emailBody(), logger, _lookup(), onPaymentFailed(), onRecovered(), { query }

### Community 178 - "Community 178"
Cohesion: 0.50
Nodes (7): dailyReport(), getCache(), isToday(), istToday(), monthlyReport(), { query }, setCache()

### Community 179 - "Community 179"
Cohesion: 0.25
Nodes (6): makeCoupon(), menuService, orderService, { query }, redemptionCount(), { resetDb, makeBusiness, closePool }

### Community 180 - "Community 180"
Cohesion: 0.25
Nodes (7): bcrypt, qrService, { query }, request, { resetDb, makeBusiness, closePool }, seedOtp(), tableService

### Community 181 - "Community 181"
Cohesion: 0.25
Nodes (7): ingredientService, menuService, orderService, { query }, razorpayService, recipeService, { resetDb, makeBusiness, closePool }

### Community 182 - "Community 182"
Cohesion: 0.38
Nodes (4): Flutter, FlutterSceneDelegate, SceneDelegate, UIKit

### Community 183 - "Community 183"
Cohesion: 0.29
Nodes (6): description, engines, node, main, name, version

### Community 184 - "Community 184"
Cohesion: 0.33
Nodes (7): _applyRefreshCookie(), devLogin, googleLogin, passwordLogin, pinLogin, register, _sessionPayload()

### Community 185 - "Community 185"
Cohesion: 0.29
Nodes (5): buildApp, month, request, { resetDb, makeBusiness, tokenFor, closePool }, today

### Community 186 - "Community 186"
Cohesion: 0.29
Nodes (6): buildApp, fs, path, request, { resetDb, makeBusiness, tokenFor, closePool }, TINY_PNG

### Community 187 - "Community 187"
Cohesion: 0.33
Nodes (5): Bundle, BUNDLES, getLocale(), LANGS, t()

### Community 188 - "Community 188"
Cohesion: 0.29
Nodes (6): AppConfig, hasSupportWhatsApp, supportWhatsApp, webAppUrl, static bool get, static const String

### Community 189 - "Community 189"
Cohesion: 0.47
Nodes (4): FlutterAppDelegate, AppDelegate, Bool, NSApplication

### Community 190 - "Community 190"
Cohesion: 0.33
Nodes (5): home_bottom_nav.dart, build, HomeDrawerButton, _open, screens/home/home_screen.dart

### Community 191 - "Community 191"
Cohesion: 0.33
Nodes (6): dotenv, dotenv, dependencies, axios, dotenv, axios

### Community 192 - "Community 192"
Cohesion: 0.40
Nodes (5): devLogin(), http, request(), ROUTES, url

### Community 193 - "Community 193"
Cohesion: 0.40
Nodes (5): crypto, { Forbidden }, generate(), issue(), verify()

### Community 194 - "Community 194"
Cohesion: 0.33
Nodes (5): client, env, { OAuth2Client }, { Unauthorized }, verifyIdToken()

### Community 195 - "Community 195"
Cohesion: 0.33
Nodes (3): buildApp, request, { resetDb, makeBusiness, tokenFor, closePool }

### Community 196 - "Community 196"
Cohesion: 0.33
Nodes (3): { query }, request, { resetDb, makeBusiness, tokenFor, closePool }

### Community 197 - "Community 197"
Cohesion: 0.33
Nodes (3): buildApp, request, { resetDb, makeBusiness, tokenFor, closePool }

### Community 198 - "Community 198"
Cohesion: 0.33
Nodes (3): buildApp, request, { resetDb, makeBusiness, tokenFor, closePool }

### Community 199 - "Community 199"
Cohesion: 0.33
Nodes (5): nonNegativeNumber, phone, positiveNumber, required, Validators

### Community 200 - "Community 200"
Cohesion: 0.40
Nodes (4): API_KEY, npx, TestSprite, @testsprite/testsprite-mcp

### Community 201 - "Community 201"
Cohesion: 0.40
Nodes (3): RunnerTests, RunnerTests, XCTestCase

### Community 203 - "Community 203"
Cohesion: 0.50
Nodes (3): dupes, options, seen

### Community 204 - "Community 204"
Cohesion: 0.83
Nodes (3): fetch(), ping(), scheduled()

### Community 207 - "Community 207"
Cohesion: 0.67
Nodes (3): class-variance-authority, class-variance-authority, class-variance-authority

### Community 208 - "Community 208"
Cohesion: 0.67
Nodes (3): @radix-ui/react-dropdown-menu, @radix-ui/react-dropdown-menu, @radix-ui/react-dropdown-menu

### Community 209 - "Community 209"
Cohesion: 0.67
Nodes (3): @radix-ui/react-slot, @radix-ui/react-slot, @radix-ui/react-slot

### Community 210 - "Community 210"
Cohesion: 0.67
Nodes (3): @radix-ui/react-toast, @radix-ui/react-toast, @radix-ui/react-toast

## Knowledge Gaps
- **3191 isolated node(s):** `Props`, `Pair`, `Props`, `ButtonProps`, `Article` (+3186 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 3556 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **26 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `query()` connect `Community 0` to `Community 129`, `Community 2`, `Community 3`, `Community 133`, `Community 134`, `Community 10`, `Community 138`, `Community 139`, `Community 142`, `Community 143`, `Community 14`, `Community 17`, `Community 16`, `Community 144`, `Community 145`, `Community 15`, `Community 146`, `Community 147`, `Community 153`, `Community 29`, `Community 158`, `Community 159`, `Community 160`, `Community 33`, `Community 161`, `Community 36`, `Community 37`, `Community 165`, `Community 167`, `Community 168`, `Community 166`, `Community 169`, `Community 177`, `Community 178`, `Community 179`, `Community 180`, `Community 181`, `Community 184`, `Community 65`, `Community 67`, `Community 196`, `Community 70`, `Community 74`, `Community 75`, `Community 77`, `Community 83`, `Community 90`, `Community 98`, `Community 99`, `Community 106`, `Community 108`, `Community 109`, `Community 117`, `Community 122`, `Community 123`, `Community 124`, `Community 127`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Why does `AuthProvider` connect `Community 8` to `Community 5`, `Community 135`, `Community 136`, `Community 9`, `Community 12`, `Community 13`, `Community 18`, `Community 19`, `Community 20`, `Community 22`, `Community 23`, `Community 25`, `Community 26`, `Community 30`, `Community 31`, `Community 35`, `Community 38`, `Community 39`, `Community 43`, `Community 50`, `Community 51`, `Community 55`, `Community 56`, `Community 58`, `Community 60`, `Community 61`, `Community 64`, `Community 69`, `Community 82`, `Community 86`, `Community 93`, `Community 95`, `Community 112`, `Community 119`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `_` connect `Community 9` to `Community 5`, `Community 39`, `Community 8`, `Community 12`, `Community 13`, `Community 18`, `Community 19`, `Community 20`, `Community 118`, `Community 120`, `Community 26`, `Community 126`, `Community 31`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **What connects `Props`, `Pair`, `Props` to the rest of the system?**
  _3191 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.020186631117882308 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.013888888888888888 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.029670776317572145 - nodes in this community are weakly interconnected._