/// Ethiopian calendar presentation (JDN based). The API stores absolute UTC instants; this is display only.
class EthiopianDate {
  const EthiopianDate(this.year, this.month, this.day);
  final int year, month, day;

  static const monthsEn = ['Meskerem', 'Tikimt', 'Hidar', 'Tahsas', 'Tir', 'Yekatit', 'Megabit', 'Miazia', 'Ginbot', 'Sene', 'Hamle', 'Nehase', 'Pagume'];
  static const monthsAm = ['መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሣሥ', 'ጥር', 'የካቲት', 'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜን'];
  static const _jdnOffset = 1723856;

  static int _gToJdn(int y, int m, int d) {
    final a = (14 - m) ~/ 12;
    final yy = y + 4800 - a;
    final mm = m + 12 * a - 3;
    return d + (153 * mm + 2) ~/ 5 + 365 * yy + yy ~/ 4 - yy ~/ 100 + yy ~/ 400 - 32045;
  }

  static EthiopianDate fromGregorian(int y, int m, int d) {
    final jdn = _gToJdn(y, m, d);
    final r = (jdn - _jdnOffset) % 1461;
    final n = (r % 365) + 365 * (r ~/ 1460);
    final year = 4 * ((jdn - _jdnOffset) ~/ 1461) + r ~/ 365 - r ~/ 1460;
    return EthiopianDate(year, n ~/ 30 + 1, n % 30 + 1);
  }

  /// Local calendar date in Africa/Addis_Ababa (UTC+3, no DST) of an instant.
  static EthiopianDate fromInstant(DateTime instant) {
    final t = instant.toUtc().add(const Duration(hours: 3));
    return fromGregorian(t.year, t.month, t.day);
  }

  String format(String languageCode) => '$day ${(languageCode == 'am' ? monthsAm : monthsEn)[month - 1]} $year';

  @override
  bool operator ==(Object other) => other is EthiopianDate && other.year == year && other.month == month && other.day == day;
  @override
  int get hashCode => Object.hash(year, month, day);
  @override
  String toString() => '$year-$month-$day';
}
