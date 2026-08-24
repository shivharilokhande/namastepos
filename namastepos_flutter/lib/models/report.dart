// NamastePOS - Aggregate report DTOs

class DailyReport {
  final DateTime date;
  final double dineInRevenue;
  final double takeawayRevenue;
  final double zomatoRevenue;
  final double swiggyRevenue;
  final double otherRevenue;

  final double ingredientsExpense;
  final double fuelExpense;
  final double laborExpense;
  final double rentExpense;
  final double utilitiesExpense;
  final double packagingExpense;
  final double otherExpense;

  final int orderCount;
  final List<TopItemSales> topItems;

  const DailyReport({
    required this.date,
    this.dineInRevenue = 0,
    this.takeawayRevenue = 0,
    this.zomatoRevenue = 0,
    this.swiggyRevenue = 0,
    this.otherRevenue = 0,
    this.ingredientsExpense = 0,
    this.fuelExpense = 0,
    this.laborExpense = 0,
    this.rentExpense = 0,
    this.utilitiesExpense = 0,
    this.packagingExpense = 0,
    this.otherExpense = 0,
    this.orderCount = 0,
    this.topItems = const [],
  });

  double get totalRevenue =>
      dineInRevenue + takeawayRevenue + zomatoRevenue + swiggyRevenue + otherRevenue;

  double get totalExpenses =>
      ingredientsExpense + fuelExpense + laborExpense + rentExpense +
      utilitiesExpense + packagingExpense + otherExpense;

  double get profit => totalRevenue - totalExpenses;

  double get marginPct =>
      totalRevenue == 0 ? 0 : (profit / totalRevenue) * 100;
}

class TopItemSales {
  final String itemId;
  final String name;
  final int qty;
  final double revenue;

  const TopItemSales({
    required this.itemId,
    required this.name,
    required this.qty,
    required this.revenue,
  });
}
